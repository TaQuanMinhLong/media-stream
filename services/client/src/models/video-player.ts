import type { VideoSample } from "../parsers/fmp4-video";
import { Fmp4VideoParser } from "../parsers/fmp4-video";

export type PlayerState = "loading" | "playing" | "paused" | "buffering";

interface QueuedFrame {
  frame: VideoFrame;
  timestampUs: number;
}

export class VideoPlayer {
  private decoder: VideoDecoder;
  private canvasContext: GPUCanvasContext;
  private device: GPUDevice;
  private pipeline: GPURenderPipeline;
  private sampler: GPUSampler;

  public state: PlayerState = "loading";
  public currentTime = 0;
  private startTime = 0;
  private playheadOffset = 0;

  /** Decoded frames waiting to be displayed (sorted by timestamp). */
  private frameQueue: QueuedFrame[] = [];
  private maxQueueSize = 30;

  /** Encoded samples waiting to be fed to the decoder (backpressure buffer). */
  private pendingSamples: VideoSample[] = [];

  /** End time (seconds) of the last sample fed to the decoder. */
  public bufferedEndSec = 0;

  /**
   * After seek, frames before this threshold are skipped (closed without rendering).
   * Prevents the visible "fast-forward" effect as frames trickle in from the decoder.
   * Set to -1 when not seeking.
   */
  private seekTargetUs = -1;

  /**
   * The frame currently on screen. Kept alive (not closed) so we can re-render it
   * every tick, which prevents black flashes on canvas resize / fullscreen toggle.
   * Closed only when replaced by a newer frame or on seek/destroy.
   */
  private displayFrame: VideoFrame | null = null;

  private decoderErrorLogged = false;
  private timescale = 12800;

  /** Stored codec config so we can recreate the decoder on seek. */
  private lastCodecConfig: VideoDecoderConfig | null = null;

  private readonly videoParser = new Fmp4VideoParser();

  constructor(
    device: GPUDevice,
    context: GPUCanvasContext,
    pipeline: GPURenderPipeline,
    sampler: GPUSampler,
  ) {
    this.device = device;
    this.canvasContext = context;
    this.pipeline = pipeline;
    this.sampler = sampler;

    this.decoder = new VideoDecoder({
      output: (frame) => this.onFrame(frame),
      error: (e) => {
        if (!this.decoderErrorLogged) {
          this.decoderErrorLogged = true;
          console.warn("VideoDecoder error (decoder may be closed):", e);
        }
      },
    });

    // When the decoder drains its queue, feed more pending samples
    this.decoder.addEventListener("dequeue", () => this.drainPending());
  }

  /**
   * Configure decoder from init segment (after decrypt). Uses fMP4 parser for avcC.
   * Never throws: failures are logged and playback stays unconfigured.
   */
  public setConfiguration(initBuffer: ArrayBuffer): void {
    try {
      const result = this.videoParser.parseInit(initBuffer);
      if (!result) return;
      this.timescale = result.timescale;
      this.lastCodecConfig = {
        codec: result.codec,
        description: result.description,
        optimizeForLatency: true,
      };
      this.decoder.configure(this.lastCodecConfig);
      if (this.state === "loading") this.state = "paused";
    } catch (e) {
      console.warn("VideoDecoder config failed:", e);
    }
  }

  /**
   * Feed a decrypted media segment. Parser splits into per-sample chunks.
   * Samples are queued internally and drained to the decoder respecting backpressure.
   * Never throws.
   */
  public feedSegment(mediaBuffer: ArrayBuffer): void {
    try {
      if (this.decoder.state !== "configured") return;
      const result = this.videoParser.parseMedia(mediaBuffer, this.timescale);
      if (!result) return;
      // Track actual buffered end time from the last sample
      const last = result.samples[result.samples.length - 1];
      if (last) {
        const endSec = (last.timestampUs + last.durationUs) / 1_000_000;
        if (endSec > this.bufferedEndSec) this.bufferedEndSec = endSec;
      }
      // Append all parsed samples to the pending buffer
      this.pendingSamples.push(...result.samples);
      // Immediately drain as many as the decoder can accept
      this.drainPending();
    } catch (e) {
      console.warn("Video feedSegment error:", e);
    }
  }

  /**
   * Feed pending samples to the decoder. Called after feedSegment and on the
   * decoder's "dequeue" event (fires when decodeQueueSize decreases).
   */
  private drainPending(): void {
    // Feed until the decode queue has enough work or we run out of samples.
    // A threshold of ~60 keeps the decoder busy without excessive memory use.
    const HIGH_WATER = 60;
    while (this.pendingSamples.length > 0 && this.decoder.state === "configured") {
      if (this.decoder.decodeQueueSize >= HIGH_WATER) break;
      const sample = this.pendingSamples.shift()!;
      try {
        const chunk = new EncodedVideoChunk({
          type: sample.isKey ? "key" : "delta",
          timestamp: sample.timestampUs,
          duration: sample.durationUs,
          data: sample.data,
        });
        this.decoder.decode(chunk);
      } catch {
        // Decoder may have closed between the check and the decode call
        break;
      }
    }
  }

