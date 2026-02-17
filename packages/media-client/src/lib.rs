//! Client WASM crate: MediaPlayer struct for the main thread.
//! Creates the worker from URL, wires message handlers, exposes camelCase API for the composable.
//! Audio pipeline runs on main thread (AudioContext cannot be created in a worker).

mod audio;
mod listeners;
mod video;

use audio::AudioPlayer;
use js_sys::ArrayBuffer;
use std::cell::RefCell;
use std::rc::Rc;
use video::VideoPlayer;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::future_to_promise;
use web_sys::OffscreenCanvas;

/// Main-thread player: holds audio and video players plus current time.
/// Audio pipeline (AudioContext, decoder) runs here; worker only receives SET_AUDIO_BUFFERED_END.
/// Holds the derived secret key (32 bytes) after handshake. Buffers are decrypted internally; never exposed to JS.
#[wasm_bindgen]
pub struct MediaPlayer {
    video: VideoPlayer,
    audio: AudioPlayer,
    current_time: Rc<RefCell<f64>>,
    secret_key: Rc<RefCell<Option<[u8; 32]>>>,
}

impl Default for MediaPlayer {
    fn default() -> Self {
        Self {
            video: VideoPlayer::new(),
            audio: AudioPlayer::new(),
            current_time: Rc::new(RefCell::new(0.0)),
            secret_key: Rc::new(RefCell::new(None)),
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

    /// Send video init segment. Encrypted buffer is decrypted internally before transfer to worker.
    #[wasm_bindgen(js_name = "initVideo")]
    pub fn init_video(&self, buffer: &[u8]) -> Result<(), JsValue> {
        let decrypted = Self::decrypt_as_buffer(buffer, &self.secret_key)?;
        self.video.send_video_init(decrypted)
    }

    /// Send one video media segment. Encrypted buffer is decrypted internally before transfer to worker.
    #[wasm_bindgen(js_name = "feedVideoSegment")]
    pub fn feed_video_segment(&self, buffer: &[u8]) -> Result<(), JsValue> {
        let decrypted = Self::decrypt_as_buffer(buffer, &self.secret_key)?;
        self.video.send_video_segment(decrypted)
    }

    /// Initialize audio on main thread (AudioContext cannot be created in worker).
    /// Encrypted buffer is decrypted internally before parsing.
    #[wasm_bindgen(js_name = "initAudio")]
    pub fn init_audio(&self, buffer: &[u8]) -> Result<(), JsValue> {
        let decrypted = Self::decrypt(buffer, &self.secret_key)?;
        self.audio.init(&decrypted, self.current_time.clone())
    }

    /// Feed one audio media segment; decode and schedule on main thread, post SET_AUDIO_BUFFERED_END to worker.
    /// Encrypted buffer is decrypted internally.
    #[wasm_bindgen(js_name = "feedAudioSegment")]
    pub fn feed_audio_segment(&self, buffer: &[u8]) -> Result<(), JsValue> {
        let decrypted = Self::decrypt(buffer, &self.secret_key)?;
        self.audio.feed_segment(&decrypted)
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

    /// Decrypt sealed buffer; returns ArrayBuffer
    #[inline]
    fn decrypt_as_buffer(
        buffer: &[u8],
        secret_key: &Rc<RefCell<Option<[u8; 32]>>>,
    ) -> Result<ArrayBuffer, JsValue> {
        let key = secret_key
            .borrow()
            .ok_or_else(|| JsValue::from_str("handshake required"))?;
        let decrypted = media_core::secret::open_sealed_data(buffer, &key)
            .map_err(|e| JsValue::from(e.to_string()))?;
        Ok(js_sys::Uint8Array::from(decrypted.as_slice()).buffer())
    }

    /// Decrypt sealed buffer; returns Vec<u8>
    #[inline]
    fn decrypt(
        buffer: &[u8],
        secret_key: &Rc<RefCell<Option<[u8; 32]>>>,
    ) -> Result<Vec<u8>, JsValue> {
        let key = secret_key
            .borrow()
            .ok_or_else(|| JsValue::from_str("handshake required"))?;
        let decrypted = media_core::secret::open_sealed_data(buffer, &key)
            .map_err(|e| JsValue::from(e.to_string()))?;
        Ok(decrypted)
    }

    /// Handshake: GET /media/init (salt binary), GET /media/session (sessionId),
    /// derive key, store only the key, discard sessionId and salt.
    #[wasm_bindgen(js_name = "handshake")]
    pub fn handshake(&self, base_url: &str) -> js_sys::Promise {
        let base = base_url.trim_end_matches('/').to_string();
        let secret_key = Rc::clone(&self.secret_key);
        future_to_promise(async move {
            let client = reqwest::Client::new();
            let init_url = format!("{}/media/init", base);
            let session_url = format!("{}/media/session", base);
            let init_res = client
                .get(&init_url)
                .send()
                .await
                .map_err(|e| JsValue::from_str(&e.to_string()))?;
            if !init_res.status().is_success() {
                return Err(JsValue::from_str("handshake: /media/init failed"));
            }
            let salt = init_res
                .bytes()
                .await
                .map_err(|e| JsValue::from_str(&e.to_string()))?;
            let session_res = client
                .get(&session_url)
                .send()
                .await
                .map_err(|e| JsValue::from_str(&e.to_string()))?;
            if !session_res.status().is_success() {
                return Err(JsValue::from_str("handshake: /media/session failed"));
            }
            let session_id = session_res
                .text()
                .await
                .map_err(|e| JsValue::from_str(&e.to_string()))?;
            if session_id.is_empty() {
                return Err(JsValue::from_str(
                    "handshake: session invalid or already burned",
                ));
            }
            let key = media_core::secret::derive_key(session_id.as_bytes(), salt.as_ref())
                .map_err(|e| JsValue::from_str(&e.to_string()))?;
            *secret_key.borrow_mut() = Some(key);
            Ok(JsValue::undefined())
        })
    }

    /// Terminate the worker and clear state. Call when tearing down the player.
    #[wasm_bindgen(js_name = "terminate")]
    pub fn terminate(&self) {
        self.video.terminate();
    }
}
