/* measure.js — from a face mesh to a number per feature. Pure maths: no DOM, no network, no model.
   Give it 478 landmarks and it gives back ~35 measurements; give it two sets and it tells you how
   close they are, feature by feature.

   WHY MEASUREMENTS AND NOT AN OPINION. "Does she have his nose?" can be answered by asking something
   clever, or by measuring the nose. Measuring is worse at prose and better at everything else: it is
   deterministic (the same photos always give the same answer), it can show its working, it costs
   nothing, it needs no key, and it never gets talked round by which photo came first or by a file
   called "dad.jpg".

   THE FRAME. Every measurement is taken after the face has been put in a standard pose:
     • rotated so the line between the two iris centres is horizontal (undoes head tilt),
     • scaled so that line is exactly 1 unit long (undoes distance from the camera and, largely, the
       difference between a child's head and an adult's — it is the ratios we are after),
     • centred between the eyes.
   So "alar_width: 0.62" means the nose is 0.62 as wide as the gap between the pupils. That is a
   number you can compare across two people, two cameras and twenty years.

   WHAT IT WILL NOT MEASURE. Ears and hairline are not in the mesh — a face mesh stops at the face —
   so they are not scored, rather than being guessed at. Anything that moves with expression (a smile
   widens the mouth, a raised brow lifts the brow line) is tagged with the blendshapes that disturb
   it, and is dropped from the comparison when either face is pulling that expression.

   Landmark indices below were checked against real photographs rather than taken on trust: outer
   canthus left of inner, brow above lid, subnasale below tip, chin the lowest point, and so on. */

/* ---- the mesh points we use, by name ---- */
var RX_P = {
  irisL:468, irisR:473,
  eyeLouter:33, eyeLinner:133, eyeRinner:362, eyeRouter:263,
  lidLup:159, lidLlow:145, lidRup:386, lidRlow:374,
  browLout:70, browLmid:105, browLin:107, browRin:336, browRmid:334, browRout:300,
  nasion:168, noseTip:1, subnasale:2, alarL:129, alarR:358, nostrilL:98, nostrilR:327,
  mouthL:61, mouthR:291, lipUpTop:0, lipUpIn:13, lipLowIn:14, lipLowBot:17,
  forehead:10, chin:152, chinL:148, chinR:377,
  faceL:234, faceR:454, jawL:172, jawR:397, cheekL:116, cheekR:345
};

/* ---- 1. put the face in the standard pose ----
   Landmarks arrive normalised to the image: x is a fraction of the width, y a fraction of the
   height. On a non-square image those are different units, so the first thing to do is get back to
   pixels — skipping this quietly stretches every face measured on a portrait-shaped photo. */
function rxAlign(pts, w, h){
  var i, p, P = new Array(pts.length);
  for(i = 0; i < pts.length; i++){ p = pts[i]; P[i] = [p[0] * w, p[1] * h, (p[2] || 0) * w]; }
  var a = P[RX_P.irisL], b = P[RX_P.irisR];
  var cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2, cz = (a[2] + b[2]) / 2;
  var dx = b[0] - a[0], dy = b[1] - a[1];
  var iod = Math.hypot(dx, dy);
  if(!(iod > 1e-6)) return null;
  var th = Math.atan2(dy, dx), cos = Math.cos(-th), sin = Math.sin(-th);
  var out = new Array(P.length), X, Y;
  for(i = 0; i < P.length; i++){
    X = P[i][0] - cx; Y = P[i][1] - cy;
    out[i] = [(X * cos - Y * sin) / iod, (X * sin + Y * cos) / iod, (P[i][2] - cz) / iod];
  }
  out.iod = iod;
  return out;
}

function rxDist(P, a, b){ return Math.hypot(P[a][0] - P[b][0], P[a][1] - P[b][1]); }
/* How far the `outer` point sits ABOVE the `inner` one, as an angle. Written as a rise over an
   absolute run so the subject's two sides — whose vectors point in opposite directions along x —
   give the same sign for the same tilt, and average instead of cancelling. */
