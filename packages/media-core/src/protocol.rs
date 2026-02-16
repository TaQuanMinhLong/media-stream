// //! Message protocol between main-thread client and worker.
// //! Single source of truth for wire format; matches media-worker.ts and composables/media-player.ts.
// //! Canvas and ArrayBuffers are transferred via postMessage transferables, not serialized here.
// //!
// //! Binary encoding uses [bincode 2](https://docs.rs/bincode/) (Encode/Decode); JSON (serde) remains
// //! available for debugging or JS interop.

// use bincode::{Decode, Encode};
// use serde::{Deserialize, Serialize};

// /// Encode an outgoing message to bytes (worker → main).
// #[inline]
// pub fn encode_out_message(msg: &OutMessage) -> Result<Vec<u8>, bincode::error::EncodeError> {
//     bincode::encode_to_vec(msg, bincode::config::standard())
// }

// /// Decode an outgoing message from bytes.
// #[inline]
// pub fn decode_out_message(bytes: &[u8]) -> Result<OutMessage, bincode::error::DecodeError> {
//     bincode::decode_from_slice(bytes, bincode::config::standard()).map(|(m, _)| m)
// }

// /// Encode an incoming message to bytes (main → worker).
// #[inline]
// pub fn encode_in_message(msg: &InMessage) -> Result<Vec<u8>, bincode::error::EncodeError> {
//     bincode::encode_to_vec(msg, bincode::config::standard())
// }

// /// Decode an incoming message from bytes.
// #[inline]
// pub fn decode_in_message(bytes: &[u8]) -> Result<InMessage, bincode::error::DecodeError> {
//     bincode::decode_from_slice(bytes, bincode::config::standard()).map(|(m, _)| m)
// }

// /// Messages from main thread to worker.
// #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Encode, Decode)]
// #[serde(tag = "type", rename_all = "SCREAMING_SNAKE_CASE")]
// pub enum InMessage {
//     /// Initialize WebGPU/OffscreenCanvas. Canvas is transferred; not in payload.
//     InitCanvas,
//     /// Video init segment (avcC). Buffer typically transferred.
//     InitVideo {
//         buffer: Vec<u8>,
//     },
//     /// One video media segment. Buffer typically transferred.
//     FeedVideoSegment {
//         buffer: Vec<u8>,
//     },
//     Play,
//     Pause,
//     Seek {
//         time: f64,
//     },
//     Tick,
// }

// /// Messages from worker to main thread.
// #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Encode, Decode)]
// #[serde(tag = "type", rename_all = "SCREAMING_SNAKE_CASE")]
// pub enum OutMessage {
//     #[serde(rename = "STATE_UPDATE")]
//     StateUpdate {
//         #[serde(rename = "currentTime")]
//         current_time: f64,
//         #[serde(rename = "isPlaying")]
//         is_playing: bool,
//         #[serde(rename = "bufferedEnd")]
//         buffered_end: f64,
//         #[serde(rename = "isBuffering")]
//         is_buffering: bool,
//     },
//     Ready,
//     Error {
//         message: String,
//     },
// }

// #[cfg(test)]
// mod tests {
//     use super::*;

//     #[test]
//     fn roundtrip_tick() {
//         let msg = InMessage::Tick;
//         let json = serde_json::to_string(&msg).expect("serialize InMessage");
//         assert!(json.contains("TICK"));
//         let back: InMessage = serde_json::from_str(&json).expect("deserialize InMessage");
//         assert_eq!(back, msg);
//     }

//     #[test]
//     fn roundtrip_state_update() {
//         let msg = OutMessage::StateUpdate {
//             current_time: 1.5,
//             is_playing: true,
//             buffered_end: 10.0,
//             is_buffering: false,
//         };
//         let json = serde_json::to_string(&msg).expect("serialize OutMessage");
//         assert!(json.contains("currentTime"));
//         let back: OutMessage = serde_json::from_str(&json).expect("deserialize OutMessage");
//         assert_eq!(back, msg);
//     }

//     #[test]
//     fn roundtrip_ready_error() {
//         let r = OutMessage::Ready;
//         let j = serde_json::to_string(&r).expect("serialize Ready");
//         let _: OutMessage = serde_json::from_str(&j).expect("deserialize Ready");
//         let e = OutMessage::Error {
//             message: "test".to_string(),
//         };
//         let j = serde_json::to_string(&e).expect("serialize Error");
//         let _: OutMessage = serde_json::from_str(&j).expect("deserialize Error");
//     }

//     #[test]
//     fn bincode_roundtrip_in() {
//         let msg = InMessage::Tick;
//         let bytes = encode_in_message(&msg).expect("encode Tick");
//         let back = decode_in_message(&bytes).expect("decode Tick");
//         assert_eq!(back, msg);

//         let seek = InMessage::Seek { time: 1.5 };
//         let bytes = encode_in_message(&seek).expect("encode Seek");
//         let back = decode_in_message(&bytes).expect("decode Seek");
//         assert_eq!(back, seek);
//     }

//     #[test]
//     fn bincode_roundtrip_out() {
//         let msg = OutMessage::StateUpdate {
//             current_time: 1.5,
//             is_playing: true,
//             buffered_end: 10.0,
//             is_buffering: false,
//         };
//         let bytes = encode_out_message(&msg).expect("encode StateUpdate");
//         let back = decode_out_message(&bytes).expect("decode StateUpdate");
//         assert_eq!(back, msg);

//         let r = OutMessage::Ready;
//         let bytes = encode_out_message(&r).expect("encode Ready");
//         let back = decode_out_message(&bytes).expect("decode Ready");
//         assert_eq!(back, r);
//     }
// }
