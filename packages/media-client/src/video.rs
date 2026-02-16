use std::cell::RefCell;
use std::rc::Rc;
use wasm_bindgen::JsCast;
use wasm_bindgen::prelude::*;
use web_sys::{MessageEvent, OffscreenCanvas, Worker, WorkerOptions, WorkerType};

use crate::listeners::Listeners;

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
                    if let Some(canvas) = pending_canvas.borrow_mut().take() {
                        let obj = js_sys::Object::new();
                        js_sys::Reflect::set(
                            &obj,
                            &JsValue::from_str("type"),
                            &JsValue::from_str("INIT_CANVAS"),
                        )
                        .ok();
                        js_sys::Reflect::set(&obj, &JsValue::from_str("canvas"), &canvas).ok();
                        let _ = worker_for_closure
                            .post_message_with_transfer(&obj, &js_sys::Array::of1(&canvas));
                    }
                }
                "READY" => {
                    if let Some(ref f) = *on_ready.borrow() {
                        let _ = f.call0(&JsValue::NULL);
                    }
                }
                "ERROR" => {
                    let msg = get_string(&data, "message");
                    if let Some(ref f) = *on_error.borrow() {
                        let _ = f.call1(&JsValue::NULL, &JsValue::from_str(&msg));
                    }
                }
                "STATE_UPDATE" => {
                    *current_time.borrow_mut() = get_f64(&data, "currentTime");
                    if let Some(ref f) = *on_state.borrow() {
                        let obj = js_sys::Object::new();
                        js_sys::Reflect::set(
                            &obj,
                            &JsValue::from_str("currentTime"),
                            &JsValue::from_f64(get_f64(&data, "currentTime")),
                        )
                        .ok();
                        js_sys::Reflect::set(
                            &obj,
                            &JsValue::from_str("isPlaying"),
                            &JsValue::from_bool(get_bool(&data, "isPlaying")),
                        )
                        .ok();
                        js_sys::Reflect::set(
                            &obj,
                            &JsValue::from_str("bufferedEnd"),
                            &JsValue::from_f64(get_f64(&data, "bufferedEnd")),
                        )
                        .ok();
                        js_sys::Reflect::set(
                            &obj,
                            &JsValue::from_str("audioBufferedEnd"),
                            &JsValue::from_f64(get_f64(&data, "audioBufferedEnd")),
                        )
                        .ok();
                        js_sys::Reflect::set(
                            &obj,
                            &JsValue::from_str("isBuffering"),
                            &JsValue::from_bool(get_bool(&data, "isBuffering")),
                        )
                        .ok();
                        let _ = f.call1(&JsValue::NULL, &obj);
                    }
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

    pub(crate) fn tick(&self) {
        if let Some(ref w) = *self.worker.borrow() {
            let obj = js_sys::Object::new();
            js_sys::Reflect::set(&obj, &JsValue::from_str("type"), &JsValue::from_str("TICK")).ok();
            let _ = w.post_message(&obj);
        }
    }

    pub(crate) fn send_simple(&self, msg_type: &str) {
        if let Some(ref w) = *self.worker.borrow() {
            let obj = js_sys::Object::new();
            js_sys::Reflect::set(
                &obj,
                &JsValue::from_str("type"),
                &JsValue::from_str(msg_type),
            )
            .ok();
            let _ = w.post_message(&obj);
        }
    }

    pub(crate) fn send_seek(&self, time: f64) {
        if let Some(ref w) = *self.worker.borrow() {
            let obj = js_sys::Object::new();
            js_sys::Reflect::set(&obj, &JsValue::from_str("type"), &JsValue::from_str("SEEK")).ok();
            js_sys::Reflect::set(&obj, &JsValue::from_str("time"), &JsValue::from_f64(time)).ok();
            let _ = w.post_message(&obj);
        }
    }

    pub(crate) fn send_video_init(&self, buffer: JsValue) -> Result<(), JsValue> {
        let worker = self.worker.borrow();
        let w = worker
            .as_ref()
            .ok_or_else(|| JsValue::from_str("Worker not initialized"))?;
        let obj = js_sys::Object::new();
        js_sys::Reflect::set(
            &obj,
            &JsValue::from_str("type"),
            &JsValue::from_str("INIT_VIDEO"),
        )
        .ok();
        js_sys::Reflect::set(&obj, &JsValue::from_str("buffer"), &buffer).ok();
        w.post_message_with_transfer(&obj, &js_sys::Array::of1(&buffer))?;
        Ok(())
    }

    pub(crate) fn send_video_segment(&self, buffer: JsValue) -> Result<(), JsValue> {
        let worker = self.worker.borrow();
        let w = worker
            .as_ref()
            .ok_or_else(|| JsValue::from_str("Worker not initialized"))?;
        let obj = js_sys::Object::new();
        js_sys::Reflect::set(
            &obj,
            &JsValue::from_str("type"),
            &JsValue::from_str("FEED_VIDEO_SEGMENT"),
        )
        .ok();
        js_sys::Reflect::set(&obj, &JsValue::from_str("buffer"), &buffer).ok();
        w.post_message_with_transfer(&obj, &js_sys::Array::of1(&buffer))?;
        Ok(())
    }

    pub(crate) fn send_audio_buffered_end(&self, value: f64) {
        if let Some(ref w) = *self.worker.borrow() {
            let obj = js_sys::Object::new();
            js_sys::Reflect::set(
                &obj,
                &JsValue::from_str("type"),
                &JsValue::from_str("SET_AUDIO_BUFFERED_END"),
            )
            .ok();
            js_sys::Reflect::set(&obj, &JsValue::from_str("value"), &JsValue::from_f64(value)).ok();
            let _ = w.post_message(&obj);
        }
    }

    pub(crate) fn terminate(&self) {
        if let Some(w) = self.worker.borrow_mut().take() {
            w.terminate();
        }
    }
}