function rxTilt(P, inner, outer){
  var run = Math.abs(P[outer][0] - P[inner][0]);
  if(run < 1e-9) return 0;
  return Math.atan2(P[inner][1] - P[outer][1], run) * 180 / Math.PI;
}
// Interior angle at `v` between the rays to `a` and `b`, in degrees.
function rxAngleAt(P, v, a, b){
  var ax = P[a][0] - P[v][0], ay = P[a][1] - P[v][1], bx = P[b][0] - P[v][0], by = P[b][1] - P[v][1];
  var d = Math.hypot(ax, ay) * Math.hypot(bx, by);
  if(d < 1e-9) return 0;
  return Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / d))) * 180 / Math.PI;
}

/* ---- 2. the measurements ----
   `tol` is the difference at which a measurement scores about 37 out of 100 — the scale on which
   "that is a different nose" starts to mean something. These remain a stated convention.

   `w` IS NOT A CONVENTION ANY MORE. Every weight below is measured, not chosen: each one is
   proportional to how well that measurement separates 849 real parent/child pairs from the same
   number of unrelated pairs, on the KinFaceW-II kinship dataset (Lu et al., PAMI 2014). See
   tools/README-calibration.md.

   The first version of this file guessed these weights, reasoning that bone structure survives
   childhood and colouring is what a camera gets wrong. Measured against real families, that guess
   correlated with the truth at 0.09 — no better than picking numbers out of the air, and backwards
   in its central claim. Colouring is the strongest family signal there is here; the carefully
   reasoned bone-structure ratios are the weakest. Half the colour signal turned out to be shared
   photograph lighting (the dataset crops parent and child from one picture), which is why faces are
   now white-balanced individually before colour is read — but the half that survives that still
   beats every geometric measurement.

   `expr` lists the blendshapes that move a measurement. If either face is pulling one hard, the
   measurement is not comparable and is dropped rather than believed. */
