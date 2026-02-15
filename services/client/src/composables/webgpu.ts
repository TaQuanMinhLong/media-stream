import type { MaybeComputedElementRef } from "@vueuse/core";
import { useEventListener } from "@vueuse/core";
import { onMounted, shallowRef, toValue } from "vue";

export function useWebGPU(
  canvasElement: MaybeComputedElementRef<HTMLCanvasElement | null | undefined>,
  shaderCode: string,
  options?: {
    onReady?: (
      gpuDevice: GPUDevice,
      gpuContext: GPUCanvasContext,
      gpuPipeline: GPURenderPipeline,
      gpuSampler: GPUSampler,
    ) => void | Promise<void>;
  },
) {
  const gpuDevice = shallowRef<GPUDevice | null>(null);
  const gpuContext = shallowRef<GPUCanvasContext | null>(null);
  const gpuPipeline = shallowRef<GPURenderPipeline | null>(null);
  const gpuSampler = shallowRef<GPUSampler | null>(null);

  function configureCanvas() {
    if (!gpuDevice.value || !gpuContext.value) return;

    // IMPORTANT: Since you want fixed 1920x1080, we don't change canvas.width/height.
    // We just ensure the context is linked to the device.
    gpuContext.value.configure({
      device: gpuDevice.value,
      format: navigator.gpu.getPreferredCanvasFormat(),
      alphaMode: "premultiplied",
    });
  }

  onMounted(async () => {
    if (!navigator.gpu) return console.error("WebGPU not supported");

    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) return console.error("Failed to request WebGPU adapter");

    gpuDevice.value = await adapter.requestDevice();
    const canvas = toValue(canvasElement);
    if (!canvas) return console.error("Failed to get canvas element");

    gpuContext.value = canvas.getContext("webgpu");
    if (!gpuContext.value) return console.error("Failed to get WebGPU context");

    configureCanvas();

    const shaderModule = gpuDevice.value.createShaderModule({ code: shaderCode });

    gpuPipeline.value = gpuDevice.value.createRenderPipeline({
      layout: "auto",
      vertex: { module: shaderModule, entryPoint: "vert_main" },
      fragment: {
        module: shaderModule,
        entryPoint: "frag_main",
        targets: [{ format: navigator.gpu.getPreferredCanvasFormat() }],
      },
      primitive: { topology: "triangle-strip" },
    });

    gpuSampler.value = gpuDevice.value.createSampler({
      magFilter: "linear",
      minFilter: "linear",
    });

    await options?.onReady?.(
      gpuDevice.value,
      gpuContext.value,
      gpuPipeline.value,
      gpuSampler.value,
    );
  });

  // Re-configure if the device changes or canvas mounting flickers
  useEventListener(window, "resize", configureCanvas);

  return { gpuDevice, gpuContext, gpuPipeline, gpuSampler };
}
