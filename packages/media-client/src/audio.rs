use std::cell::RefCell;
use std::rc::Rc;

use media_core::{parse_audio_init, parse_audio_media};
use wasm_bindgen::JsCast;
use wasm_bindgen::prelude::*;
use web_sys::{
    AudioBufferSourceNode, AudioContext, AudioData, AudioDataCopyToOptions, AudioDecoder,
    AudioDecoderConfig, AudioDecoderInit, CodecState, EncodedAudioChunk, EncodedAudioChunkInit,
    EncodedAudioChunkType, GainNode,
};

use crate::video::VideoPlayer;

/// Main-thread audio player: AudioContext, decoder, scheduling state.
pub(crate) struct AudioPlayer {
    audio_ctx: RefCell<Option<AudioContext>>,
    gain_node: RefCell<Option<GainNode>>,
    audio_decoder: RefCell<Option<AudioDecoder>>,
    schedule_queue: RefCell<Option<Rc<RefCell<Vec<f64>>>>>,
    active_sources: RefCell<Option<Rc<RefCell<Vec<AudioBufferSourceNode>>>>>,
    audio_timescale: RefCell<u32>,
    last_audio_config: RefCell<Option<AudioDecoderConfig>>,
    /// After seek, audio chunks before this time (seconds) are skipped once.
    seek_time: Rc<RefCell<f64>>,
    last_volume: RefCell<f64>,
    /// Anchor-based scheduling: AudioContext time at the anchor point.
    /// Set to -1.0 to signal that the next decoded chunk should re-anchor.
    anchor_ctx: Rc<RefCell<f64>>,
    /// Anchor-based scheduling: timeline (when) time at the anchor point.
    anchor_when: Rc<RefCell<f64>>,
}

impl AudioPlayer {
    pub(crate) fn new() -> Self {
        Self {
            audio_ctx: RefCell::new(None),
            gain_node: RefCell::new(None),
            audio_decoder: RefCell::new(None),
            schedule_queue: RefCell::new(None),
            active_sources: RefCell::new(None),
            audio_timescale: RefCell::new(44100),
            last_audio_config: RefCell::new(None),
            seek_time: Rc::new(RefCell::new(-1.0)),
            last_volume: RefCell::new(1.0),
            anchor_ctx: Rc::new(RefCell::new(-1.0)),
            anchor_when: Rc::new(RefCell::new(-1.0)),
        }
    }