var RX_MEASURES = [
  // eyes
  { key:'eye_width',    feature:'eyes',   label:'eye width',            tol:0.055, w:0.57 },
  { key:'intercanthal', feature:'eyes',   label:'gap between the eyes', tol:0.070, w:0.31 },
  { key:'eye_open',     feature:'eyes',   label:'eye opening',          tol:0.085, w:1.13, expr:['eyeBlinkLeft','eyeBlinkRight','eyeSquintLeft','eyeSquintRight','eyeWideLeft','eyeWideRight'] },
  { key:'canthal_tilt', feature:'eyes',   label:'tilt of the eye',      tol:4.0,   w:0.56, deg:true },
  // brows
  { key:'brow_lift',    feature:'brows',  label:'brow height',          tol:0.070, w:0.54, expr:['browDownLeft','browDownRight','browInnerUp','browOuterUpLeft','browOuterUpRight'] },
  { key:'brow_gap',     feature:'brows',  label:'gap between the brows',tol:0.075, w:0.27 },
  { key:'brow_peak',    feature:'brows',  label:'where the brow arches',tol:0.090, w:0.65 },
  { key:'brow_tilt',    feature:'brows',  label:'brow angle',           tol:5.0,   w:0.41, deg:true, expr:['browDownLeft','browDownRight','browInnerUp'] },
  // nose
  { key:'alar_width',   feature:'nose',   label:'width of the nose',    tol:0.055, w:0.65 },
  { key:'nose_len',     feature:'nose',   label:'length of the nose',   tol:0.070, w:0.31 },
  { key:'nose_wl',      feature:'nose',   label:'nose width vs length', tol:0.075, w:0.82 },
  { key:'nostril_w',    feature:'nose',   label:'nostril spread',       tol:0.070, w:0.28 },
  { key:'tip_proj',     feature:'nose',   label:'how far the tip juts', tol:0.090, w:0.29 },
  // mouth
  { key:'mouth_w',      feature:'mouth',  label:'mouth width',          tol:0.070, w:1.14, expr:['mouthSmileLeft','mouthSmileRight','mouthPucker','mouthFunnel'] },
  { key:'lip_upper',    feature:'mouth',  label:'upper lip',            tol:0.040, w:0.63, expr:['jawOpen','mouthPucker','mouthFunnel'] },
  { key:'lip_lower',    feature:'mouth',  label:'lower lip',            tol:0.045, w:0.54, expr:['jawOpen','mouthPucker','mouthFunnel'] },
  { key:'lip_balance',  feature:'mouth',  label:'upper vs lower lip',   tol:0.130, w:0.50, expr:['jawOpen','mouthPucker'] },
  { key:'philtrum',     feature:'mouth',  label:'philtrum length',      tol:0.055, w:0.32 },
  // cheeks and midface
  { key:'cheek_w',      feature:'cheeks', label:'cheekbone width',      tol:0.085, w:0.60 },
  { key:'cheek_drop',   feature:'cheeks', label:'cheekbone height',     tol:0.080, w:0.43 },
  { key:'midface',      feature:'cheeks', label:'midface depth',        tol:0.075, w:0.28 },
  // jaw and chin
  { key:'bigonial',     feature:'jaw',    label:'jaw width',            tol:0.090, w:0.59, expr:['jawOpen'] },
  { key:'taper',        feature:'jaw',    label:'jaw vs cheekbone',     tol:0.070, w:0.36, expr:['jawOpen'] },
  { key:'chin_h',       feature:'jaw',    label:'chin height',          tol:0.065, w:0.70, expr:['jawOpen'] },
  { key:'chin_w',       feature:'jaw',    label:'chin width',           tol:0.065, w:0.39 },
  { key:'gonial',       feature:'jaw',    label:'angle of the jaw',     tol:6.0,   w:0.27, deg:true, expr:['jawOpen'] },
  // overall shape
  { key:'face_w',       feature:'shape',  label:'face width',           tol:0.100, w:0.59 },
  { key:'face_h',       feature:'shape',  label:'face height',          tol:0.110, w:0.34, expr:['jawOpen'] },
  { key:'face_wh',      feature:'shape',  label:'face width vs height', tol:0.070, w:0.38, expr:['jawOpen'] },
  { key:'third_up',     feature:'shape',  label:'forehead share',       tol:0.045, w:0.37 },
  { key:'third_mid',    feature:'shape',  label:'midface share',        tol:0.040, w:0.52 },
  { key:'third_low',    feature:'shape',  label:'lower-face share',     tol:0.045, w:0.38, expr:['jawOpen'] },
  { key:'forehead_w',   feature:'shape',  label:'forehead width',       tol:0.085, w:0.53 },
  // colouring — sampled from the picture, not from the mesh (see rxSampleColours in mesh.js)
  { key:'skin_L',       feature:'colour', label:'skin lightness',       tol:11.0,  w:1.13 },
  { key:'skin_a',       feature:'colour', label:'skin warmth',          tol:3.5,   w:1.12 },
  { key:'skin_b',       feature:'colour', label:'skin tone',            tol:4.5,   w:1.31 },
  { key:'eye_L',        feature:'colour', label:'eye lightness',        tol:13.0,  w:1.26 },
  { key:'eye_a',        feature:'colour', label:'eye colour (green–red)', tol:3.0, w:1.68 },
  { key:'eye_b',        feature:'colour', label:'eye colour (blue–yellow)', tol:4.0, w:1.41 }
];
var RX_MEASURE_BY_KEY = {};
RX_MEASURES.forEach(function(m){ RX_MEASURE_BY_KEY[m.key] = m; });

