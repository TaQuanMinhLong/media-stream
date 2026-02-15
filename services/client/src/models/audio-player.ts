import { decrypt } from "../crypto/decrypt";
import { parseAudioInit, parseAudioMedia } from "../parsers/fmp4-audio";

export class AudioPlayer {
  private context: AudioContext;
  private gainNode: GainNode;
  private getVideoTimeSec: () => number;
  private decoder: AudioDecoder | null = null;
  /** Track timescale parsed from the init segment (e.g. 44100). */
  private timescale = 44100;
  /** Queue of timeline start times (seconds) for each decoded chunk, in output order. */
  private scheduleQueue: number[] = [];
  /** All currently active (playing or scheduled) audio source nodes. */
  private activeSources: Set<AudioBufferSourceNode> = new Set();
  /** End time (seconds) of the last audio sample fed to the decoder. */
  public bufferedEndSec = 0;
  private decodeErrorLogged = false;
  private lastVolume = 1;

  /** Stored codec config so we can recreate the decoder on seek. */
  private lastCodecConfig: AudioDecoderConfig | null = null;

  /**
   * After seek, audio chunks before this time are skipped.
   * Set to -1 during normal playback so no chunks are dropped.
   * The old approach (comparing against videoTime) killed valid chunks
   * during normal playback because async decoder latency often exceeds 100ms.
   */
  private seekTime = -1;

  constructor(getVideoTimeSec: () => number) {
    this.context = new AudioContext();
    this.gainNode = this.context.createGain();
    this.gainNode.connect(this.context.destination);
    this.getVideoTimeSec = getVideoTimeSec;
  }

  /**
   * Configure from init segment (after decrypt). Uses fMP4 audio parser.
   * Never throws: failures are logged once and playback continues without audio.
   */
  public setConfiguration(initBuffer: ArrayBuffer): void {
    try {
      const result = parseAudioInit(initBuffer);
      if (!result) return;
      if (typeof AudioDecoder === "undefined") return;
      const { sampleRate, numberOfChannels, timescale } = result;
      this.timescale = timescale;
      const validRate = Number.isInteger(sampleRate) && sampleRate >= 8000 && sampleRate <= 192000;
      const validChans =
        Number.isInteger(numberOfChannels) && numberOfChannels >= 1 && numberOfChannels <= 8;
      if (!validRate || !validChans) {
        if (!this.decodeErrorLogged) {
          this.decodeErrorLogged = true;
          console.warn("AudioDecoder: invalid config (sampleRate or channels), skipping audio");
        }
        return;
      }
      this.decoder = new AudioDecoder({
        output: (data) => this.onAudioData(data),
        error: (e) => {
          if (!this.decodeErrorLogged) {
            this.decodeErrorLogged = true;
            console.warn("AudioDecoder error:", e);
          }
        },
      });
      this.lastCodecConfig = {
        codec: result.codec,
        sampleRate,
        numberOfChannels,
      };
      this.decoder.configure(this.lastCodecConfig);
    } catch (e) {
      if (!this.decodeErrorLogged) {
        this.decodeErrorLogged = true;
        console.warn("AudioDecoder not supported or config failed:", e);
      }
      this.decoder = null;
    }
  }

  private onAudioData(data: AudioData): void {
    const when = this.scheduleQueue.shift();
    if (when === undefined) {
      data.close();
      return;
    }
    try {
      const videoTime = this.getVideoTimeSec();
      // After seek, skip audio chunks from before the seek point.
      // The fetched segment often starts 1-2s before the seek time;
      // those chunks get startOffset=0 and play immediately → audible glitch.
      // We ONLY skip right after seek (seekTime >= 0); during normal playback
      // this is disabled so async decoder latency doesn't cause dropouts.
      if (this.seekTime >= 0 && when < this.seekTime - 0.05) {
        return; // data.close() is in finally
      }
      if (this.seekTime >= 0) {
        this.seekTime = -1; // First valid chunk arrived — resume normal mode
      }
      const startOffset = Math.max(0, when - videoTime);
      const buffer = this.context.createBuffer(
        data.numberOfChannels,
        data.numberOfFrames,
        data.sampleRate,
      );
      for (let i = 0; i < data.numberOfChannels; i++) {
        data.copyTo(buffer.getChannelData(i), { planeIndex: i });
      }
      const source = this.context.createBufferSource();
      source.buffer = buffer;
      source.connect(this.gainNode);

      // Track this source so we can stop it on seek/reset
      this.activeSources.add(source);
      source.onended = () => {
        this.activeSources.delete(source);
      };

      source.start(this.context.currentTime + startOffset);
    } finally {
      data.close();
    }
  }