    pub(crate) fn init(
        &self,
        buffer: JsValue,
        current_time: Rc<RefCell<f64>>,
    ) -> Result<(), JsValue> {
        let buffer = buffer
            .dyn_into::<js_sys::ArrayBuffer>()
            .map_err(|_| JsValue::from_str("initAudio: expected ArrayBuffer"))?;
        let len = buffer.byte_length() as usize;
        let arr = js_sys::Uint8Array::new(&buffer);
        let mut bytes = vec![0u8; len];
        arr.copy_to(&mut bytes[..]);
        let init_result = match parse_audio_init(&bytes) {
            Some(r) => r,
            None => return Err(JsValue::from_str("initAudio: parse failed")),
        };
        let sample_rate = init_result.sample_rate;
        let channels = init_result.number_of_channels;
        if !(8000..=192000).contains(&sample_rate) || !(1..=8).contains(&channels) {
            return Err(JsValue::from_str(
                "initAudio: invalid sample_rate or channels",
            ));
        }
        let ctx = AudioContext::new()?;
        let gain = ctx.create_gain()?;
        gain.gain().set_value(*self.last_volume.borrow() as f32);
        gain.connect_with_audio_node(ctx.destination().as_ref())?;
        let schedule: Rc<RefCell<Vec<f64>>> = Rc::new(RefCell::new(Vec::new()));
        let sources: Rc<RefCell<Vec<AudioBufferSourceNode>>> = Rc::new(RefCell::new(Vec::new()));
        let current_time = Rc::clone(&current_time);
        let seek_time = Rc::clone(&self.seek_time);
        let gain_cb = gain.clone();
        let ctx_cb = ctx.clone();
        let schedule_cb = Rc::clone(&schedule);
        let sources_cb = Rc::clone(&sources);
        // Anchor-based scheduling: clone Rc handles so the output closure and
        // seek() share the same state.  Reset to -1 on seek.
        let anchor_ctx_cb = Rc::clone(&self.anchor_ctx);
        let anchor_when_cb = Rc::clone(&self.anchor_when);
        let output = Closure::wrap(Box::new(move |data: AudioData| {
            let when = schedule_cb.borrow_mut().drain(..1).next();
            let when = match when {
                Some(w) => w,
                None => {
                    data.close();
                    return;
                }
            };
            // Seek gating: right after seek, drop chunks from before the seek point
            // to avoid audible glitches from pre-seek audio.
            {
                let mut s = seek_time.borrow_mut();
                if *s >= 0.0 && when < *s - 0.05 {
                    data.close();
                    return;
                }
                if *s >= 0.0 {
                    // First valid post-seek chunk arrived — resume normal mode.
                    *s = -1.0;
                }
            }

            // Anchor-based scheduling: use video_sec only to establish the
            // initial anchor point.  For subsequent chunks, compute the
            // schedule time purely from the anchor + timeline offset.
            // This avoids the backward-scheduling caused by discrete
            // video_sec jumps between decoder output callbacks.
            let a_ctx = *anchor_ctx_cb.borrow();
            let a_when = *anchor_when_cb.borrow();
            let scheduled_at = if a_ctx < 0.0 {
                // First chunk after init / seek → establish anchor from video_sec.
                let video_sec = *current_time.borrow();
                let start_offset = (when - video_sec).max(0.0);
                let t = ctx_cb.current_time() + start_offset;
                *anchor_ctx_cb.borrow_mut() = t;
                *anchor_when_cb.borrow_mut() = when;
                t
            } else {
                // Subsequent chunks → relative offset from anchor (immune to video_sec jumps).
                let t = a_ctx + (when - a_when);
                // Never schedule in the past.
                t.max(ctx_cb.current_time())
            };

            let nch = data.number_of_channels();
            let nframes = data.number_of_frames();
            let sr = data.sample_rate();
            let buf = match ctx_cb.create_buffer(nch, nframes, sr) {
                Ok(b) => b,
                Err(_) => {
                    data.close();
                    return;
                }
            };

            // Copy decoded PCM per-channel via a Float32Array intermediate,
            // mirroring the TS: data.copyTo(buffer.getChannelData(i), {planeIndex: i}).
            // AudioBuffer is NOT a BufferSource, so we must use a typed array.
            let mut f32_buf = vec![0f32; nframes as usize];
            for i in 0..nch {
                let opts = AudioDataCopyToOptions::new(i);
                let float32 = js_sys::Float32Array::new_with_length(nframes);
                if data
                    .copy_to_with_buffer_source(float32.unchecked_ref(), &opts)
                    .is_err()
                {
                    data.close();
                    return;
                }
                float32.copy_to(&mut f32_buf[..]);
                let _ = buf.copy_to_channel(&f32_buf, i as i32);
            }

            let source = match ctx_cb.create_buffer_source() {
                Ok(s) => s,
                Err(_) => {
                    data.close();
                    return;
                }
            };
            let _ = source.set_buffer(Some(&buf));
            let _ = source.connect_with_audio_node(gain_cb.as_ref());
            if let Ok(mut v) = sources_cb.try_borrow_mut() {
                v.push(source.clone());
            }
            let onended = Closure::wrap(Box::new(|| {}) as Box<dyn FnMut()>);
            let _ =
                source.add_event_listener_with_callback("ended", onended.as_ref().unchecked_ref());
            onended.forget();
            let _ = source.start_with_when(scheduled_at);
            data.close();
        }) as Box<dyn Fn(AudioData)>);
        let error_cb = Closure::wrap(Box::new(|| {}) as Box<dyn FnMut()>);
        let init_dec = AudioDecoderInit::new(
            error_cb.as_ref().unchecked_ref(),
            output.as_ref().unchecked_ref(),
        );
        let decoder = AudioDecoder::new(&init_dec)?;
        output.forget();
        error_cb.forget();
        let config = AudioDecoderConfig::new(&init_result.codec, channels as u32, sample_rate);
        decoder.configure(&config)?;
        *self.audio_ctx.borrow_mut() = Some(ctx.clone());
        *self.gain_node.borrow_mut() = Some(gain);
        *self.audio_decoder.borrow_mut() = Some(decoder);
        *self.schedule_queue.borrow_mut() = Some(Rc::clone(&schedule));
        *self.active_sources.borrow_mut() = Some(Rc::clone(&sources));
        *self.audio_timescale.borrow_mut() = init_result.timescale;
        *self.last_audio_config.borrow_mut() = Some(config);
        let _ = ctx.suspend();
        Ok(())
    }

