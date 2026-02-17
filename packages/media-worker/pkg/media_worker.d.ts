/* tslint:disable */
/* eslint-disable */

/**
 * Media worker: holds all video state; GPU is passed from JS via init_with_gpu.
 * Audio pipeline runs on the main thread; the worker does not track audio buffering
 * and only reports video buffered state.
 */
export class MediaWorker {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Handle a message from the main thread. Dispatch by message.type.
     * Handles: TICK, PLAY, PAUSE, SEEK, INIT_VIDEO, FEED_VIDEO_SEGMENT.
     */
    handleMessage(data: any): void;
    /**
     * Initialize with GPU objects created in JS. Call after JS has set up device, context, pipeline, sampler.
     * Posts READY to the main thread.
     */
    initWithGpu(device: GPUDevice, context: GPUCanvasContext, pipeline: GPURenderPipeline, sampler: GPUSampler): void;
    constructor();
}

export function init_worker(): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_mediaworker_free: (a: number, b: number) => void;
    readonly init_worker: () => void;
    readonly mediaworker_handleMessage: (a: number, b: any) => void;
    readonly mediaworker_initWithGpu: (a: number, b: any, c: any, d: any, e: any) => void;
    readonly mediaworker_new: () => number;
    readonly wasm_bindgen_14c7c128c72c4947___closure__destroy___dyn_core_8ddcb40e007440f7___ops__function__Fn__web_sys_4097037548db0944___features__gen_VideoFrame__VideoFrame____Output_______: (a: number, b: number) => void;
    readonly wasm_bindgen_14c7c128c72c4947___convert__closures_____invoke___web_sys_4097037548db0944___features__gen_VideoFrame__VideoFrame_____: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen_14c7c128c72c4947___convert__closures_____invoke______: (a: number, b: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
