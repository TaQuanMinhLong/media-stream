use wasm_bindgen::prelude::*;

use crate::global;

/// Post a STATE_UPDATE message to the main thread.
#[inline]
pub(crate) fn post_state_update(
    current_time: f64,
    is_playing: bool,
    buffered_end: f64,
    is_buffering: bool,
) {
    let obj = build_state_update_object(current_time, is_playing, buffered_end, is_buffering);
    global::post_message(&obj);
}

/// Build the JS object sent for STATE_UPDATE messages.
#[inline]
pub(crate) fn build_state_update_object(
    current_time: f64,
    is_playing: bool,
    buffered_end: f64,
    is_buffering: bool,
) -> JsValue {
    let obj = js_sys::Object::new();
    js_sys::Reflect::set(
        &obj,
        &JsValue::from_str("type"),
        &JsValue::from_str("STATE_UPDATE"),
    )
    .ok();
    js_sys::Reflect::set(
        &obj,
        &JsValue::from_str("currentTime"),
        &JsValue::from_f64(current_time),
    )
    .ok();
    js_sys::Reflect::set(
        &obj,
        &JsValue::from_str("isPlaying"),
        &JsValue::from_bool(is_playing),
    )
    .ok();
    js_sys::Reflect::set(
        &obj,
        &JsValue::from_str("bufferedEnd"),
        &JsValue::from_f64(buffered_end),
    )
    .ok();
    js_sys::Reflect::set(
        &obj,
        &JsValue::from_str("isBuffering"),
        &JsValue::from_bool(is_buffering),
    )
    .ok();
    obj.into()
}

/// Read the string message type from an incoming JS message.
#[inline]
pub(crate) fn get_message_type(data: &JsValue) -> Option<String> {
    js_sys::Reflect::get(data, &JsValue::from_str("type"))
        .ok()
        .and_then(|v| v.as_string())
}

/// Parse `time` from a SEEK message.
#[inline]
pub(crate) fn parse_seek_time(data: &JsValue) -> f64 {
    js_sys::Reflect::get(data, &JsValue::from_str("time"))
        .ok()
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0)
}
