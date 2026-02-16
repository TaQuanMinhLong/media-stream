/**
 * Media worker entry: load Rust WASM, create MediaWorker instance, run message loop.
 * GPU is created in JS (adapter/device/context/pipeline/sampler) and passed to Rust via initWithGpu.
 * All other messages (TICK, INIT_VIDEO, FEED_VIDEO_SEGMENT, PLAY, PAUSE, SEEK) are delegated to the Rust class.
 */
import init, { MediaWorker } from "@media-stream/worker";
import wasmUrl from "@media-stream/worker/media_worker_bg.wasm?url";
import shaderCode from "./shaders/video.wgsl?raw";

await init({ module_or_path: wasmUrl });
const mediaWorker = new MediaWorker();

type InitCanvasMessage = { type: "INIT_CANVAS"; canvas: OffscreenCanvas };

function isInitCanvas(d: unknown): d is InitCanvasMessage {
  return typeof d === "object" && d !== null && (d as InitCanvasMessage).type === "INIT_CANVAS";
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

  mediaWorker.initWithGpu(device, context, pipeline, sampler);
}

self.onmessage = (event: MessageEvent) => {
  const data = event.data;
  if (isInitCanvas(data)) {
    handleInitCanvas(data.canvas);
    return;
  }
  mediaWorker.handleMessage(data);
};
