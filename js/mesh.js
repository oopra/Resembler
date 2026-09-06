/* mesh.js — the face mesh: loading it, running it, and reading colour off the picture.
   The only file that knows MediaPipe exists. Everything above it sees landmarks and numbers.

   IT ALL RUNS HERE. The model and its runtime are files in this repo, served from this origin and
   cached by the service worker. Nothing is fetched from a CDN, nothing is sent anywhere, and the app
   works with the network switched off after the first visit. That is not a privacy flourish bolted
   on afterwards — it is the reason the app is built this way. These are photographs of somebody's
   children; the right number of copies to make of them is zero.

   THE COST, STATED PLAINLY. The runtime is about 12 MB and the model about 4 MB. That is a real
   download, once, and the UI says so while it happens rather than sitting on a spinner. In exchange:
   478 landmarks including both irises (which is what makes eye colour readable and gives a stable
   ruler to measure everything else against), a head-pose matrix (so a face turned away can be
   refused instead of mismeasured), and blendshapes (so a broad grin is known to have moved the
   mouth). */

var RX_MESH_WASM  = './vendor/mediapipe/wasm';
var RX_MESH_MODEL = './models/face_landmarker.task';
/* Careful: fetch() resolves against the DOCUMENT's URL while a dynamic import() in a classic script
   resolves against THIS SCRIPT's URL. Hence './vendor/…' for the two fetches above and '../vendor/…'
   here, for the same directory. */
var RX_MESH_BUNDLE = '../vendor/mediapipe/vision_bundle.mjs';
var RX_DETECT_PX = 640;        // faces are found at this size; landmarks are normalised, so it costs nothing
var RX_MAX_YAW = 20;           // degrees off-centre before widths stop meaning anything
var RX_MAX_PITCH = 20;

var rxMeshState = { landmarker: null, loading: null };

/* Fetch with a byte counter, so a 12 MB download can show a bar instead of a spinner. */
async function rxFetchBytes(url, onProgress){
  var res = await fetch(url);
  if(!res.ok) throw new Error('Could not load ' + url + ' (' + res.status + ')');
  var total = parseInt(res.headers.get('content-length') || '0', 10);
  if(!res.body || !total){ return await res.arrayBuffer(); }        // no stream: just wait
  var reader = res.body.getReader(), chunks = [], got = 0, r;
  for(;;){
    r = await reader.read();
    if(r.done) break;
    chunks.push(r.value); got += r.value.length;
    if(onProgress) onProgress(got, total);
  }
  var out = new Uint8Array(got), at = 0;
  chunks.forEach(function(c){ out.set(c, at); at += c.length; });
  return out.buffer;
}

/* Load the mesh once. `onProgress(fraction, label)` is called as the two big files come down; the
   runtime is fetched first purely to warm the HTTP cache, because MediaPipe's own loader gives no
   progress hook and a silent twelve megabytes feels like a hang. */
function rxLoadMesh(onProgress){
  if(rxMeshState.landmarker) return Promise.resolve(rxMeshState.landmarker);
  if(rxMeshState.loading) return rxMeshState.loading;
  var note = onProgress || function(){};
  rxMeshState.loading = (async function(){
    note(0, 'Fetching the face-mesh runtime (about 12 MB, once)');
    await rxFetchBytes(RX_MESH_WASM + '/vision_wasm_internal.wasm', function(got, total){
      note(0.7 * (got / total), 'Fetching the face-mesh runtime (about 12 MB, once)');
    });
    note(0.7, 'Fetching the face model (about 4 MB, once)');
    var model = await rxFetchBytes(RX_MESH_MODEL, function(got, total){
      note(0.7 + 0.25 * (got / total), 'Fetching the face model (about 4 MB, once)');
    });
    note(0.96, 'Starting the face mesh');
    var mp = await import(RX_MESH_BUNDLE);
    var fileset = await mp.FilesetResolver.forVisionTasks(RX_MESH_WASM);
    rxMeshState.landmarker = await mp.FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetBuffer: new Uint8Array(model), delegate: 'CPU' },
      runningMode: 'IMAGE', numFaces: 3,
      outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true
    });
    note(1, '');
    return rxMeshState.landmarker;
  })();
  rxMeshState.loading.catch(function(){ rxMeshState.loading = null; });   // let a failure be retried
  return rxMeshState.loading;
}

