/* embed.js — the face-recognition half of the comparison.

   WHY THIS EXISTS. The measurements in measure.js are thirty-five things a person can point at, and
   they carry a real but weak family signal: benchmarked on 849 real parent/child pairs they separate
   kin from strangers with an AUC of 0.73. A face-recognition network does much better at the same
   task — 0.845 — because it was trained on hundreds of thousands of faces rather than designed by
   one person reasoning about noses. Blended 60/40 the two reach 0.868, better than either alone:
   the network and the measurements are not seeing the same thing, and the measurements contribute
   colouring, which recognition models are deliberately trained to ignore.

   Put concretely, on the test that matters — a daughter, her real father, and an unrelated woman —
   the measurements alone pick the father 68% of the time and the blend picks him 81%.

   WHAT IT IS. InsightFace's buffalo_s recognition model (w600k_mbf, a MobileFaceNet trained on
   WebFace600K), 13.6 MB of ONNX, run through ONNX Runtime Web. Like the face mesh, it is a file in
   this repository, served from this origin and cached: no API, no upload, nothing leaves the device.
   It turns an aligned face into 512 numbers; two faces are compared by the cosine of those.

   WHAT IT IS NOT. It produces ONE number. It cannot tell you whose eyes a child has — that stays the
   job of the measurements, which is the other reason both are kept. And it is a recognition model:
   its accuracy is known to vary between demographic groups, and the benchmark behind the numbers
   above is a single dataset of limited diversity. It is better on average. It is not better for
   everyone, and there is no honest way for this app to tell you which you are. */

/* Three different things resolve these paths, against three different bases, and getting it wrong
   fails only at runtime:
     • fetch()            resolves against the DOCUMENT's URL
     • dynamic import()   resolves against THIS SCRIPT's URL  (so '../' to climb out of js/)
     • ort.env.wasm.wasmPaths resolves against the ORT MODULE's own URL — which turned
       './vendor/onnxruntime/' into '/vendor/onnxruntime/vendor/onnxruntime/' the first time.
   So the two that ORT touches are made absolute against the document and the ambiguity goes away.
   Absolute-from-baseURI rather than absolute-from-root, so the app still works under a subpath like
   a GitHub Pages project site.
   Resolved lazily rather than at load, so this file can also be required by the Node tests, where
   there is no document at all. */
function rxOrtPath(){ return new URL('vendor/onnxruntime/', document.baseURI).href; }
function rxModelPath(){ return new URL('models/face_embedding.onnx', document.baseURI).href; }
var RX_ORT_BUNDLE = '../vendor/onnxruntime/ort.wasm.min.mjs';   // resolved against THIS script's URL

/* ArcFace's canonical five points on a 112×112 crop: both eyes, nose tip, both mouth corners. Every
   face is warped onto this template before the network sees it — the model was trained on faces in
   exactly this pose, and feeding it anything else quietly costs accuracy. */
var RX_ARC_TEMPLATE = [
  [38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]
];

var rxEmbState = { session: null, loading: null, input: null, output: null };

/* Least-squares similarity transform (uniform scale, rotation, translation) taking `src` onto `dst`.
   A similarity rather than a full affine on purpose: allowing shear would let the warp squash a face
   towards the template and hide exactly the differences we are trying to measure. */
function rxSimilarity(src, dst){
  var n = src.length, i, scx = 0, scy = 0, dcx = 0, dcy = 0;
  for(i = 0; i < n; i++){ scx += src[i][0]; scy += src[i][1]; dcx += dst[i][0]; dcy += dst[i][1]; }
  scx /= n; scy /= n; dcx /= n; dcy /= n;
  var a = 0, b = 0, norm = 0, sx, sy, dx, dy;
  for(i = 0; i < n; i++){
    sx = src[i][0] - scx; sy = src[i][1] - scy;
    dx = dst[i][0] - dcx; dy = dst[i][1] - dcy;
    a += sx * dx + sy * dy;
    b += sx * dy - sy * dx;
    norm += sx * sx + sy * sy;
  }
  if(norm < 1e-9) return null;
  var kc = a / norm, ks = b / norm;
  return { a: kc, b: ks, c: -ks, d: kc, e: dcx - kc * scx + ks * scy, f: dcy - ks * scx - kc * scy };
}