  private onFrame(frame: VideoFrame): void {
    const timestampUs = frame.timestamp ?? 0;
    // If the queue is full, drop the oldest frame to make room
    while (this.frameQueue.length >= this.maxQueueSize) {
      const oldest = this.frameQueue.shift();
      oldest?.frame.close();
    }
    this.frameQueue.push({ frame, timestampUs });
    this.frameQueue.sort((a, b) => a.timestampUs - b.timestampUs);
  }

  /**
   * Render a VideoFrame to the canvas via WebGPU.
   * Does NOT close the frame — the caller (displayFrame) manages the lifetime.
   * importExternalTexture is called each tick to get a fresh binding.
   */
  private render(frame: VideoFrame): void {
    try {
      const externalTexture = this.device.importExternalTexture({ source: frame });
      const bindGroup = this.device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: externalTexture },
          { binding: 1, resource: this.sampler },
        ],
      });
      const commandEncoder = this.device.createCommandEncoder();
      const passEncoder = commandEncoder.beginRenderPass({
        colorAttachments: [
          {
            view: this.canvasContext.getCurrentTexture().createView(),
            loadOp: "clear",
            storeOp: "store",
            clearValue: [0, 0, 0, 1],
          },
        ],
      });
      passEncoder.setPipeline(this.pipeline);
      passEncoder.setBindGroup(0, bindGroup);
      passEncoder.draw(4);
      passEncoder.end();
      this.device.queue.submit([commandEncoder.finish()]);
    } catch (e) {
      console.warn("Video render error:", e);
    }
  }

  /**
   * Called every rAF: update clock, display frame with timestamp <= currentTime, render.
   */
  public tick(): number {
    this.updateClock();
    this.drainFrameForDisplay();
    return this.currentTime;
  }

  /**
   * Select the best frame for currentTime; update displayFrame; render only new frames.
   *
   * We only call render() when the displayFrame actually changes. When there's
   * no new frame, we skip getCurrentTexture() entirely — the canvas automatically
   * keeps presenting its last submitted frame. This prevents the black flashes
   * during fullscreen/resize transitions that happened when re-rendering every
   * tick (importExternalTexture on a kept-alive VideoFrame intermittently
   * produces an expired 0×0 texture during CSS transitions; the render pass's
   * loadOp:"clear" then wipes the canvas to black).
   */
  private drainFrameForDisplay(): void {
    const currentTimeUs = this.currentTime * 1_000_000;
    let best: QueuedFrame | null = null;
    const maxDrain = 16;
    let drained = 0;
    while (
      drained < maxDrain &&
      this.frameQueue.length > 0 &&
      this.frameQueue[0]!.timestampUs <= currentTimeUs
    ) {
      if (best) best.frame.close();
      best = this.frameQueue.shift() ?? null;
      drained++;
    }

    if (best) {
      // After seek, skip frames that are far before the seek target.
      // Prevents the visible "fast-forward" as frames trickle in from the decoder.
      if (this.seekTargetUs >= 0) {
        if (best.timestampUs < this.seekTargetUs - 200_000) {
          best.frame.close();
          return; // Don't update displayFrame or render
        }
        this.seekTargetUs = -1; // Caught up — resume normal rendering
      }
      // Replace the display frame and render the new one
      if (this.displayFrame) {
        try { this.displayFrame.close(); } catch { /* already closed */ }
      }
      this.displayFrame = best.frame;
      this.render(this.displayFrame);
    }
    // If no new frame: do nothing. The canvas keeps its last presented content.
  }

  public play(): void {
    this.state = "playing";
    this.startTime = performance.now();
    this.playheadOffset = this.currentTime;
  }

  public pause(): void {
    this.state = "paused";
    this.playheadOffset = this.currentTime;
  }

  public seek(time: number): void {
    this.currentTime = time;
    this.playheadOffset = time;
    this.seekTargetUs = time * 1_000_000;

    // Close the display frame so we don't keep rendering stale content
    if (this.displayFrame) {
      try { this.displayFrame.close(); } catch { /* already closed */ }
      this.displayFrame = null;
    }

    // Clear all queues
    this.pendingSamples.length = 0;
    this.bufferedEndSec = time;
    for (const { frame } of this.frameQueue) frame.close();
    this.frameQueue.length = 0;

    // Close and recreate the decoder for a guaranteed clean state.
    // flush() was unreliable: it outputs stale frames during the async wait,
    // and the internal H.264 state sometimes wasn't fully reset on backward seek.
    try { this.decoder.close(); } catch { /* already closed */ }
    this.decoder = new VideoDecoder({
      output: (frame) => this.onFrame(frame),
      error: (e) => {
        if (!this.decoderErrorLogged) {
          this.decoderErrorLogged = true;
          console.warn("VideoDecoder error:", e);
        }
      },
    });
    this.decoder.addEventListener("dequeue", () => this.drainPending());
    if (this.lastCodecConfig) {
      this.decoder.configure(this.lastCodecConfig);
    }
  }

  public updateClock(): number {
    if (this.state === "playing") {
      this.currentTime = this.playheadOffset + (performance.now() - this.startTime) / 1000;
    }
    return this.currentTime;
  }

  public get isBuffering(): boolean {
    return (
      this.state === "buffering" ||
      (this.state === "playing" && this.frameQueue.length === 0 && this.pendingSamples.length === 0)
    );
  }
}