/* ---- how unusual is the thing they share? ----
   Human face perception is norm-based: a face is encoded as its departure from an average, and a
   shared trait counts for as much as it is unusual. Two people with ordinary noses both having an
   ordinary nose is not evidence of anything — most people have one. Two people sharing a distinctly
   narrow bridge is.

   The app scored every match the same until this. Tested on 836 real parent/child pairs against the
   same stranger pairing, weighting each measurement by how far the shared value sits from the
   population norm lifts kin-vs-stranger AUC from 0.726 to 0.739 — +0.013, 95% CI [0.007, 0.016] on
   a paired bootstrap. Small, but real and in the direction the perception literature predicts.

   The norms below are the median and a robust spread (half the 16th-to-84th percentile range, so one
   odd face in the benchmark cannot set the standard for everybody) over 1816 measured faces. They
   describe that benchmark, not humanity — a limitation, and the reason the multiplier is modest. */
var RX_POP = {"eye_width":{"mu":0.4189,"sd":0.0186},"intercanthal":{"mu":0.5509,"sd":0.025},"eye_open":{"mu":0.3332,"sd":0.085},"canthal_tilt":{"mu":4.5145,"sd":3.0391},"brow_lift":{"mu":0.2695,"sd":0.0516},"brow_gap":{"mu":0.4818,"sd":0.024},"brow_peak":{"mu":0.3494,"sd":0.0128},"brow_tilt":{"mu":-6.4239,"sd":4.4487},"alar_width":{"mu":0.651,"sd":0.0477},"nose_len":{"mu":0.7315,"sd":0.0658},"nose_wl":{"mu":0.8906,"sd":0.0988},"nostril_w":{"mu":0.8261,"sd":0.0226},"tip_proj":{"mu":0.2802,"sd":0.0969},"mouth_w":{"mu":0.8981,"sd":0.1344},"lip_upper":{"mu":0.0808,"sd":0.0213},"lip_lower":{"mu":0.1437,"sd":0.023},"lip_balance":{"mu":0.5762,"sd":0.1144},"philtrum":{"mu":0.203,"sd":0.0398},"cheek_w":{"mu":1.9523,"sd":0.0708},"cheek_drop":{"mu":0.23,"sd":0.0266},"midface":{"mu":0.731,"sd":0.0666},"bigonial":{"mu":1.7666,"sd":0.0983},"taper":{"mu":0.8303,"sd":0.0245},"chin_h":{"mu":0.3824,"sd":0.08},"chin_w":{"mu":0.4174,"sd":0.0288},"gonial":{"mu":133.0464,"sd":4.9964},"face_w":{"mu":2.1259,"sd":0.0952},"face_h":{"mu":2.3358,"sd":0.1297},"face_wh":{"mu":0.9091,"sd":0.0507},"third_up":{"mu":0.289,"sd":0.019},"third_mid":{"mu":0.3129,"sd":0.0232},"third_low":{"mu":0.3981,"sd":0.0376},"forehead_w":{"mu":1.7834,"sd":0.0578},"skin_L":{"mu":81.3546,"sd":14.2623},"skin_a":{"mu":-1.4558,"sd":6.1289},"skin_b":{"mu":-3.7452,"sd":6.5107},"eye_L":{"mu":24.0122,"sd":18.6547},"eye_a":{"mu":5.711,"sd":6.6183},"eye_b":{"mu":4.809,"sd":6.8597}};
var RX_RARITY = 2.0;   // higher scored marginally better still, but this takes nearly all of the gain

/* The weight a measurement carries for THIS pair: its base weight, raised by how far the value they
   share sits from the norm. The milder of the two departures is used, which is the conservative
   reading — a match is only as rare as its least unusual half. */
function rxRarityWeight(m, a, b){
  var pop = RX_POP[m.key];
  if(!pop || !pop.sd) return m.w;
  var za = Math.abs((a - pop.mu) / pop.sd), zb = Math.abs((b - pop.mu) / pop.sd);
  return m.w * (1 + RX_RARITY * Math.min(za, zb));
}
/* Per-measurement weights for one comparison, in the same shape the roll-up expects. */
function rxWeights(child, adult, blocked){
  var out = {};
  RX_MEASURES.forEach(function(m){
    var a = child[m.key], b = adult[m.key];
    if(typeof a !== 'number' || typeof b !== 'number' || !isFinite(a) || !isFinite(b) ||
       (blocked && blocked[m.key])){ out[m.key] = 0; return; }
    out[m.key] = rxRarityWeight(m, a, b);
  });
  return out;
}

