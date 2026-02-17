/* tslint:disable */
/* eslint-disable */

/**
 * Main-thread player: holds audio and video players plus current time.
 * Audio pipeline (AudioContext, decoder) runs here; worker only receives SET_AUDIO_BUFFERED_END.
 * Holds the derived secret key (32 bytes) after handshake. Buffers are decrypted internally; never exposed to JS.
 */
export class MediaPlayer {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Feed one audio media segment; decode and schedule on main thread, post SET_AUDIO_BUFFERED_END to worker.
     * Encrypted buffer is decrypted internally.
     */
    feedAudioSegment(buffer: Uint8Array): void;
    /**
     * Send one video media segment. Encrypted buffer is decrypted internally before transfer to worker.
     */
    feedVideoSegment(buffer: Uint8Array): void;
    /**
     * Get the latest audio buffered end (seconds) from the main-thread audio pipeline.
     */
    getAudioBufferedEnd(): number;
    /**
     * Handshake: GET /media/init (salt binary), GET /media/session (sessionId),
     * derive key, store only the key, discard sessionId and salt.
     */
    handshake(base_url: string): Promise<any>;
    /**
     * Initialize audio on main thread (AudioContext cannot be created in worker).
     * Encrypted buffer is decrypted internally before parsing.
     */
    initAudio(buffer: Uint8Array): void;
    /**
     * Queue canvas for transfer. INIT_CANVAS is sent when the worker signals SCRIPT_READY.
     */
    initCanvas(canvas: OffscreenCanvas): void;
    /**
     * Send video init segment. Encrypted buffer is decrypted internally before transfer to worker.
     */
    initVideo(buffer: Uint8Array): void;
    /**
     * Create the worker from the given script URL (e.g. from Vite worker&url).
     * Sets up the message handler; call initCanvas(canvas) after this with the transferred canvas.
     */
    initWorker(worker_url: string): void;
    /**
     * Constructor for JS: `new MediaPlayer()`. Cannot implement Default (wasm_bindgen limitation).
     */
    constructor();
    pause(): void;
    play(): void;
    /**
     * Seek to time in seconds.
     */
    seek(time: number): void;
    /**
     * Mute or unmute audio.
     */
    setMuted(muted: boolean): void;
    /**
     * Set callback for worker ERROR; called with message string.
     */
    setOnError(callback: Function): void;
    /**
     * Set callback for worker READY.
     */
    setOnReady(callback: Function): void;
    /**
     * Set callback for state updates (currentTime, isPlaying, bufferedEnd, isBuffering).
     * Called with a single object argument: `{ currentTime, isPlaying, bufferedEnd, isBuffering }`.
     */
    setOnStateUpdate(callback: Function): void;
    /**
     * Set volume (0–1). Main-thread gain node.
     */
    setVolume(volume: number): void;
    /**
     * Terminate the worker and clear state. Call when tearing down the player.
     */
    terminate(): void;
    /**
     * Send TICK to the worker (call from requestAnimationFrame).
     */
    tick(): void;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_mediaplayer_free: (a: number, b: number) => void;
    readonly mediaplayer_feedAudioSegment: (a: number, b: number, c: number) => [number, number];
    readonly mediaplayer_feedVideoSegment: (a: number, b: number, c: number) => [number, number];
    readonly mediaplayer_getAudioBufferedEnd: (a: number) => number;
    readonly mediaplayer_handshake: (a: number, b: number, c: number) => any;
    readonly mediaplayer_initAudio: (a: number, b: number, c: number) => [number, number];
    readonly mediaplayer_initCanvas: (a: number, b: any) => void;
    readonly mediaplayer_initVideo: (a: number, b: number, c: number) => [number, number];
    readonly mediaplayer_initWorker: (a: number, b: number, c: number) => [number, number];
    readonly mediaplayer_new: () => number;
    readonly mediaplayer_pause: (a: number) => void;
    readonly mediaplayer_play: (a: number) => void;
    readonly mediaplayer_seek: (a: number, b: number) => void;
    readonly mediaplayer_setMuted: (a: number, b: number) => void;
    readonly mediaplayer_setOnError: (a: number, b: any) => void;
    readonly mediaplayer_setOnReady: (a: number, b: any) => void;
    readonly mediaplayer_setOnStateUpdate: (a: number, b: any) => void;
    readonly mediaplayer_setVolume: (a: number, b: number) => void;
    readonly mediaplayer_terminate: (a: number) => void;
    readonly mediaplayer_tick: (a: number) => void;
    readonly wasm_bindgen_2a44ac06cfb9dcc1___closure__destroy___dyn_core_8ddcb40e007440f7___ops__function__Fn__web_sys_e8911d6d7654a6a3___features__gen_AudioData__AudioData____Output_______: (a: number, b: number) => void;
    readonly wasm_bindgen_2a44ac06cfb9dcc1___convert__closures_____invoke___wasm_bindgen_2a44ac06cfb9dcc1___JsValue__wasm_bindgen_2a44ac06cfb9dcc1___JsValue_____: (a: number, b: number, c: any, d: any) => void;
    readonly wasm_bindgen_2a44ac06cfb9dcc1___convert__closures_____invoke___wasm_bindgen_2a44ac06cfb9dcc1___JsValue_____: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen_2a44ac06cfb9dcc1___convert__closures_____invoke___web_sys_e8911d6d7654a6a3___features__gen_AudioData__AudioData_____: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen_2a44ac06cfb9dcc1___convert__closures_____invoke______: (a: number, b: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
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
