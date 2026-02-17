use crate::listeners::Listeners;
use std::cell::RefCell;
use std::rc::Rc;
use wasm_bindgen::JsCast;
use wasm_bindgen::prelude::*;
use web_sys::{MessageEvent, OffscreenCanvas, Worker, WorkerOptions, WorkerType};

#[inline]
fn get_string(data: &JsValue, key: &str) -> String {
    js_sys::Reflect::get(data, &JsValue::from_str(key))
        .ok()
        .and_then(|v| v.as_string())
        .unwrap_or_default()
}

#[inline]
fn get_f64(data: &JsValue, key: &str) -> f64 {
    js_sys::Reflect::get(data, &JsValue::from_str(key))
        .ok()
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0)
}

#[inline]
fn get_bool(data: &JsValue, key: &str) -> bool {
    js_sys::Reflect::get(data, &JsValue::from_str(key))
        .ok()
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

/// Video-side state: worker, canvas, and callbacks.
pub(crate) struct VideoPlayer {
    pub(crate) worker: RefCell<Option<Worker>>,
    pending_canvas: Rc<RefCell<Option<OffscreenCanvas>>>,
    listeners: Listeners,
}

impl VideoPlayer {
    #[inline]
    pub(crate) fn new() -> Self {
        Self {
            worker: RefCell::new(None),
            pending_canvas: Rc::new(RefCell::new(None)),
            listeners: Listeners::new(),
        }
    }

    #[inline]
    pub(crate) fn listeners(&self) -> &Listeners {
        &self.listeners
    }

    pub(crate) fn init_worker(
        &self,
        worker_url: &str,
        current_time: Rc<RefCell<f64>>,
    ) -> Result<(), JsValue> {
        let options = WorkerOptions::new();
        options.set_type(WorkerType::Module);
        let worker = Worker::new_with_options(worker_url, &options)?;
        let worker_for_closure = worker.clone();
        let pending_canvas = Rc::clone(&self.pending_canvas);
        let on_state = Rc::clone(&self.listeners.on_state_update);
        let on_ready = Rc::clone(&self.listeners.on_ready);
        let on_error = Rc::clone(&self.listeners.on_error);

        let onmessage = Closure::wrap(Box::new(move |event: MessageEvent| {
            let data = event.data();
            let type_ = js_sys::Reflect::get(&data, &JsValue::from_str("type"))
                .ok()
                .and_then(|v| v.as_string())
                .unwrap_or_default();

            match type_.as_str() {
                "SCRIPT_READY" => {
                    VideoPlayer::handle_script_ready(&worker_for_closure, &pending_canvas);
                }
                "READY" => {
                    VideoPlayer::handle_ready(&on_ready);
                }
                "ERROR" => {
                    VideoPlayer::handle_error(&data, &on_error);
                }
                "STATE_UPDATE" => {
                    VideoPlayer::handle_state_update(&data, &current_time, &on_state);
                }
                _ => {}
            }
        }) as Box<dyn Fn(MessageEvent)>);
        worker.set_onmessage(Some(onmessage.as_ref().unchecked_ref()));
        onmessage.forget();

        *self.worker.borrow_mut() = Some(worker);
        Ok(())
    }

    #[inline]
    pub(crate) fn init_canvas(&self, canvas: OffscreenCanvas) {
        *self.pending_canvas.borrow_mut() = Some(canvas);
    }

    #[inline]
    pub(crate) fn tick(&self) {
        if let Some(ref w) = *self.worker.borrow() {
            let _ = Self::post_message(w, "TICK", &[]);
        }
    }

    #[inline]
    pub(crate) fn send_simple(&self, msg_type: &str) {
        if let Some(ref w) = *self.worker.borrow() {
            let _ = Self::post_message(w, msg_type, &[]);
        }
    }

    #[inline]
    pub(crate) fn send_seek(&self, time: f64) {
        if let Some(ref w) = *self.worker.borrow() {
            let fields = [("time", JsValue::from_f64(time))];
            let _ = Self::post_message(w, "SEEK", &fields);
        }
    }

    /// This requires ArrayBuffer to be transferred to the worker.
    #[inline]
    pub(crate) fn send_video_init(&self, buffer: js_sys::ArrayBuffer) -> Result<(), JsValue> {
        let worker = self.worker.borrow();
        let w = worker
            .as_ref()
            .ok_or_else(|| JsValue::from_str("Worker not initialized"))?;
        let transfer = js_sys::Array::of1(&buffer);
        let obj = Self::build_message_object("INIT_VIDEO", &[("buffer", buffer.into())]);
        w.post_message_with_transfer(&obj, &transfer)?;
        Ok(())
    }

    /// This requires ArrayBuffer to be transferred to the worker.
    #[inline]
    pub(crate) fn send_video_segment(&self, buffer: js_sys::ArrayBuffer) -> Result<(), JsValue> {
        let worker = self.worker.borrow();
        let w = worker
            .as_ref()
            .ok_or_else(|| JsValue::from_str("Worker not initialized"))?;
        let transfer = js_sys::Array::of1(&buffer);
        let obj = Self::build_message_object("FEED_VIDEO_SEGMENT", &[("buffer", buffer.into())]);
        w.post_message_with_transfer(&obj, &transfer)?;
        Ok(())
    }

    #[inline]
    pub(crate) fn terminate(&self) {
        if let Some(w) = self.worker.borrow_mut().take() {
            w.terminate();
        }
    }
}

impl VideoPlayer {
    #[inline]
    fn handle_script_ready(worker: &Worker, pending_canvas: &Rc<RefCell<Option<OffscreenCanvas>>>) {
        if let Some(canvas) = pending_canvas.borrow_mut().take() {
            let obj = js_sys::Object::new();
            js_sys::Reflect::set(
                &obj,
                &JsValue::from_str("type"),
                &JsValue::from_str("INIT_CANVAS"),
            )
            .ok();
            js_sys::Reflect::set(&obj, &JsValue::from_str("canvas"), &canvas).ok();
            let _ = worker.post_message_with_transfer(&obj, &js_sys::Array::of1(&canvas));
        }
    }

    #[inline]
    fn handle_ready(on_ready: &Rc<RefCell<Option<js_sys::Function>>>) {
        if let Some(ref f) = *on_ready.borrow() {
            let _ = f.call0(&JsValue::NULL);
        }
    }

    #[inline]
    fn handle_error(data: &JsValue, on_error: &Rc<RefCell<Option<js_sys::Function>>>) {
        let msg = get_string(data, "message");
        if let Some(ref f) = *on_error.borrow() {
            let _ = f.call1(&JsValue::NULL, &JsValue::from_str(&msg));
        }
    }

    #[inline]
    fn handle_state_update(
        data: &JsValue,
        current_time: &Rc<RefCell<f64>>,
        on_state: &Rc<RefCell<Option<js_sys::Function>>>,
    ) {
        *current_time.borrow_mut() = get_f64(data, "currentTime");
        if let Some(ref f) = *on_state.borrow() {
            let obj = Self::build_state_update_object(data);
            let _ = f.call1(&JsValue::NULL, &obj);
        }
    }

    #[inline]
    fn build_state_update_object(data: &JsValue) -> JsValue {
        let obj = js_sys::Object::new();
        js_sys::Reflect::set(
            &obj,
            &JsValue::from_str("currentTime"),
            &JsValue::from_f64(get_f64(data, "currentTime")),
        )
        .ok();
        js_sys::Reflect::set(
            &obj,
            &JsValue::from_str("isPlaying"),
            &JsValue::from_bool(get_bool(data, "isPlaying")),
        )
        .ok();
        js_sys::Reflect::set(
            &obj,
            &JsValue::from_str("bufferedEnd"),
            &JsValue::from_f64(get_f64(data, "bufferedEnd")),
        )
        .ok();
        js_sys::Reflect::set(
            &obj,
            &JsValue::from_str("isBuffering"),
            &JsValue::from_bool(get_bool(data, "isBuffering")),
        )
        .ok();
        obj.into()
    }

    /// Helper to construct a message object with a type and additional fields.
    #[inline]
    fn build_message_object(msg_type: &str, fields: &[(&str, JsValue)]) -> JsValue {
        let obj = js_sys::Object::new();
        let _ = js_sys::Reflect::set(
            &obj,
            &JsValue::from_str("type"),
            &JsValue::from_str(msg_type),
        );
        for (key, value) in fields {
            let _ = js_sys::Reflect::set(&obj, &JsValue::from_str(key), value);
        }
        obj.into()
    }

    /// Post a simple message to the worker with a `type` and additional fields.
    #[inline]
    fn post_message(
        worker: &Worker,
        msg_type: &str,
        fields: &[(&str, JsValue)],
    ) -> Result<(), JsValue> {
        let obj = Self::build_message_object(msg_type, fields);
        worker.post_message(&obj)
    }
}