/* ---- things worn on a face, and what they cost to work around ----

   You cannot remove a cap from a photograph. Anything that claims to is a model INVENTING a
   forehead, and measuring an invention is how this app got into trouble before. What can be done is
   route around it: leave out the measurements the thing corrupts, and say so.

   Whether that is worth doing was measured, not assumed — on 849 real parent/child pairs, dropping
   each group and re-scoring against an identical set of stranger pairs, with a paired bootstrap for
   the confidence interval (see tools/README-calibration.md):

     hat / hair over forehead   +0.001  [-0.001, +0.004]   free
     beard                      +0.006  [+0.002, +0.010]   free (slightly better without it)
     lipstick                   -0.006  [-0.011, +0.000]   free
     eye make-up / glasses      -0.002  [-0.006, +0.002]   free
     foundation (skin colour)   -0.027                     real cost
     coloured contacts          -0.044                     real cost

   So almost everything is free to leave out, which is why these are tick boxes rather than clever
   detectors: a detector can be wrong, and a tick box that costs nothing cannot. The two that DO cost
   something are colour, and the app says so out loud when you tick them, because losing colour is
   losing the strongest family signal it has. */
var RX_OCCLUDERS = [
  { id:'glasses',    label:'Glasses',            blocks:['eye_width','eye_open','canthal_tilt'], cost:0.002 },
  { id:'hat',        label:'Hat or fringe',      blocks:['third_up','face_h','face_wh','forehead_w'], cost:0 },
  { id:'beard',      label:'Beard or stubble',   blocks:['bigonial','taper','chin_h','chin_w','gonial'], cost:0 },
  { id:'lipstick',   label:'Lipstick',           blocks:['lip_upper','lip_lower','lip_balance','mouth_w'], cost:0.006 },
  { id:'eyemakeup',  label:'Eye make-up',        blocks:['eye_width','eye_open','canthal_tilt'], cost:0.002 },
  { id:'foundation', label:'Foundation',         blocks:['skin_L','skin_a','skin_b'], cost:0.027, costly:true },
  { id:'contacts',   label:'Coloured lenses',    blocks:['eye_L','eye_a','eye_b'], cost:0.044, costly:true }
];
var RX_OCCLUDER_BY_ID = {};
RX_OCCLUDERS.forEach(function(o){ RX_OCCLUDER_BY_ID[o.id] = o; });

/* Ticked boxes → the measurements to leave out, in the same shape rxCompare expects for expressions,
   so the two merge without either knowing about the other. */
function rxOccluderBlocks(ids){
  var out = {}, reasons = [];
  (ids || []).forEach(function(id){
    var o = RX_OCCLUDER_BY_ID[id];
    if(!o) return;
    reasons.push(o.id);
    o.blocks.forEach(function(k){ out[k] = true; });
  });
  out.__worn = reasons;
  return out;
}
/* Merge two block maps (one from expressions, one from what is worn). */
function rxMergeBlocks(a, b){
  var out = {}, k;
  for(k in (a || {})) if(k.slice(0, 2) !== '__') out[k] = true;
  for(k in (b || {})) if(k.slice(0, 2) !== '__') out[k] = true;
  out.__reasons = ((a && a.__reasons) || []).concat((b && b.__reasons) || []);
  out.__worn = ((a && a.__worn) || []).concat((b && b.__worn) || []);
  return out;
}

/* Landmarks → the numbers. Returns null when the mesh cannot be put in the standard pose (which in
   practice means no iris was found, and nothing downstream should be attempted). */
