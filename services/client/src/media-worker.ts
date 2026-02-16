/**
 * Media worker: WebGPU + VideoDecoder + render on OffscreenCanvas.
 * Main thread transfers the canvas and sends init/segments/commands; worker posts STATE_UPDATE.
 * Rendering is driven by TICK messages from the main thread's requestAnimationFrame loop
 * to stay synchronized with the display's vsync.
 */
import { VideoPlayer } from "./models/video-player";
import shaderCode from "./shaders/video.wgsl?raw";

type InitCanvasMessage = { type: "INIT_CANVAS"; canvas: OffscreenCanvas };
type InitVideoMessage = { type: "INIT_VIDEO"; buffer: ArrayBuffer };
type FeedVideoSegmentMessage = { type: "FEED_VIDEO_SEGMENT"; buffer: ArrayBuffer };
type PlayMessage = { type: "PLAY" };
type PauseMessage = { type: "PAUSE" };
type SeekMessage = { type: "SEEK"; time: number };
type TickMessage = { type: "TICK" };

type InMessage =
  | InitCanvasMessage
  | InitVideoMessage
  | FeedVideoSegmentMessage
  | PlayMessage
  | PauseMessage
  | SeekMessage
  | TickMessage;

function isInitCanvas(d: InMessage): d is InitCanvasMessage {
  return d.type === "INIT_CANVAS";
}
function isInitVideo(d: InMessage): d is InitVideoMessage {
  return d.type === "INIT_VIDEO";
}
function isFeedVideoSegment(d: InMessage): d is FeedVideoSegmentMessage {
  return d.type === "FEED_VIDEO_SEGMENT";
}
function isSeek(d: InMessage): d is SeekMessage {
  return d.type === "SEEK";
}

let videoPlayer: VideoPlayer | null = null;
const STATE_UPDATE_INTERVAL = 4; // post state every N ticks (~15fps for UI)
let tickCount = 0;

function postState(): void {
  if (!videoPlayer) return;
  self.postMessage({
    type: "STATE_UPDATE",
    currentTime: videoPlayer.currentTime,
    isPlaying: videoPlayer.state === "playing",
    bufferedEnd: videoPlayer.bufferedEndSec,
    isBuffering: videoPlayer.isBuffering,
  });
}

function tick(): void {
  if (!videoPlayer) return;
  try {
    videoPlayer.tick();
    tickCount++;
    if (tickCount >= STATE_UPDATE_INTERVAL) {
      tickCount = 0;
      postState();
    }
  } catch (e) {
    console.warn("Worker tick error:", e);
  }
}

async function handleInitCanvas(canvas: OffscreenCanvas): Promise<void> {
  if (!navigator.gpu) {
    self.postMessage({ type: "ERROR", message: "WebGPU not supported" });
    return;
  }
  const adapter = await navigator.gpu.requestAdapter({
    powerPreference: "high-performance",
  });
  if (!adapter) {
    self.postMessage({ type: "ERROR", message: "Failed to request WebGPU adapter" });
    return;
  }
  const device = await adapter.requestDevice();
  const context = canvas.getContext("webgpu");
  if (!context) {
    self.postMessage({ type: "ERROR", message: "Failed to get WebGPU context" });
    return;
  }
  context.configure({
    device,
    format: navigator.gpu.getPreferredCanvasFormat(),
    alphaMode: "premultiplied",
  });

  const shaderModule = device.createShaderModule({ code: shaderCode });
  const pipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: { module: shaderModule, entryPoint: "vert_main" },
    fragment: {
      module: shaderModule,
      entryPoint: "frag_main",
      targets: [{ format: navigator.gpu.getPreferredCanvasFormat() }],
    },
    primitive: { topology: "triangle-strip" },
  });
  const sampler = device.createSampler({
    magFilter: "linear",
    minFilter: "linear",
  });

  videoPlayer = new VideoPlayer(device, context, pipeline, sampler);
  self.postMessage({ type: "READY" });
  postState();
}

self.onmessage = (event: MessageEvent<InMessage>) => {
  const data = event.data;
  if (isInitCanvas(data)) {
    handleInitCanvas(data.canvas);
    return;
  }
  if (data.type === "TICK") {
    tick();
    return;
  }
  if (!videoPlayer) return;
  if (isInitVideo(data)) {
    videoPlayer.setConfiguration(data.buffer);
    return;
  }
  if (isFeedVideoSegment(data)) {
    videoPlayer.feedSegment(data.buffer);
    return;
  }
  if (data.type === "PLAY") {
    videoPlayer.play();
    return;
  }
  if (data.type === "PAUSE") {
    videoPlayer.pause();
    return;
  }
  if (isSeek(data)) {
    videoPlayer.seek(data.time);
    return;
  }
};
