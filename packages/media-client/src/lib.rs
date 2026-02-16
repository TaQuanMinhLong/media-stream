//! Client WASM crate: MediaPlayer struct for the main thread.
//! Creates the worker from URL, wires message handlers, exposes camelCase API for the composable.
//! Audio pipeline runs on main thread (AudioContext cannot be created in a worker).

mod audio;
mod listeners;
mod video;

use audio::AudioPlayer;
use std::cell::RefCell;
use std::rc::Rc;
use video::VideoPlayer;
use wasm_bindgen::prelude::*;
use web_sys::OffscreenCanvas;

/// Main-thread player: holds audio and video players plus current time.
/// Audio pipeline (AudioContext, decoder) runs here; worker only receives SET_AUDIO_BUFFERED_END.
#[wasm_bindgen]
pub struct MediaPlayer {
    video: VideoPlayer,
    audio: AudioPlayer,
    current_time: Rc<RefCell<f64>>,
}

impl Default for MediaPlayer {
    fn default() -> Self {
        Self {
            video: VideoPlayer::new(),
            audio: AudioPlayer::new(),
            current_time: Rc::new(RefCell::new(0.0)),
        }
    }
}

#[wasm_bindgen]
impl MediaPlayer {
    /// Constructor for JS: `new MediaPlayer()`. Cannot implement Default (wasm_bindgen limitation).
    #[wasm_bindgen(constructor)]
    pub fn new() -> MediaPlayer {
        Self::default()
    }

    /// Set callback for state updates (currentTime, isPlaying, bufferedEnd, isBuffering).
    /// Called with a single object argument: `{ currentTime, isPlaying, bufferedEnd, isBuffering }`.
    #[wasm_bindgen(js_name = "setOnStateUpdate")]
    pub fn set_on_state_update(&self, callback: js_sys::Function) {
        self.video.listeners().set_on_state_update(callback);
    }

    /// Set callback for worker READY.
    #[wasm_bindgen(js_name = "setOnReady")]
    pub fn set_on_ready(&self, callback: js_sys::Function) {
        self.video.listeners().set_on_ready(callback);
    }

    /// Set callback for worker ERROR; called with message string.
    #[wasm_bindgen(js_name = "setOnError")]
    pub fn set_on_error(&self, callback: js_sys::Function) {
        self.video.listeners().set_on_error(callback);
    }

    /// Create the worker from the given script URL (e.g. from Vite worker&url).
    /// Sets up the message handler; call initCanvas(canvas) after this with the transferred canvas.
    #[wasm_bindgen(js_name = "initWorker")]
    pub fn init_worker(&self, worker_url: &str) -> Result<(), JsValue> {
        self.video
            .init_worker(worker_url, self.current_time.clone())
    }

    /// Queue canvas for transfer. INIT_CANVAS is sent when the worker signals SCRIPT_READY.
    #[wasm_bindgen(js_name = "initCanvas")]
    pub fn init_canvas(&self, canvas: OffscreenCanvas) {
        self.video.init_canvas(canvas)
    }

    /// Send TICK to the worker (call from requestAnimationFrame).
    #[wasm_bindgen(js_name = "tick")]
    pub fn tick(&self) {
        self.video.tick();
    }

    #[wasm_bindgen(js_name = "play")]
    pub fn play(&self) {
        self.audio.play();
        self.video.send_simple("PLAY");
    }

    #[wasm_bindgen(js_name = "pause")]
    pub fn pause(&self) {
        self.audio.pause();
        self.video.send_simple("PAUSE");
    }

    /// Seek to time in seconds.
    #[wasm_bindgen(js_name = "seek")]
    pub fn seek(&self, time: f64) {
        // Set current_time immediately so the audio output callback uses the
        // correct video position for scheduling. Without this, it races with
        // the worker's STATE_UPDATE and may schedule audio seconds into the future.
        *self.current_time.borrow_mut() = time;
        self.video.send_seek(time);
        self.audio.seek(time);
    }

    /// Send video init segment (buffer is transferred).
    #[wasm_bindgen(js_name = "initVideo")]
    pub fn init_video(&self, buffer: JsValue) -> Result<(), JsValue> {
        self.video.send_video_init(buffer)
    }

    /// Send one video media segment (buffer is transferred).
    #[wasm_bindgen(js_name = "feedVideoSegment")]
    pub fn feed_video_segment(&self, buffer: JsValue) -> Result<(), JsValue> {
        self.video.send_video_segment(buffer)
    }

    /// Initialize audio on main thread (AudioContext cannot be created in worker). Buffer is copied, not transferred.
    #[wasm_bindgen(js_name = "initAudio")]
    pub fn init_audio(&self, buffer: JsValue) -> Result<(), JsValue> {
        self.audio.init(buffer, self.current_time.clone())
    }

    /// Feed one audio media segment; decode and schedule on main thread, post SET_AUDIO_BUFFERED_END to worker.
    #[wasm_bindgen(js_name = "feedAudioSegment")]
    pub fn feed_audio_segment(&self, buffer: JsValue) -> Result<(), JsValue> {
        self.audio.feed_segment(buffer, &self.video)
    }

    /// Get the latest audio buffered end (seconds) from the main-thread audio pipeline.
    #[wasm_bindgen(js_name = "getAudioBufferedEnd")]
    pub fn get_audio_buffered_end(&self) -> f64 {
        self.audio.audio_buffered_end()
    }

    /// Set volume (0–1). Main-thread gain node.
    #[wasm_bindgen(js_name = "setVolume")]
    pub fn set_volume(&self, volume: f64) {
        self.audio.set_volume(volume.clamp(0.0, 1.0));
    }

    /// Mute or unmute audio.
    #[wasm_bindgen(js_name = "setMuted")]
    pub fn set_muted(&self, muted: bool) {
        self.audio.set_muted(muted);
    }

    /// Terminate the worker and clear state. Call when tearing down the player.
    #[wasm_bindgen(js_name = "terminate")]
    pub fn terminate(&self) {
        self.video.terminate();
    }
}