function rxMeasure(pts, w, h){
  var P = rxAlign(pts, w, h);
  if(!P) return null;
  var K = RX_P, v = {};

  // eyes
  v.eye_width = (rxDist(P, K.eyeLouter, K.eyeLinner) + rxDist(P, K.eyeRinner, K.eyeRouter)) / 2;
  v.intercanthal = rxDist(P, K.eyeLinner, K.eyeRinner);
  v.eye_open = ((rxDist(P, K.lidLup, K.lidLlow) + rxDist(P, K.lidRup, K.lidRlow)) / 2) / Math.max(v.eye_width, 1e-6);
  // Outer corner above inner reads as a positive (upward) tilt on both sides, so the two mirror
  // images average instead of cancelling.
  v.canthal_tilt = (rxTilt(P, K.eyeLinner, K.eyeLouter) + rxTilt(P, K.eyeRinner, K.eyeRouter)) / 2;

  // brows
  v.brow_lift = ((P[K.lidLup][1] - P[K.browLmid][1]) + (P[K.lidRup][1] - P[K.browRmid][1])) / 2;
  v.brow_gap = rxDist(P, K.browLin, K.browRin);
  v.brow_peak = (rxFrac(P, K.browLmid, K.browLout, K.browLin) + rxFrac(P, K.browRmid, K.browRout, K.browRin)) / 2;
  v.brow_tilt = (rxTilt(P, K.browLin, K.browLout) + rxTilt(P, K.browRin, K.browRout)) / 2;

  // nose
  v.alar_width = rxDist(P, K.alarL, K.alarR);
  v.nose_len = rxDist(P, K.nasion, K.subnasale);
  v.nose_wl = v.alar_width / Math.max(v.nose_len, 1e-6);
  v.nostril_w = rxDist(P, K.nostrilL, K.nostrilR) / Math.max(v.alar_width, 1e-6);
  v.tip_proj = P[K.nasion][2] - P[K.noseTip][2];

  // mouth
  v.mouth_w = rxDist(P, K.mouthL, K.mouthR);
  v.lip_upper = Math.abs(P[K.lipUpIn][1] - P[K.lipUpTop][1]);
  v.lip_lower = Math.abs(P[K.lipLowBot][1] - P[K.lipLowIn][1]);
  v.lip_balance = v.lip_upper / Math.max(v.lip_lower, 1e-6);
  v.philtrum = Math.abs(P[K.lipUpTop][1] - P[K.subnasale][1]);

  // cheeks and midface
  v.cheek_w = rxDist(P, K.cheekL, K.cheekR);
  v.cheek_drop = ((P[K.cheekL][1] - P[K.eyeLouter][1]) + (P[K.cheekR][1] - P[K.eyeRouter][1])) / 2;
  v.midface = P[K.subnasale][1] - P[K.nasion][1];

  // jaw and chin
  v.bigonial = rxDist(P, K.jawL, K.jawR);
  // Jaw width against face width: the difference between a square face and a heart-shaped one.
  v.taper = v.bigonial / Math.max(rxDist(P, K.faceL, K.faceR), 1e-6);
  v.chin_h = P[K.chin][1] - P[K.lipLowBot][1];
  v.chin_w = rxDist(P, K.chinL, K.chinR);
  v.gonial = (rxAngleAt(P, K.jawL, K.faceL, K.chin) + rxAngleAt(P, K.jawR, K.faceR, K.chin)) / 2;

  // overall shape
  v.face_w = rxDist(P, K.faceL, K.faceR);
  v.face_h = P[K.chin][1] - P[K.forehead][1];
  v.face_wh = v.face_w / Math.max(v.face_h, 1e-6);
  v.third_up = (P[K.nasion][1] - P[K.forehead][1]) / Math.max(v.face_h, 1e-6);
  v.third_mid = (P[K.subnasale][1] - P[K.nasion][1]) / Math.max(v.face_h, 1e-6);
  v.third_low = (P[K.chin][1] - P[K.subnasale][1]) / Math.max(v.face_h, 1e-6);
  v.forehead_w = rxDist(P, K.browLout, K.browRout);

  return v;
}
// Where `p` sits along the line from `a` to `b`, as a fraction — used for "where does the brow peak".
function rxFrac(P, p, a, b){
  var d = P[b][0] - P[a][0];
  if(Math.abs(d) < 1e-9) return 0.5;
  return (P[p][0] - P[a][0]) / d;
}

