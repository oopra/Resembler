# Vendored third-party assets

These files are committed rather than fetched from a CDN at runtime. That is the point of the app:
the page loads nothing from anywhere else, so a family's photographs cannot leave the device even by
accident, and a `Content-Security-Policy` with no off-origin sources can be enforced (see `_headers`).

| Path | Project | Version | Licence |
| --- | --- | --- | --- |
| `mediapipe/vision_bundle.mjs` | [MediaPipe Tasks Vision](https://github.com/google-ai-edge/mediapipe) (`@mediapipe/tasks-vision` on npm) | 1.0.1 | Apache-2.0 |
| `mediapipe/wasm/vision_wasm_internal.{js,wasm}` | the same package's WebAssembly runtime | 1.0.1 | Apache-2.0 |
| `../models/face_landmarker.task` | [MediaPipe Face Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker), float16 revision 1 | — | Apache-2.0 |

Copyright the MediaPipe authors. The full licence text is in `LICENSE-Apache-2.0.txt`; the files
themselves are unmodified.

Only the SIMD WebAssembly build is shipped, not the no-SIMD fallback — it halves what has to be
downloaded, at the cost of needing Chrome 91+, Firefox 89+ or Safari 16.4+.

## Updating

```bash
npm pack @mediapipe/tasks-vision@<version> && tar xzf mediapipe-tasks-vision-<version>.tgz
cp package/vision_bundle.mjs vendor/mediapipe/
cp package/wasm/vision_wasm_internal.{js,wasm} vendor/mediapipe/wasm/
```

Then bump `VERSION` in `sw.js`, or browsers that already have the app will keep serving the old
runtime from the cache-first cache forever.
