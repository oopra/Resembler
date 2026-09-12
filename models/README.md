# face_landmarker.task

MediaPipe's Face Landmarker model (float16, revision 1), from
`https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task`.
Apache-2.0, copyright the MediaPipe authors — see `../vendor/LICENSE-Apache-2.0.txt`.

It produces 478 landmarks (468 face + 10 iris), a 4×4 facial transformation matrix and 52
blendshapes. All three are used: the landmarks for geometry, the matrix to detect a head turned too
far to measure, and the blendshapes to drop measurements an expression has moved.

Committed rather than fetched at runtime so the app has no external dependency at all. If you replace
it, bump `VERSION` in `sw.js` — it is cached cache-first and never revalidated.

# kinmap.bin

The per-feature adult→child maps, fitted here rather than downloaded: for each of three windows on
the aligned face (eyes, nose, mouth) a 512-wide mean, 64 principal directions of that window's
embedding space, and a 64×64 map from adult space into child space. Little-endian float32 behind a
16-byte header (`RXKM`, version, 512, 64), in that region order. 438 KB.

Fitted on the 836 usable parent/child pairs of KinFaceW-II (Lu et al., PAMI 2014) and measured on
KinFaceW-I, which it never saw: kin-vs-stranger AUC 0.848 → 0.878, and picking the real parent out
of a lineup of two 85.9% → 88.7%. The fitting procedure and the two ways it could have fooled me are
in `../tools/README-calibration.md`.

Neither dataset is redistributed here. Bump `VERSION` in `sw.js` if this file is replaced — like the
other models it is cached cache-first and never revalidated.
