/* faces.js — the image processing, and nothing beyond it.

   This file does four things to a photo and then stops:

     1. DECODE UPRIGHT. Phones record rotation in EXIF rather than in the pixels, so a portrait shot
        arrives on its side unless you ask for it upright. createImageBitmap(..., {imageOrientation:
        'from-image'}) is that ask.
     2. FRAME THE HEAD. A square crop around one head — forehead to chin, ear to ear. The rest of the
        photo is a distraction at best: the comparison should not be swayed by whether one person was
        photographed in a garden and the other in a kitchen. Auto where the browser has a face
        detector, hand-adjustable always, because the auto answer is wrong often enough to matter and
        a wrong frame quietly poisons everything downstream.
     3. LEVEL AND NORMALISE. Rotate so the eyes sit level (a tilted head reads as a different face
        shape), then stretch the exposure so both faces land in the same brightness range. Lighting
        is the single biggest false signal in photo comparison: two people under the same lamp look
        more alike than they are, and the same person in shade and sun looks less alike than they
        are. Levelling and exposure are corrected; colour is NOT touched beyond that, because eye and
        hair colour are real resemblance and we would be throwing them away.
     4. CHECK IT IS WORTH SENDING. Too few pixels on the face, or too soft to see an eyelid fold, and
        the answer would be confident noise — so the photo gets a warning before it is ever compared.

   What this file deliberately does NOT do: no beautifying, no smoothing, no skin retouching, no
   background removal, no face embeddings, no recognition, no matching against anything. The entire
   pipeline is "find the head, hold it still, even out the light". */

var RX_OUT_PX      = 448;   // the square each face is rendered into before it is sent
var RX_JPEG_Q      = 0.9;   // faces are the whole payload here, so a little more quality than usual
var RX_MIN_FACE_PX = 170;   // fewer source pixels across the head than this and detail is guesswork
var RX_FOCUS_MIN   = 2.5;   // mean |Laplacian| per unit brightness — below this the head is soft
var RX_STRETCH_LO  = 0.02;  // exposure percentiles: ignore the darkest 2% and brightest 2% so one
var RX_STRETCH_HI  = 0.98;  // specular highlight or one black shadow can't set the whole range
var RX_MAX_GAIN    = 2.2;   // cap the stretch, or a flat foggy photo turns into amplified noise

/* ---- 1. decode ---- */
async function rxDecode(file){
  try{
    return await createImageBitmap(file, { imageOrientation:'from-image' });
  }catch(e){
    // Safari and older browsers: fall back to an <img>, which applies EXIF orientation itself.
    return await new Promise(function(res, rej){
      var img = new Image(), url = URL.createObjectURL(file);
      img.onload = function(){ URL.revokeObjectURL(url); res(img); };
      img.onerror = function(){ URL.revokeObjectURL(url); rej(new Error('That file could not be read as an image.')); };
      img.src = url;
    });
  }
}
function rxDims(src){ return { w: src.width || src.naturalWidth, h: src.height || src.naturalHeight }; }

/* ---- 2. framing ----
   A frame is a square in SOURCE pixel coordinates: centre, side length, and the roll angle needed to
   bring the eyes level. Keeping it in source pixels (not normalised units) means the same frame
   describes the same crop whatever we later render it into. */
