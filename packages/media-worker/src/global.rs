use wasm_bindgen::{JsCast, JsValue};

#[inline]
fn worker_global() -> Option<web_sys::DedicatedWorkerGlobalScope> {
    js_sys::global()
        .dyn_into::<web_sys::DedicatedWorkerGlobalScope>()
        .ok()
}

#[inline]
pub fn performance() -> Option<web_sys::Performance> {
    worker_global().and_then(|g| g.performance())
}

#[inline]
pub fn post_message(value: &JsValue) {
    match worker_global() {
        Some(g) => {
            g.post_message(value).ok();
        }
        None => {
            web_sys::console::error_1(&JsValue::from_str("Worker global not found"));
        }
    }
}
