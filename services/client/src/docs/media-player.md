# Media player state: UI vs internal

## UI-only (template / presentational)

- **showControls** – Whether the control bar is visible (hide after 3s when playing).
- **isFullscreen** – Can be added if exposed; purely presentational.

## Derived for UI (from engine, used by template)

- **isPlaying** – From `VideoPlayer.state === "playing"`.
- **isBuffering** – From `VideoPlayer.isBuffering`.
- **currentTime**, **duration**, **bufferedEnd** – From tick and metadata.

## Internal (engine: VideoPlayer / AudioPlayer)

Not exposed as refs: `state`, `playheadOffset`, `startTime`, frame/sample queues, decoder state, `seekTargetUs` / `seekTime`, `lastCodecConfig`.

## Internal (composable: useMediaPlayer)

Not returned to template: `videoSegIdx`, `audioSegIdx`, `isFetchingVideo`, `isFetchingAudio`, `hasInitialized`, `isSeeking`, fetch `AbortController`.
