//! Media worker: WebGPU + VideoDecoder + render on OffscreenCanvas.
//! MediaWorker is a class with internal state; JS creates GPU and passes device/context/pipeline/sampler.
//! JS runs the message loop and calls media_worker.handle_message(data).

mod global;
mod message;

use media_core::{VideoSample, parse_video_init, parse_video_media};
use message::*;
use std::cell::RefCell;
use std::rc::Rc;
use wasm_bindgen::JsCast;
use wasm_bindgen::prelude::*;
use web_sys::{
    CodecState, EncodedVideoChunk, EncodedVideoChunkInit, EncodedVideoChunkType,
    GpuBindGroupDescriptor, GpuBindGroupEntry, GpuCanvasContext, GpuDevice,
    GpuExternalTextureDescriptor, GpuLoadOp, GpuRenderPassColorAttachment, GpuRenderPassDescriptor,
    GpuRenderPipeline, GpuSampler, GpuStoreOp, VideoDecoder, VideoDecoderConfig, VideoDecoderInit,
    VideoFrame,
};

const STATE_UPDATE_INTERVAL: u32 = 4;
const MAX_FRAME_QUEUE: usize = 30;
const HIGH_WATER_DECODE: u32 = 60;

/// Playback state (clock, playing, buffered end).
struct WorkerState {
    current_time: f64,
    is_playing: bool,
    buffered_end: f64,
    start_time: f64,
    playhead_offset: f64,
    tick_count: u32,
}

impl Default for WorkerState {
    #[inline]
    fn default() -> Self {
        let now = global::performance()
            .map(|p| p.now() / 1000.0)
            .unwrap_or(0.0);
        Self {
            current_time: 0.0,
            is_playing: false,
            buffered_end: 0.0,
            start_time: now,
            playhead_offset: 0.0,
            tick_count: 0,
        }
    }
}

/// GPU state passed from JS (device, context, pipeline, sampler).
struct GpuState {
    device: GpuDevice,
    context: GpuCanvasContext,
    pipeline: GpuRenderPipeline,
    sampler: GpuSampler,
}

/// Frame queue shared with decoder output callback.
type FrameQueue = Rc<RefCell<Vec<(VideoFrame, f64)>>>;

/// Media worker: holds all video state; GPU is passed from JS via init_with_gpu.
/// Audio pipeline runs on the main thread; the worker does not track audio buffering
/// and only reports video buffered state.
#[wasm_bindgen]
pub struct MediaWorker {
    state: WorkerState,
    gpu: Option<GpuState>,
    decoder: Option<VideoDecoder>,
    timescale: u32,
    last_codec_config: Option<VideoDecoderConfig>,
    seek_target_us: i64,
    frame_queue: Option<FrameQueue>,
    display_frame: Option<VideoFrame>,
    pending_samples: Vec<VideoSample>,
}

impl Default for MediaWorker {
    #[inline]
    fn default() -> Self {
        Self {
            state: WorkerState::default(),
            gpu: None,
            decoder: None,
            timescale: 12800,
            last_codec_config: None,
            seek_target_us: -1,
            frame_queue: None,
            display_frame: None,
            pending_samples: Vec::new(),
        }
    }
}

#[wasm_bindgen]
impl MediaWorker {
    #[wasm_bindgen(constructor)]
    pub fn new() -> MediaWorker {
        Self::default()
    }

    /// Initialize with GPU objects created in JS. Call after JS has set up device, context, pipeline, sampler.
    /// Posts READY to the main thread.
    #[wasm_bindgen(js_name = initWithGpu)]
    pub fn init_with_gpu(
        &mut self,
        device: GpuDevice,
        context: GpuCanvasContext,
        pipeline: GpuRenderPipeline,
        sampler: GpuSampler,
    ) {
        self.gpu = Some(GpuState {
            device,
            context,
            pipeline,
            sampler,
        });
        let obj = js_sys::Object::new();
        js_sys::Reflect::set(
            &obj,
            &JsValue::from_str("type"),
            &JsValue::from_str("READY"),
        )
        .ok();
        global::post_message(&obj);
        post_state_update(
            self.state.current_time,
            self.state.is_playing,
            self.state.buffered_end,
            false,
        );
    }