/* Run the mesh over an image or canvas. Returns the biggest face found, or null. */
function rxDetect(source){
  var lm = rxMeshState.landmarker;
  if(!lm) throw new Error('The face mesh has not been loaded yet.');
  var res = lm.detect(source);
  var faces = res.faceLandmarks || [];
  if(!faces.length) return null;
  var best = 0, bestArea = -1, i;
  for(i = 0; i < faces.length; i++){
    var a = rxSpread(faces[i]);
    if(a > bestArea){ bestArea = a; best = i; }
  }
  var blend = {};
  ((res.faceBlendshapes || [])[best] || {}).categories?.forEach(function(c){ blend[c.categoryName] = c.score; });
  var mtx = (res.facialTransformationMatrixes || [])[best];
  return {
    pts: faces[best].map(function(p){ return [p.x, p.y, p.z]; }),
    blend: blend,
    pose: rxPose(mtx && mtx.data),
    faces: faces.length
  };
}
function rxSpread(pts){
  var x0 = 1, x1 = 0, y0 = 1, y1 = 0, i;
  for(i = 0; i < pts.length; i++){
    if(pts[i].x < x0) x0 = pts[i].x; if(pts[i].x > x1) x1 = pts[i].x;
    if(pts[i].y < y0) y0 = pts[i].y; if(pts[i].y > y1) y1 = pts[i].y;
  }
  return (x1 - x0) * (y1 - y0);
}

/* Find the head in a whole photo and hand back a frame for it. Better than a face-detector box in
   two ways that matter here: it works in every browser rather than only Chromium, and it knows where
   the eyes are, so the crop comes out level. The box is pushed well above the brow because a mesh
   stops at the hairline and a portrait should not. */
async function rxAutoFrameFromMesh(source){
  var w = rxDims(source).w, h = rxDims(source).h;
  var scale = Math.min(1, RX_DETECT_PX / Math.max(w, h));
  var c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * scale)); c.height = Math.max(1, Math.round(h * scale));
  c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
  var got = rxDetect(c);
  if(!got) return null;

  var x0 = 1, x1 = 0, y0 = 1, y1 = 0;
  got.pts.forEach(function(p){
    if(p[0] < x0) x0 = p[0]; if(p[0] > x1) x1 = p[0];
    if(p[1] < y0) y0 = p[1]; if(p[1] > y1) y1 = p[1];
  });
  var fw = (x1 - x0) * w, fh = (y1 - y0) * h;
  var cx = (x0 + x1) / 2 * w;
  var cy = (y0 + y1) / 2 * h - fh * 0.16;          // lift towards the crown, which the mesh cannot see
  var size = Math.max(fw, fh) * 1.5;
  var a = got.pts[RX_P.irisL], b = got.pts[RX_P.irisR];
  var angle = Math.atan2((b[1] - a[1]) * h, (b[0] - a[0]) * w);
  if(Math.abs(angle) > 0.6) angle = 0;
  return { frame: rxClampFrame({ cx: cx, cy: cy, size: size, angle: angle }, w, h),
           faces: got.faces, pose: got.pose };
}

/* ---- colour, read off the picture rather than guessed ----
   Skin from three patches (both cheeks and the forehead) and eye colour from the iris ring, both by
   MEDIAN, so a highlight on a cheekbone or a catchlight in the eye cannot drag the answer. Reported
   in CIE Lab, where a difference of a few units is about what an eye can see — which makes the
   tolerances in measure.js mean something rather than being pulled out of the air. */