function rxDefaultFrame(w, h){
  // No detector: a head-and-shoulders photo puts the head in the upper middle, so start there. It is
  // a starting point for the drag handles, not a guess anyone has to live with.
  var size = Math.min(w, h) * (w > h ? 0.78 : 0.62);
  return rxClampFrame({ cx: w / 2, cy: h * (w > h ? 0.46 : 0.38), size: size, angle: 0 }, w, h);
}
function rxClampFrame(frame, w, h){
  var size = Math.max(24, Math.min(frame.size, Math.min(w, h)));
  var half = size / 2;
  return {
    cx: Math.max(half, Math.min(frame.cx, w - half)),
    cy: Math.max(half, Math.min(frame.cy, h - half)),
    size: size,
    angle: frame.angle || 0
  };
}
// A detector's face box → the frame we actually want. The box is the face; we want the head, so it
// is widened, and pushed up a little because a head has more above the eyes than the box allows.
function rxBoxToFrame(box, w, h){
  var size = Math.max(box.width, box.height) * 1.55;
  return rxClampFrame({ cx: box.x + box.width / 2, cy: box.y + box.height / 2 - box.height * 0.06, size: size, angle: 0 }, w, h);
}
// Two eye positions → the roll angle to undo. Guarded: a "detection" that puts the eyes on top of
// each other, or nearly vertical, is a bad detection and levelling it would make things worse.
function rxEyeAngle(a, b){
  if(!a || !b) return 0;
  var dx = b.x - a.x, dy = b.y - a.y;
  if(Math.abs(dx) < 1) return 0;
  var ang = Math.atan2(dy, dx);
  if(Math.abs(ang) > 0.6) return 0;              // > ~34°: not a level-able pair of eyes
  return ang;
}

/* Ask the browser for a face, if it has an opinion. FaceDetector ships on some Chromium builds and
   nowhere else, so this is a bonus path: it returns null far more often than not, and the manual
   frame is the real interface. */
async function rxAutoFrame(src){
  var w = rxDims(src).w, h = rxDims(src).h;
  if(typeof FaceDetector === 'undefined') return null;
  try{
    var faces = await new FaceDetector({ fastMode:false, maxDetectedFaces:5 }).detect(src);
    if(!faces || !faces.length) return null;
    faces.sort(function(a, b){ return (b.boundingBox.width * b.boundingBox.height) - (a.boundingBox.width * a.boundingBox.height); });
    var f = faces[0], frame = rxBoxToFrame(f.boundingBox, w, h);
    var eyes = (f.landmarks || []).filter(function(l){ return l.type === 'eye'; })
      .map(function(l){ return (l.locations || [])[0]; }).filter(Boolean);
    if(eyes.length === 2) frame.angle = rxEyeAngle(eyes[0], eyes[1]);
    return { frame: frame, faces: faces.length };
  }catch(e){ return null; }
}

/* ---- 3. render: crop, level, even out the light ---- */
function rxDrawFrame(src, frame, size){
  var c = document.createElement('canvas');
  c.width = size; c.height = size;
  var ctx = c.getContext('2d');
  ctx.fillStyle = '#2b2b2b';                      // anything the rotation pulls in from outside
  ctx.fillRect(0, 0, size, size);
  var k = size / frame.size;
  ctx.save();
  ctx.translate(size / 2, size / 2);
  ctx.rotate(-(frame.angle || 0));
  ctx.scale(k, k);
  ctx.translate(-frame.cx, -frame.cy);
  ctx.drawImage(src, 0, 0);
  ctx.restore();
  return c;
}