    /// Handle a message from the main thread. Dispatch by message.type.
    /// Handles: TICK, PLAY, PAUSE, SEEK, INIT_VIDEO, FEED_VIDEO_SEGMENT.
    #[wasm_bindgen(js_name = handleMessage)]
    pub fn handle_message(&mut self, data: JsValue) {
        let msg_type = match get_message_type(&data) {
            Some(t) => t,
            None => return,
        };
        match msg_type.as_str() {
            "TICK" => self.tick(),
            "PLAY" => self.play(),
            "PAUSE" => self.pause(),
            "SEEK" => {
                let time = parse_seek_time(&data);
                self.seek(time);
            }
            "INIT_VIDEO" => self.init_video(&data),
            "FEED_VIDEO_SEGMENT" => self.feed_segment(&data),
            _ => {}
        }
    }

    #[inline]
    fn tick(&mut self) {
        let now = match global::performance() {
            Some(p) => p.now() / 1000.0,
            None => return,
        };
        if self.state.is_playing {
            self.state.current_time = self.state.playhead_offset + (now - self.state.start_time);
        }
        self.state.tick_count += 1;
        let do_post = self.state.tick_count >= STATE_UPDATE_INTERVAL;
        if do_post {
            self.state.tick_count = 0;
        }
        // Keep feeding decoder when it has room (matches TS dequeue listener).
        self.drain_pending_samples();
        self.drain_frame_for_display();
        let is_buffering =
            self.state.is_playing && self.state.buffered_end <= self.state.current_time;
        if do_post {
            post_state_update(
                self.state.current_time,
                self.state.is_playing,
                self.state.buffered_end,
                is_buffering,
            );
        }
    }

    #[inline]
    fn play(&mut self) {
        let now = match global::performance() {
            Some(p) => p.now() / 1000.0,
            None => return,
        };
        self.state.is_playing = true;
        self.state.start_time = now;
        self.state.playhead_offset = self.state.current_time;
    }

    #[inline]
    fn pause(&mut self) {
        self.state.is_playing = false;
        self.state.playhead_offset = self.state.current_time;
    }

    #[inline]
    fn clear_frame_queue(&mut self) {
        if let Some(ref rc) = self.frame_queue {
            let mut queue = rc.borrow_mut();
            for (frame, _) in queue.drain(..) {
                frame.close();
            }
        }
    }

    #[inline]
    fn seek(&mut self, time: f64) {
        self.state.current_time = time;
        self.state.playhead_offset = time;
        self.seek_target_us = (time * 1_000_000.0) as i64;
        self.pending_samples.clear();
        self.state.buffered_end = time;
        self.clear_frame_queue();
        if let Some(ref dec) = self.decoder {
            let _ = dec.reset();
        }
        if let Some(old) = self.display_frame.take() {
            old.close();
        }
        if let (Some(dec), Some(config)) = (self.decoder.as_ref(), self.last_codec_config.as_ref())
        {
            let _ = dec.configure(config);
        }
    }

    #[inline]
    fn init_video(&mut self, data: &JsValue) {
        let bytes = match extract_array_buffer_bytes(data, "buffer") {
            Some(b) => b,
            None => return,
        };
        let init_result = match parse_video_init(&bytes) {
            Some(r) => r,
            None => return,
        };
        self.timescale = init_result.timescale;

        let (config, queue) = match Self::build_decoder_config_and_queue(init_result) {
            Some(v) => v,
            None => return,
        };

        self.clear_frame_queue();
        self.frame_queue = Some(Rc::clone(&queue));

        let (decoder, config) = match Self::create_and_configure_decoder(config, queue) {
            Some(dc) => dc,
            None => return,
        };

        self.decoder = Some(decoder);
        self.last_codec_config = Some(config);
    }

    #[inline]
    fn feed_segment(&mut self, data: &JsValue) {
        let raw_bytes = match extract_array_buffer_bytes(data, "buffer") {
            Some(b) => b,
            None => return,
        };

        let media_result = match parse_video_media(&raw_bytes, self.timescale) {
            Some(r) => r,
            None => return,
        };
        Self::update_buffered_end_from_media(&mut self.state, &media_result);
        self.pending_samples.extend(media_result.samples);
        self.drain_pending_samples();
    }