/* ---- 3. two faces → a score per measurement ----
   exp(−|difference| ÷ tol): 0 difference is 100, a difference of one tol is 37, two is 14. A smooth
   curve rather than a threshold, so a measurement never flips a verdict by moving a hair. */
function rxScore(diff, tol){ return 100 * Math.exp(-Math.abs(diff) / tol); }

/* Compare a child's measurements against one adult's. `blocked` is the set of measurement keys ruled
   out because one of the two faces was pulling an expression that moves them. Returns a score per
   measurement (null where blocked or unavailable) — the per-feature roll-up happens in resemble.js,
   which is also where several jittered readings get averaged. */
function rxCompare(child, adult, blocked){
  var out = {};
  RX_MEASURES.forEach(function(m){
    var a = child[m.key], b = adult[m.key];
    if(typeof a !== 'number' || typeof b !== 'number' || !isFinite(a) || !isFinite(b) ||
       (blocked && blocked[m.key])){ out[m.key] = null; return; }
    out[m.key] = rxScore(a - b, m.tol);
  });
  return out;
}

/* Which measurements to leave out because a face is mid-expression. Given both faces' blendshape
   maps, any measurement whose `expr` list is triggered above `level` in EITHER face is blocked. A
   grin genuinely changes the mouth, so a grin makes the mouth unmeasurable — not merely noisier. */
var RX_EXPR_LEVEL = 0.35;
function rxBlocked(shapesA, shapesB, level){
  var lim = typeof level === 'number' ? level : RX_EXPR_LEVEL, out = {}, hit = {};
  RX_MEASURES.forEach(function(m){
    if(!m.expr) return;
    for(var i = 0; i < m.expr.length; i++){
      var name = m.expr[i];
      var v = Math.max((shapesA && shapesA[name]) || 0, (shapesB && shapesB[name]) || 0);
      if(v >= lim){ out[m.key] = true; hit[name] = Math.max(hit[name] || 0, v); }
    }
  });
  out.__reasons = Object.keys(hit);
  return out;
}

/* Head pose from the 4×4 facial transformation matrix (column-major, as MediaPipe supplies it).
   Yaw is the one that matters: a face turned away foreshortens every width measurement on one side,
   which is exactly the kind of error that looks like a real difference. */
function rxPose(matrix){
  if(!matrix || matrix.length < 16) return null;
  var m = matrix;                                  // m[col*4 + row]
  var yaw = Math.atan2(-m[2], Math.hypot(m[6], m[10]));
  var pitch = Math.atan2(m[6], m[10]);
  var roll = Math.atan2(m[1], m[0]);
  var d = 180 / Math.PI;
  return { yaw: yaw * d, pitch: pitch * d, roll: roll * d };
}

if(typeof module !== 'undefined' && module.exports){
  module.exports = { RX_P: RX_P, RX_MEASURES: RX_MEASURES, RX_MEASURE_BY_KEY: RX_MEASURE_BY_KEY,
    RX_OCCLUDERS: RX_OCCLUDERS, RX_OCCLUDER_BY_ID: RX_OCCLUDER_BY_ID, RX_POP: RX_POP,
    RX_RARITY: RX_RARITY, rxRarityWeight: rxRarityWeight, rxWeights: rxWeights,
    rxOccluderBlocks: rxOccluderBlocks, rxMergeBlocks: rxMergeBlocks,
    RX_EXPR_LEVEL: RX_EXPR_LEVEL, rxAlign: rxAlign, rxMeasure: rxMeasure, rxScore: rxScore,
    rxCompare: rxCompare, rxBlocked: rxBlocked, rxPose: rxPose };
}