  /** Stop and disconnect all currently playing/scheduled audio sources. */
  private stopAllSources(): void {
    for (const source of this.activeSources) {
      try {
        source.stop();
        source.disconnect();
      } catch (e) {
        console.error(`Source may already have ended, but error:`, e);
      }
    }
    this.activeSources.clear();
  }

  /**
   * Feed decrypted segment bytes. Decrypt is called internally (mock/WASM).
   * Audio scheduling uses absolute container timestamps (no segmentStartSec needed).
   */
  public async feedSegment(data: ArrayBuffer): Promise<void> {
    const decrypted = await decrypt(data);
    if (this.decoder?.state !== "configured") {
      return;
    }
    const result = parseAudioMedia(decrypted, this.timescale);
    if (!result) return;
    // Track actual audio buffered end from content timestamps
    const lastSample = result.samples[result.samples.length - 1];
    if (lastSample) {
      const endSec = (lastSample.timestampUs + lastSample.durationUs) / 1_000_000;
      if (endSec > this.bufferedEndSec) this.bufferedEndSec = endSec;
    }
    for (const sample of result.samples) {
      // Use absolute timestamp from the container for precise scheduling
      const timelineSec = sample.timestampUs / 1_000_000;
      this.scheduleQueue.push(timelineSec);
      const chunk = new EncodedAudioChunk({
        type: "key",
        timestamp: sample.timestampUs,
        duration: sample.durationUs,
        data: sample.data,
      });
      try {
        this.decoder.decode(chunk);
      } catch (e) {
        if (!this.decodeErrorLogged) {
          this.decodeErrorLogged = true;
          console.warn("Audio decode error:", e);
        }
        this.scheduleQueue.pop();
      }
    }
  }

  /** Reset audio state: disconnect gain, stop sources, recreate decoder, reconnect. */
  public seek(time = 0): void {
    this.seekTime = time;

    // Disconnect gain → stop sources (inaudible since disconnected)
    this.gainNode.disconnect();
    this.stopAllSources();
    this.scheduleQueue.length = 0;
    this.bufferedEndSec = time;

    // Fresh gain node for post-seek audio
    this.gainNode = this.context.createGain();
    this.gainNode.gain.value = this.lastVolume;
    this.gainNode.connect(this.context.destination);

    // Close and recreate the decoder for a guaranteed clean state.
    // flush() was unreliable and async; close+recreate is synchronous and safe.
    try { this.decoder?.close(); } catch { /* already closed */ }
    if (this.lastCodecConfig) {
      this.decoder = new AudioDecoder({
        output: (data) => this.onAudioData(data),
        error: (e) => {
          if (!this.decodeErrorLogged) {
            this.decodeErrorLogged = true;
            console.warn("AudioDecoder error:", e);
          }
        },
      });
      this.decoder.configure(this.lastCodecConfig);
    }

    // Suspend until play() is called
    this.context.suspend();
  }

  public setVolume(val: number): void {
    this.lastVolume = val;
    this.gainNode.gain.value = val;
  }

  public setMuted(muted: boolean): void {
    this.gainNode.gain.value = muted ? 0 : this.lastVolume;
  }

  public play(): void {
    if (this.context.state === "suspended") this.context.resume();
  }

  public pause(): void {
    // Only suspend the AudioContext — this freezes all playing and scheduled
    // sources in-place.  When resumed, they continue from exactly where they
    // were.  We do NOT call stopAllSources() here because that permanently
    // destroys audio buffers. stopAllSources() is reserved for seek(), where
    // we are jumping to a different position and need to discard old audio.
    this.context.suspend();
  }

  public close(): void {
    this.stopAllSources();
    this.decoder?.close();
    this.context.close();
  }
}