    fn drain_pending_samples(&mut self) {
        let decoder = match &self.decoder {
            Some(d) => d,
            None => return,
        };
        if decoder.state() != CodecState::Configured {
            return;
        }
        while !self.pending_samples.is_empty() && decoder.decode_queue_size() < HIGH_WATER_DECODE {
            let sample = self.pending_samples.remove(0);
            let data = js_sys::Uint8Array::new_with_length(sample.data.len() as u32);
            data.copy_from(&sample.data);
            let chunk_type = if sample.is_key {
                EncodedVideoChunkType::Key
            } else {
                EncodedVideoChunkType::Delta
            };
            let init =
                EncodedVideoChunkInit::new(data.as_ref(), sample.timestamp_us as f64, chunk_type);
            init.set_duration(sample.duration_us as f64);
            let chunk = match EncodedVideoChunk::new(&init) {
                Ok(c) => c,
                Err(_) => break,
            };
            if decoder.decode(&chunk).is_err() {
                break;
            }
        }
    }

    fn drain_frame_for_display(&mut self) {
        let current_time_us = self.state.current_time * 1_000_000.0;
        let queue_rc = match &self.frame_queue {
            Some(rc) => Rc::clone(rc),
            None => return,
        };
        let mut queue = queue_rc.borrow_mut();
        let mut best: Option<(VideoFrame, f64)> = None;
        let mut drained = 0u32;
        while drained < 16
            && !queue.is_empty()
            && queue
                .first()
                .map(|(_, ts)| *ts <= current_time_us)
                .unwrap_or(false)
        {
            if let Some(b) = best.take() {
                b.0.close();
            }
            best = queue.drain(..1).next();
            drained += 1;
        }
        if let Some((frame, ts_us)) = best {
            if self.seek_target_us >= 0 {
                if ts_us < (self.seek_target_us as f64) - 200_000.0 {
                    frame.close();
                    return;
                }
                self.seek_target_us = -1;
            }
            if let Some(old) = self.display_frame.take() {
                old.close();
            }
            self.display_frame = Some(frame);
        }
        if let Some(ref frame) = self.display_frame {
            self.render_frame(frame);
        }
    }

    #[inline]
    fn render_frame(&self, frame: &VideoFrame) {
        let gpu = match &self.gpu {
            Some(g) => g,
            None => return,
        };

        let external = match import_external_texture(&gpu.device, frame) {
            Some(e) => e,
            None => return,
        };
        let bind_group = create_bind_group(&gpu.device, &gpu.pipeline, &gpu.sampler, &external);

        let (encoder, view) = match create_encoder_and_view(&gpu.device, &gpu.context) {
            Some(ev) => ev,
            None => return,
        };

        begin_and_submit_render_pass(&gpu.device, &gpu.pipeline, bind_group, encoder, &view);
    }
}

/// Extract bytes from a `buffer` field on a JS message object.
#[inline]
fn extract_array_buffer_bytes(data: &JsValue, field: &str) -> Option<Vec<u8>> {
    let buffer = js_sys::Reflect::get(data, &JsValue::from_str(field)).ok()?;
    let buffer = buffer.dyn_into::<js_sys::ArrayBuffer>().ok()?;
    let len = buffer.byte_length() as usize;
    let arr = js_sys::Uint8Array::new(&buffer);
    let mut bytes = vec![0u8; len];
    arr.copy_to(&mut bytes);
    Some(bytes)
}

impl MediaWorker {
    #[inline]
    fn build_decoder_config_and_queue(
        init_result: media_core::VideoInitResult,
    ) -> Option<(VideoDecoderConfig, FrameQueue)> {
        let codec = init_result.codec;
        let description = init_result.description;
        let desc_obj = js_sys::Uint8Array::new_with_length(description.len() as u32);
        desc_obj.copy_from(&description);
        let config = VideoDecoderConfig::new(&codec);
        config.set_description(desc_obj.as_ref());
        config.set_optimize_for_latency(true);

        let queue: FrameQueue = Rc::new(RefCell::new(Vec::new()));
        Some((config, queue))
    }