function rxLoadEmbedder(onProgress){
  if(rxEmbState.session) return Promise.resolve(rxEmbState.session);
  if(rxEmbState.loading) return rxEmbState.loading;
  var note = onProgress || function(){};
  rxEmbState.loading = (async function(){
    note(0, 'Fetching the face-recognition runtime (about 11 MB, once)');
    await rxFetchBytes(rxOrtPath() + 'ort-wasm-simd-threaded.wasm', function(got, total){
      note(0.45 * (got / total), 'Fetching the face-recognition runtime (about 11 MB, once)');
    });
    note(0.45, 'Fetching the face-recognition model (about 14 MB, once)');
    await rxFetchBytes(rxModelPath(), function(got, total){
      note(0.45 + 0.5 * (got / total), 'Fetching the face-recognition model (about 14 MB, once)');
    });
    note(0.95, 'Starting the face-recognition model');
    var ort = await import(RX_ORT_BUNDLE);
    ort.env.wasm.wasmPaths = rxOrtPath();
    ort.env.wasm.numThreads = 1;          // one thread: no SharedArrayBuffer, no cross-origin isolation needed
    rxEmbState.ort = ort;
    rxEmbState.session = await ort.InferenceSession.create(rxModelPath(), { executionProviders: ['wasm'] });
    rxEmbState.input = rxEmbState.session.inputNames[0];
    rxEmbState.output = rxEmbState.session.outputNames[0];
    note(1, '');
    return rxEmbState.session;
  })();
  rxEmbState.loading.catch(function(){ rxEmbState.loading = null; });
  return rxEmbState.loading;
}

/* A prepared face canvas + its landmarks → 512 numbers, unit length. Null if it cannot be aligned. */
async function rxEmbed(canvas, pts){
  if(!rxEmbState.session) throw new Error('The face-recognition model has not been loaded yet.');
  var W = canvas.width, H = canvas.height;
  var at = function(i){ return [pts[i][0] * W, pts[i][1] * H]; };
  var src = [at(RX_P.irisL), at(RX_P.irisR), at(RX_P.noseTip), at(RX_P.mouthL), at(RX_P.mouthR)];
  var m = rxSimilarity(src, RX_ARC_TEMPLATE);
  if(!m) return null;

  var c = document.createElement('canvas');
  c.width = 112; c.height = 112;
  var ctx = c.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, 112, 112);
  ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
  ctx.drawImage(canvas, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  // The model wants RGB planes, each pixel mapped to roughly [-1, 1].
  var px = ctx.getImageData(0, 0, 112, 112).data;
  var t = new Float32Array(3 * 112 * 112), i, p, N = 112 * 112;
  for(i = 0, p = 0; i < N; i++, p += 4){
    t[i]         = (px[p]     - 127.5) / 127.5;
    t[N + i]     = (px[p + 1] - 127.5) / 127.5;
    t[2 * N + i] = (px[p + 2] - 127.5) / 127.5;
  }
  var feeds = {};
  feeds[rxEmbState.input] = new rxEmbState.ort.Tensor('float32', t, [1, 3, 112, 112]);
  var out = await rxEmbState.session.run(feeds);
  var v = out[rxEmbState.output].data;
  var norm = 0;
  for(i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  var unit = new Float32Array(v.length);
  for(i = 0; i < v.length; i++) unit[i] = v[i] / norm;
  return unit;
}

function rxCosine(a, b){
  if(!a || !b || a.length !== b.length) return null;
  var s = 0;
  for(var i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

if(typeof module !== 'undefined' && module.exports){
  module.exports = { RX_ARC_TEMPLATE: RX_ARC_TEMPLATE, rxSimilarity: rxSimilarity, rxCosine: rxCosine };
}