// Luminance histogram of an RGBA buffer. Rec. 601 weights: they track perceived brightness closely
// enough for an exposure decision and cost three multiplies.
function rxLumaHist(data){
  var hist = new Uint32Array(256), i;
  for(i = 0; i < data.length; i += 4){
    hist[(data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0]++;
  }
  return hist;
}
// Percentile bounds from a histogram — pure, and the piece most worth testing, because an
// off-by-one here silently crushes every face it touches.
function rxStretchBounds(hist, total, loFrac, hiFrac){
  var loTarget = total * loFrac, hiTarget = total * hiFrac, run = 0, lo = 0, hi = 255, i;
  for(i = 0; i < 256; i++){ run += hist[i]; if(run >= loTarget){ lo = i; break; } }
  run = 0;
  for(i = 0; i < 256; i++){ run += hist[i]; if(run >= hiTarget){ hi = i; break; } }
  if(hi <= lo) hi = Math.min(255, lo + 1);
  return { lo: lo, hi: hi };
}
// Apply the same linear map to R, G and B. Same map on every channel = exposure and contrast move,
// hue does not — which is the whole point: we are fixing the lighting, not the person's colouring.
function rxApplyStretch(data, lo, hi){
  var gain = Math.min(RX_MAX_GAIN, 255 / (hi - lo)), i, v;
  if(gain <= 1.02 && lo < 8) return false;        // already well exposed — leave it alone
  var lut = new Uint8ClampedArray(256);
  for(i = 0; i < 256; i++){ v = (i - lo) * gain; lut[i] = v < 0 ? 0 : (v > 255 ? 255 : v); }
  for(i = 0; i < data.length; i += 4){ data[i] = lut[data[i]]; data[i + 1] = lut[data[i + 1]]; data[i + 2] = lut[data[i + 2]]; }
  return true;
}
// Sharpness: mean absolute 4-neighbour Laplacian, divided by mean brightness so a dark photo is not
// called blurry for being dark. A number, not a verdict — the UI only uses it to say "this one is
// soft", never to refuse a photo.
function rxFocusScore(data, w, h){
  var sum = 0, lum = 0, n = 0, x, y, i, c;
  var L = new Float32Array(w * h);
  for(i = 0, c = 0; i < data.length; i += 4, c++) L[c] = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
  for(y = 1; y < h - 1; y++){
    for(x = 1; x < w - 1; x++){
      c = y * w + x;
      sum += Math.abs(4 * L[c] - L[c - 1] - L[c + 1] - L[c - w] - L[c + w]);
      lum += L[c]; n++;
    }
  }
  if(!n || lum <= 0) return 0;
  return (sum / n) / ((lum / n) / 100);
}

/* One photo + one frame → { dataUrl, canvas, quality }. This is the only function the rest of the app
   needs from this file. */
function rxRenderFace(src, frame, opts){
  var o = opts || {}, size = o.size || RX_OUT_PX;
  var canvas = rxDrawFrame(src, frame, size);
  var ctx = canvas.getContext('2d');
  var img = ctx.getImageData(0, 0, size, size);
  var bounds = rxStretchBounds(rxLumaHist(img.data), size * size, RX_STRETCH_LO, RX_STRETCH_HI);
  var stretched = rxApplyStretch(img.data, bounds.lo, bounds.hi);
  if(stretched) ctx.putImageData(img, 0, 0);
  var focus = rxFocusScore(img.data, size, size);
  return {
    canvas: canvas,
    dataUrl: canvas.toDataURL('image/jpeg', o.quality || RX_JPEG_Q),
    quality: rxQuality(frame, focus)
  };
}

/* ---- 4. is this worth comparing? ---- */
function rxQuality(frame, focus){
  var warnings = [];
  if(frame.size < RX_MIN_FACE_PX) warnings.push('The head is only about ' + Math.round(frame.size) + ' pixels across — detail like an eyelid fold or a nose bridge is not really there. A closer or larger photo compares much better.');
  if(focus < RX_FOCUS_MIN) warnings.push('This one looks soft or motion-blurred. A sharper photo will give a steadier answer.');
  return { facePx: Math.round(frame.size), focus: Math.round(focus * 10) / 10, warnings: warnings, ok: warnings.length === 0 };
}

if(typeof module !== 'undefined' && module.exports){
  module.exports = { RX_OUT_PX: RX_OUT_PX, RX_MIN_FACE_PX: RX_MIN_FACE_PX, RX_FOCUS_MIN: RX_FOCUS_MIN,
    RX_MAX_GAIN: RX_MAX_GAIN, rxDefaultFrame: rxDefaultFrame, rxClampFrame: rxClampFrame, rxBoxToFrame: rxBoxToFrame,
    rxEyeAngle: rxEyeAngle, rxLumaHist: rxLumaHist, rxStretchBounds: rxStretchBounds, rxApplyStretch: rxApplyStretch,
    rxFocusScore: rxFocusScore, rxQuality: rxQuality };
}