    #[inline]
    fn create_and_configure_decoder(
        config: VideoDecoderConfig,
        queue: FrameQueue,
    ) -> Option<(VideoDecoder, VideoDecoderConfig)> {
        let queue_clone = Rc::clone(&queue);
        let output = Closure::wrap(Box::new(move |frame: VideoFrame| {
            let timestamp_us = frame.timestamp().unwrap_or(0.0);
            let mut q = queue_clone.borrow_mut();
            if q.len() >= MAX_FRAME_QUEUE {
                let (old, _) = q.remove(0);
                old.close();
            }
            q.push((frame, timestamp_us));
            q.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
        }) as Box<dyn Fn(VideoFrame)>);
        let error_cb = Closure::wrap(Box::new(|| {}) as Box<dyn FnMut()>);
        let init_obj = VideoDecoderInit::new(
            error_cb.as_ref().unchecked_ref(),
            output.as_ref().unchecked_ref(),
        );
        let decoder = match VideoDecoder::new(&init_obj) {
            Ok(d) => d,
            Err(_) => return None,
        };
        output.forget();
        error_cb.forget();
        if decoder.configure(&config).is_err() {
            return None;
        }
        Some((decoder, config))
    }

    #[inline]
    fn update_buffered_end_from_media(
        state: &mut WorkerState,
        media_result: &media_core::VideoMediaResult,
    ) {
        if let Some(last) = media_result.samples.last() {
            let end_sec = (last.timestamp_us + last.duration_us) as f64 / 1_000_000.0;
            if end_sec > state.buffered_end {
                state.buffered_end = end_sec;
            }
        }
    }
}

/// Import an external texture for the given frame.
#[inline]
fn import_external_texture(
    device: &GpuDevice,
    frame: &VideoFrame,
) -> Option<web_sys::GpuExternalTexture> {
    let desc_obj = js_sys::Object::new();
    js_sys::Reflect::set(desc_obj.as_ref(), &JsValue::from_str("source"), frame).ok()?;
    let desc: GpuExternalTextureDescriptor = desc_obj.unchecked_into();
    device.import_external_texture(&desc).ok()
}

/// Create a bind group for rendering the external texture.
#[inline]
fn create_bind_group(
    device: &GpuDevice,
    pipeline: &GpuRenderPipeline,
    sampler: &GpuSampler,
    external: &web_sys::GpuExternalTexture,
) -> web_sys::GpuBindGroup {
    let layout = pipeline.get_bind_group_layout(0);
    let entry0 = GpuBindGroupEntry::new(0, external.as_ref());
    let entry1 = GpuBindGroupEntry::new(1, sampler.as_ref());
    let entries = js_sys::Array::of2(&entry0, &entry1);
    let bind_group_desc = GpuBindGroupDescriptor::new(&entries, &layout);
    device.create_bind_group(&bind_group_desc)
}

/// Create a command encoder and current texture view.
#[inline]
fn create_encoder_and_view(
    device: &GpuDevice,
    context: &GpuCanvasContext,
) -> Option<(web_sys::GpuCommandEncoder, web_sys::GpuTextureView)> {
    let encoder = device.create_command_encoder();
    let texture = context.get_current_texture().ok()?;
    let view = texture.create_view().ok()?;
    Some((encoder, view))
}

/// Begin a render pass, draw the quad, and submit the commands.
#[inline]
fn begin_and_submit_render_pass(
    device: &GpuDevice,
    pipeline: &GpuRenderPipeline,
    bind_group: web_sys::GpuBindGroup,
    encoder: web_sys::GpuCommandEncoder,
    view: &web_sys::GpuTextureView,
) {
    let color_attachment =
        GpuRenderPassColorAttachment::new(GpuLoadOp::Clear, GpuStoreOp::Store, view);
    let pass_desc = GpuRenderPassDescriptor::new(&js_sys::Array::of1(&color_attachment));
    let pass = match encoder.begin_render_pass(&pass_desc) {
        Ok(p) => p,
        Err(_) => return,
    };
    pass.set_pipeline(pipeline);
    pass.set_bind_group(0, Some(&bind_group));
    pass.draw(4);
    pass.end();
    device
        .queue()
        .submit(js_sys::Array::of1(&encoder.finish()).as_ref());
}

#[wasm_bindgen(start)]
pub fn init_worker() {
    console_error_panic_hook::set_once();
    let obj = js_sys::Object::new();
    js_sys::Reflect::set(
        &obj,
        &JsValue::from_str("type"),
        &JsValue::from_str("SCRIPT_READY"),
    )
    .ok();
    global::post_message(&obj);
}
