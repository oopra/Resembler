# face_landmarker.task

MediaPipe's Face Landmarker model (float16, revision 1), from
`https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task`.
Apache-2.0, copyright the MediaPipe authors — see `../vendor/LICENSE-Apache-2.0.txt`.

It produces 478 landmarks (468 face + 10 iris), a 4×4 facial transformation matrix and 52
blendshapes. All three are used: the landmarks for geometry, the matrix to detect a head turned too
far to measure, and the blendshapes to drop measurements an expression has moved.

Committed rather than fetched at runtime so the app has no external dependency at all. If you replace
it, bump `VERSION` in `sw.js` — it is cached cache-first and never revalidated.