    pub(crate) fn feed_segment(&self, buffer: JsValue, video: &VideoPlayer) -> Result<(), JsValue> {
        let buffer = buffer
            .dyn_into::<js_sys::ArrayBuffer>()
            .map_err(|_| JsValue::from_str("feedAudioSegment: expected ArrayBuffer"))?;
        let len = buffer.byte_length() as usize;
        let arr = js_sys::Uint8Array::new(&buffer);
        let mut bytes = vec![0u8; len];
        arr.copy_to(&mut bytes[..]);
        let timescale = *self.audio_timescale.borrow();
        let media_result = match parse_audio_media(&bytes, timescale) {
            Some(r) => r,
            None => return Ok(()),
        };
        if let Some(last) = media_result.samples.last() {
            let end_sec = (last.timestamp_us + last.duration_us) as f64 / 1_000_000.0;
            video.send_audio_buffered_end(end_sec);
        }
        let schedule_rc = match self.schedule_queue.borrow().as_ref() {
            Some(r) => Rc::clone(r),
            None => return Ok(()),
        };
        let decoder = match self.audio_decoder.borrow().as_ref() {
            Some(d) => d.clone(),
            None => return Ok(()),
        };
        if decoder.state() != CodecState::Configured {
            return Ok(());
        }
        {
            let mut schedule = schedule_rc.borrow_mut();
            for sample in &media_result.samples {
                let timeline_sec = sample.timestamp_us as f64 / 1_000_000.0;
                schedule.push(timeline_sec);
            }
        }
        for sample in media_result.samples {
            let data_arr = js_sys::Uint8Array::new_with_length(sample.data.len() as u32);
            data_arr.copy_from(&sample.data[..]);
            let init = EncodedAudioChunkInit::new(
                data_arr.as_ref(),
                sample.timestamp_us as f64,
                EncodedAudioChunkType::Key,
            );
            init.set_duration(sample.duration_us as f64);
            let chunk = match EncodedAudioChunk::new(&init) {
                Ok(c) => c,
                Err(_) => break,
            };
            if decoder.decode(&chunk).is_err() {
                schedule_rc.borrow_mut().pop();
                break;
            }
        }
        Ok(())
    }

    /// Reset audio state on seek: stop all sources, clear schedule, reset decoder, and gate pre-seek chunks.
    pub(crate) fn seek(&self, time: f64) {
        // After seek, skip audio chunks from before this time (in onAudioData gate).
        *self.seek_time.borrow_mut() = time;

        // Reset anchor so the first post-seek chunk re-establishes it.
        *self.anchor_ctx.borrow_mut() = -1.0;
        *self.anchor_when.borrow_mut() = -1.0;

        // Stop and disconnect all currently playing/scheduled sources.
        if let Some(ref sources_rc) = *self.active_sources.borrow() {
            if let Ok(mut sources) = sources_rc.try_borrow_mut() {
                for source in sources.iter() {
                    #[allow(deprecated)]
                    let _ = source.stop();
                    let _ = source.disconnect();
                }
                sources.clear();
            }
        }

        // Clear scheduled timestamps so only post-seek media will be scheduled.
        if let Some(ref schedule_rc) = *self.schedule_queue.borrow() {
            if let Ok(mut schedule) = schedule_rc.try_borrow_mut() {
                schedule.clear();
            }
        }

        // Reset decoder to clear internal state from pre-seek chunks.
        // Without this, the decoder stops producing output after seek (confirmed by logs).
        // Mirrors the TS AudioPlayer which close+recreates the decoder on seek.
        if let Some(ref decoder) = *self.audio_decoder.borrow() {
            let _ = js_sys::Reflect::apply(
                &js_sys::Reflect::get(decoder.as_ref(), &JsValue::from_str("reset"))
                    .unwrap_or(JsValue::UNDEFINED)
                    .dyn_into::<js_sys::Function>()
                    .unwrap_or_else(|_| js_sys::Function::new_no_args("")),
                decoder.as_ref(),
                &js_sys::Array::new(),
            );
            if let Some(ref config) = *self.last_audio_config.borrow() {
                let _ = decoder.configure(config);
            }
        }

        // NOTE: We deliberately do NOT disconnect/recreate the gain node here.
        // The output closure captures a clone of the original gain node (gain_cb).
        // If we disconnect it, post-seek audio would connect to a dead node.
        // Stopping all sources above is sufficient to prevent glitches.

        // Suspend until play() is called again to resume audio.
        if let Some(ref ctx) = *self.audio_ctx.borrow() {
            let _ = ctx.suspend();
        }
    }

    pub(crate) fn play(&self) {
        if let Some(ref ctx) = *self.audio_ctx.borrow() {
            let _ = ctx.resume();
        }
    }

    pub(crate) fn pause(&self) {
        if let Some(ref ctx) = *self.audio_ctx.borrow() {
            let _ = ctx.suspend();
        }
    }

    pub(crate) fn set_volume(&self, volume: f64) {
        let v = volume.clamp(0.0, 1.0);
        *self.last_volume.borrow_mut() = v;
        if let Some(ref gain) = *self.gain_node.borrow() {
            gain.gain().set_value(v as f32);
        }
    }

    pub(crate) fn set_muted(&self, muted: bool) {
        let vol = if muted {
            0.0
        } else {
            *self.last_volume.borrow()
        };
        if let Some(ref gain) = *self.gain_node.borrow() {
            gain.gain().set_value(vol as f32);
        }
    }
}