function rxSrgbToLab(r, g, b){
  function lin(v){ v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
  var R = lin(r), G = lin(g), B = lin(b);
  var X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  var Y = (R * 0.2126 + G * 0.7152 + B * 0.0722);
  var Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  function f(t){ return t > 0.008856 ? Math.pow(t, 1 / 3) : (7.787 * t + 16 / 116); }
  var fx = f(X), fy = f(Y), fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
function rxMedian(a){
  if(!a.length) return null;
  var s = a.slice().sort(function(x, y){ return x - y; });
  return s[s.length >> 1];
}
// Median colour of a disc of pixels, dropping the darkest and brightest slices — shadow and shine.
function rxPatch(data, W, H, cx, cy, r, dropLow, dropHigh){
  var px = [], x, y, i, d2;
  for(y = Math.max(0, Math.floor(cy - r)); y <= Math.min(H - 1, Math.ceil(cy + r)); y++){
    for(x = Math.max(0, Math.floor(cx - r)); x <= Math.min(W - 1, Math.ceil(cx + r)); x++){
      d2 = (x - cx) * (x - cx) + (y - cy) * (y - cy);
      if(d2 > r * r) continue;
      i = (y * W + x) * 4;
      px.push([data[i], data[i + 1], data[i + 2], data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114]);
    }
  }
  if(px.length < 8) return null;
  px.sort(function(a, b){ return a[3] - b[3]; });
  var lo = Math.floor(px.length * (dropLow || 0)), hi = px.length - Math.floor(px.length * (dropHigh || 0));
  var keep = px.slice(lo, Math.max(lo + 1, hi));
  return rxSrgbToLab(rxMedian(keep.map(function(p){ return p[0]; })),
                     rxMedian(keep.map(function(p){ return p[1]; })),
                     rxMedian(keep.map(function(p){ return p[2]; })));
}

function rxSampleColours(canvas, pts){
  var W = canvas.width, H = canvas.height;
  var data = canvas.getContext('2d').getImageData(0, 0, W, H).data;
  var at = function(i){ return [pts[i][0] * W, pts[i][1] * H]; };
  var out = {};

  // Skin: mid-cheek on both sides (between the cheekbone and the nose) plus the middle of the
  // forehead. Median of the three, so a shadow down one side does not decide it.
  var eyeL = at(RX_P.irisL), eyeR = at(RX_P.irisR);
  var iod = Math.hypot(eyeR[0] - eyeL[0], eyeR[1] - eyeL[1]);
  var r = Math.max(3, iod * 0.13);
  var mid = function(a, b, t){ return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; };
  var spots = [
    mid(at(RX_P.cheekL), at(RX_P.alarL), 0.45),
    mid(at(RX_P.cheekR), at(RX_P.alarR), 0.45),
    mid(at(RX_P.forehead), at(RX_P.nasion), 0.35)
  ];
  var labs = spots.map(function(s){ return rxPatch(data, W, H, s[0], s[1], r, 0.15, 0.15); }).filter(Boolean);
  if(labs.length){
    out.skin_L = rxMedian(labs.map(function(l){ return l[0]; }));
    out.skin_a = rxMedian(labs.map(function(l){ return l[1]; }));
    out.skin_b = rxMedian(labs.map(function(l){ return l[2]; }));
  }

  // Iris: a small disc at each iris centre, with the darkest 40% (pupil and lash shadow) and the
  // brightest 20% (the catchlight) thrown away before the median.
  var ir = Math.max(2, iod * 0.075);
  var eyes = [rxPatch(data, W, H, eyeL[0], eyeL[1], ir, 0.4, 0.2),
              rxPatch(data, W, H, eyeR[0], eyeR[1], ir, 0.4, 0.2)].filter(Boolean);
  if(eyes.length){
    out.eye_L = rxMedian(eyes.map(function(l){ return l[0]; }));
    out.eye_a = rxMedian(eyes.map(function(l){ return l[1]; }));
    out.eye_b = rxMedian(eyes.map(function(l){ return l[2]; }));
  }
  return out;
}

/* Is this reading usable? A face turned or tipped away foreshortens one side of everything, which
   looks exactly like a genuinely narrower jaw. Better to say so than to measure it. */
function rxPoseWarning(pose){
  if(!pose) return null;
  if(Math.abs(pose.yaw) > RX_MAX_YAW)
    return 'This face is turned about ' + Math.round(Math.abs(pose.yaw)) + '° away from the camera, which squashes one side. A straight-on photo will compare much better.';
  if(Math.abs(pose.pitch) > RX_MAX_PITCH)
    return 'This face is tipped about ' + Math.round(Math.abs(pose.pitch)) + '° up or down, which stretches the forehead or the chin. A level, straight-on photo will compare much better.';
  return null;
}

if(typeof module !== 'undefined' && module.exports){
  module.exports = { rxSrgbToLab: rxSrgbToLab, rxMedian: rxMedian, rxPatch: rxPatch, rxPoseWarning: rxPoseWarning,
    RX_MAX_YAW: RX_MAX_YAW, RX_MAX_PITCH: RX_MAX_PITCH };
}
