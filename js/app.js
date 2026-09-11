/* app.js — the page. Cards, dragging, the comparison run, and how the answer is presented.
   Loaded last; uses faces.js (crop and prepare), mesh.js (find the face, read colour),
   measure.js (the geometry) and resemble.js (the scoring).

   Three things here are deliberate rather than incidental:

   • The frame is editable, always. The mesh proposes it, but a bad crop is the easiest way to get a
     confidently wrong result, so the crop is the first thing the interface hands you rather than
     something buried in a settings panel. What you see in the square is exactly what gets measured,
     exposure correction and all.
   • Uncertainty is shown, not smoothed. A 2-point gap is drawn as a 2-point gap and described as a
     mix. A feature that moved between readings says so. A feature nobody could measure says that
     too. It would be more satisfying to always crown a winner, and it would be a lie most of the
     time.
   • Nothing leaves the device, so nothing needs a spinner that says "uploading". The one honest
     delay is the first load of the mesh, and that is shown as what it is: a progress bar with a size
     on it. */

var RX_PREVIEW_PX = 260;
var RX_MAX_PEOPLE = 6;
var RX_NAME_IDEAS = ['Mum', 'Dad', 'Grandma', 'Grandad', 'Auntie', 'Uncle'];
var RX_TONES = ['tone-a', 'tone-b', 'tone-c', 'tone-d', 'tone-e', 'tone-f'];
/* Each reading re-crops slightly differently. Landmark detection is not perfectly repeatable, so
   what moves between these is measurement noise — which is exactly what we want to see. */
var RX_JITTER = [1.0, 0.94, 1.07];

var rxChild = null;
var rxPeople = [];
var rxSeq = 0;
var rxBusy = false;
var rxLastRun = null;

/* ============================ cards ============================ */

function rxNewCard(kind, name){
  return { id: 'c' + (++rxSeq), kind: kind, name: name || '', src: null, frame: null,
           quality: null, faces: 0, pose: null, el: null, els: {}, raf: 0 };
}

function rxBuildCard(card, index){
  var el = document.createElement('article');
  el.className = 'card' + (card.kind === 'child' ? ' card-child' : '');
  el.dataset.id = card.id;
  el.innerHTML =
    '<div class="card-head">' +
      '<input class="name-in" type="text" maxlength="24" ' +
        'placeholder="' + (card.kind === 'child' ? 'The little one' : (RX_NAME_IDEAS[index] || 'Name')) + '" ' +
        'aria-label="' + (card.kind === 'child' ? 'Name of the child' : 'Name of this person') + '">' +
      (card.kind === 'child' ? '' : '<button type="button" class="x" title="Remove this person" aria-label="Remove this person">×</button>') +
    '</div>' +
    '<div class="frame" tabindex="0" role="button" aria-label="Photo frame — tap to choose a photo, drag to move the face">' +
      '<canvas class="preview" width="' + RX_PREVIEW_PX + '" height="' + RX_PREVIEW_PX + '"></canvas>' +
      '<div class="empty"><span class="plus">+</span><span>Add a photo</span></div>' +
      '<div class="guide" aria-hidden="true"></div>' +
    '</div>' +
    '<input type="file" class="file" accept="image/*" hidden>' +
    '<div class="tools" hidden>' +
      '<input type="range" class="zoom" min="0" max="100" value="40" aria-label="Zoom">' +
      '<div class="tool-row">' +
        '<button type="button" class="tiny rot" data-d="-1" title="Tilt left" aria-label="Tilt left">⟲</button>' +
        '<button type="button" class="tiny rot" data-d="1" title="Tilt right" aria-label="Tilt right">⟳</button>' +
        '<button type="button" class="tiny auto">Find the face</button>' +
        '<button type="button" class="tiny change">Change photo</button>' +
      '</div>' +
      '<fieldset class="worn">' +
        '<legend>Anything worn in this photo?</legend>' +
        RX_OCCLUDERS.map(function(o){
          return '<label class="chip' + (o.costly ? ' chip-costly' : '') + '">' +
                 '<input type="checkbox" value="' + o.id + '"><span>' + o.label + '</span></label>';
        }).join('') +
      '</fieldset>' +
    '</div>' +
    '<p class="ready" hidden></p>' +
    '<p class="warn" hidden></p>';

  card.el = el;
  card.els = {
    name: el.querySelector('.name-in'), frame: el.querySelector('.frame'), canvas: el.querySelector('.preview'),
    empty: el.querySelector('.empty'), file: el.querySelector('.file'), tools: el.querySelector('.tools'),
    zoom: el.querySelector('.zoom'), warn: el.querySelector('.warn'), remove: el.querySelector('.x'),
    ready: el.querySelector('.ready'), worn: el.querySelector('.worn')
  };
  card.worn = [];
  Array.prototype.forEach.call(card.els.worn.querySelectorAll('input'), function(box){
    box.addEventListener('change', function(){
      card.worn = Array.prototype.filter.call(card.els.worn.querySelectorAll('input'), function(b){ return b.checked; })
                       .map(function(b){ return b.value; });
      rxShowWarnings(card);
    });
  });
  if(card.name) card.els.name.value = card.name;

  card.els.name.addEventListener('input', function(){ card.name = card.els.name.value.trim(); });
  card.els.file.addEventListener('change', function(){
    var f = card.els.file.files && card.els.file.files[0];
    if(f) rxLoadPhoto(card, f);
    card.els.file.value = '';
  });
  card.els.frame.addEventListener('click', function(e){
    if(card.src || e.target.closest('.tools')) return;
    card.els.file.click();
  });
  card.els.frame.addEventListener('keydown', function(e){
    if(!card.src && (e.key === 'Enter' || e.key === ' ')){ e.preventDefault(); card.els.file.click(); }
  });
  el.querySelector('.change').addEventListener('click', function(){ card.els.file.click(); });
  el.querySelector('.auto').addEventListener('click', function(){ rxAutoFrameCard(card); });
  Array.prototype.forEach.call(el.querySelectorAll('.rot'), function(b){
    b.addEventListener('click', function(){
      if(!card.frame) return;
      card.frame.angle = (card.frame.angle || 0) + (parseFloat(b.dataset.d) * Math.PI / 120); // 1.5°
      rxPreview(card);
    });
  });
  card.els.zoom.addEventListener('input', function(){ rxZoomTo(card, parseFloat(card.els.zoom.value)); });
  if(card.els.remove) card.els.remove.addEventListener('click', function(){ rxRemovePerson(card); });

  rxDragging(card);
  return el;
}

/* Drag to move the face, pinch or wheel to zoom. The frame lives in source-image pixels, so a drag
   of N screen pixels moves the crop by N × (frame size ÷ on-screen size) — which is what keeps the
   face under your finger at every zoom level. */
function rxDragging(card){
  var pts = new Map(), start = null, pinch = null;
  var f = card.els.frame;
  function scale(){ return card.frame ? card.frame.size / f.getBoundingClientRect().width : 1; }

  f.addEventListener('pointerdown', function(e){
    if(!card.src) return;
    f.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if(pts.size === 1) start = { x: e.clientX, y: e.clientY, cx: card.frame.cx, cy: card.frame.cy };
    if(pts.size === 2){
      var a = Array.from(pts.values());
      pinch = { d: Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y), size: card.frame.size };
      start = null;
    }
    f.classList.add('grabbing');
  });
  f.addEventListener('pointermove', function(e){
    if(!card.src || !pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if(pinch && pts.size === 2){
      var a = Array.from(pts.values()), d = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y);
      if(d > 4) rxSetSize(card, pinch.size * (pinch.d / d));
      return;
    }
    if(!start) return;
    var k = scale();
    card.frame = rxClampFrame({ cx: start.cx - (e.clientX - start.x) * k, cy: start.cy - (e.clientY - start.y) * k,
                                size: card.frame.size, angle: card.frame.angle }, card.dims.w, card.dims.h);
    rxPreview(card);
  });
  ['pointerup', 'pointercancel'].forEach(function(t){
    f.addEventListener(t, function(e){
      pts.delete(e.pointerId);
      if(pts.size < 2) pinch = null;
      if(!pts.size){ start = null; f.classList.remove('grabbing'); }
    });
  });
  f.addEventListener('wheel', function(e){
    if(!card.src) return;
    e.preventDefault();
    rxSetSize(card, card.frame.size * (e.deltaY > 0 ? 1.06 : 0.94));
  }, { passive: false });
}

function rxZoomTo(card, v){
  if(!card.src) return;
  rxSetSize(card, Math.min(card.dims.w, card.dims.h) * (1 - 0.82 * (v / 100)));
}
function rxSetSize(card, size){
  if(!card.src) return;
  card.frame = rxClampFrame({ cx: card.frame.cx, cy: card.frame.cy, size: size, angle: card.frame.angle },
                            card.dims.w, card.dims.h);
  rxSyncZoom(card);
  rxPreview(card);
}
function rxSyncZoom(card){
  card.els.zoom.value = String(Math.round(((1 - card.frame.size / Math.min(card.dims.w, card.dims.h)) / 0.82) * 100));
}

/* ============================ photos ============================ */

async function rxLoadPhoto(card, file){
  rxStatus('');
  try{
    card.src = await rxDecode(file);
    card.dims = rxDims(card.src);
    card.frame = rxDefaultFrame(card.dims.w, card.dims.h);
    card.els.empty.hidden = true;
    card.els.tools.hidden = false;
    card.els.frame.classList.add('has-photo');
    rxPreview(card);
    await rxAutoFrameCard(card, true);
  }catch(e){
    card.src = null;
    rxStatus(e.message || 'That photo could not be opened.', 'bad');
  }
  rxRefreshCompare();
}

/* Load the mesh if it is not here yet, then let it find the head. The first call is the one that
   downloads sixteen megabytes, so it reports itself; every call after it is instant. */
async function rxEnsureMesh(){
  return rxLoadMesh(function(frac, label){
    if(frac >= 1){ rxStatus(''); rxProgress(-1); return; }
    rxStatus(label);
    rxProgress(frac);
  });
}

/* The recognition model is loaded only when a comparison is actually run — framing photos needs the
   mesh alone, so there is no reason to make someone wait for 25 MB before they have even picked a
   picture. If it will not load (an old browser, a failed download) the app carries on with the
   measurements alone, on their own calibration, and says so. */
var rxEmbeddingReady = false;
async function rxEnsureEmbedder(){
  if(rxEmbeddingReady) return true;
  try{
    await rxLoadEmbedder(function(frac, label){
      if(frac >= 1){ rxStatus(''); rxProgress(-1); return; }
      rxStatus(label);
      rxProgress(frac);
    });
    rxEmbeddingReady = true;
  }catch(e){
    rxEmbeddingReady = false;
  }
  return rxEmbeddingReady;
}

async function rxAutoFrameCard(card, quiet){
  if(!card.src) return;
  try{
    await rxEnsureMesh();
  }catch(e){
    rxStatus('The face mesh could not be loaded, so faces have to be framed by hand — drag the head into the square. ' +
             '(Comparing needs the mesh, so it will not work until this loads.)', 'bad');
    return;
  }
  var got = null;
  try{ got = await rxAutoFrameFromMesh(card.src); }catch(e){ got = null; }
  if(got){
    card.frame = got.frame;
    card.faces = got.faces;
    card.pose = got.pose;
    card.eyes = got.eyes;
  }else if(!quiet){
    rxStatus('No face was found in that photo. Drag the head into the square yourself, or try a clearer, straight-on picture.', 'note');
  }else{
    card.faces = 0;
  }
  rxSyncZoom(card);
  rxPreview(card);
}

function rxPreview(card){
  if(card.raf) return;
  card.raf = requestAnimationFrame(function(){
    card.raf = 0;
    if(!card.src || !card.frame) return;
    var out = rxRenderFace(card.src, card.frame, { size: RX_PREVIEW_PX, quality: 0.8 });
    card.els.canvas.getContext('2d').drawImage(out.canvas, 0, 0);
    card.quality = out.quality;
    rxShowWarnings(card);
  });
}

/* Every photo gets a verdict of its own, on the card, before you ever press Compare — because
   "the answer was rubbish" is nearly always "one of the photos could not be read", and finding that
   out at the end is finding it out too late. Three states, and the fatal one is stated as fatal. */
function rxShowWarnings(card){
  var stop = [], warn = [];

  if(card.src && card.faces === 0)
    stop.push('No face found here. Frame the head by hand, or use a clearer, straight-on photo.');
  if(card.eyes && card.eyes.covered)
    stop.push('Both eyes must be visible — these look covered by sunglasses, a brim or deep shadow. ' +
              'Everything is measured relative to the gap between the pupils, so nothing here can be measured.');
  if(card.pose && Math.abs(card.pose.yaw) > 30)
    stop.push('This face is turned ' + Math.round(Math.abs(card.pose.yaw)) + '° away — too far to measure. ' +
              'One side of every width is hidden. Use a straight-on photo.');

  if(card.faces > 1) warn.push('More than one face here — check the square is on the right person.');
  if(card.quality) card.quality.warnings.forEach(function(t){ warn.push(t); });
  if(!stop.length){ var pose = rxPoseWarning(card.pose); if(pose) warn.push(pose); }

  // What the tick boxes cost. Almost everything is free; colour is not, and says so.
  var cost = 0, worn = [];
  (card.worn || []).forEach(function(id){
    var o = RX_OCCLUDER_BY_ID[id];
    if(!o) return;
    worn.push(o.label.toLowerCase());
    cost += o.cost;
  });
  if(worn.length){
    warn.push(rxList(worn).replace(/^./, function(c){ return c.toUpperCase(); }) +
      ': the measurements those affect are left out. ' +
      (cost >= 0.02
        ? 'That one has a real cost — colour is the strongest family signal here, and without it the ' +
          'comparison gets noticeably weaker. A photo without it compares much better.'
        : 'Measured on real families, leaving those out costs nothing.'));
  }

  card.els.ready.hidden = false;
  if(stop.length){
    card.els.ready.className = 'ready ready-stop';
    card.els.ready.textContent = 'Cannot be compared';
  }else if(!card.src){
    card.els.ready.hidden = true;
  }else if(cost >= 0.02 || warn.length > worn.length){
    // A real problem with the photograph, or a tick box that genuinely costs accuracy.
    card.els.ready.className = 'ready ready-limited';
    card.els.ready.textContent = cost >= 0.02 ? 'Usable, but weakened' : 'Usable, with a caveat';
  }else if(warn.length){
    // Only free exclusions: worth stating, not worth alarming about.
    card.els.ready.className = 'ready ready-noted';
    card.els.ready.textContent = 'Good to compare, with some measurements left out';
  }else{
    card.els.ready.className = 'ready ready-good';
    card.els.ready.textContent = 'Good to compare';
  }

  var all = stop.concat(warn);
  card.els.warn.hidden = !all.length;
  card.els.warn.textContent = all.join(' ');
}

/* ============================ the roster ============================ */

function rxAddPerson(){
  if(rxPeople.length >= RX_MAX_PEOPLE) return;
  var card = rxNewCard('person', '');
  rxPeople.push(card);
  document.getElementById('peopleSlots').appendChild(rxBuildCard(card, rxPeople.length - 1));
  rxRefreshCompare();
}
function rxRemovePerson(card){
  if(rxPeople.length <= 2) return;
  rxPeople = rxPeople.filter(function(c){ return c !== card; });
  card.el.remove();
  rxRefreshCompare();
}
function rxFilled(){ return rxPeople.filter(function(c){ return !!c.src; }); }
function rxDisplayName(card, i){ return card.name || RX_NAME_IDEAS[i] || ('Person ' + (i + 1)); }

function rxRefreshCompare(){
  var ready = !!(rxChild && rxChild.src) && rxFilled().length >= 1;
  document.getElementById('compareBtn').disabled = !ready || rxBusy;
  document.getElementById('addPersonBtn').hidden = rxPeople.length >= RX_MAX_PEOPLE;
  Array.prototype.forEach.call(document.querySelectorAll('#peopleSlots .x'), function(x){
    x.hidden = rxPeople.length <= 2;
  });
}

function rxStatus(msg, kind){
  var el = document.getElementById('status');
  el.textContent = msg || '';
  el.className = 'status' + (kind ? ' ' + kind : '');
}
function rxProgress(frac){
  var bar = document.getElementById('progress');
  if(frac < 0 || frac >= 1){ bar.hidden = true; return; }
  bar.hidden = false;
  bar.firstElementChild.style.width = Math.round(frac * 100) + '%';
}

/* ============================ the run ============================ */

/* Read one face once: crop it (at this reading's jitter), find the mesh in the crop, measure it, and
   sample its colours off the same pixels that were measured. */
async function rxReadFace(card, jitter){
  var frame = rxClampFrame({ cx: card.frame.cx, cy: card.frame.cy, size: card.frame.size * jitter,
                             angle: card.frame.angle }, card.dims.w, card.dims.h);
  var out = rxRenderFace(card.src, frame, {});
  var got = rxDetect(out.canvas);
  if(!got) return { ok: false, why: 'noface', prepared: out };
  // Sunglasses are not a degraded reading, they are a wrong one: the iris centres are the ruler
  // every other measurement is scaled and levelled by, and behind a lens the mesh puts them in
  // confidently wrong places. Nothing measured from this face would mean anything.
  if(got.eyes && got.eyes.covered) return { ok: false, why: 'eyes', prepared: out, eyes: got.eyes };
  var vals = rxMeasure(got.pts, out.canvas.width, out.canvas.height);
  if(!vals) return { ok: false, why: 'noface', prepared: out };
  var colours = rxSampleColours(out.canvas, got.pts);
  Object.keys(colours).forEach(function(k){ vals[k] = colours[k]; });
  var vec = null;
  if(rxEmbeddingReady){
    try{ vec = await rxEmbed(out.canvas, got.pts); }catch(e){ vec = null; }
  }
  return { ok: true, vals: vals, vec: vec, blend: got.blend, pose: got.pose, faces: got.faces, prepared: out };
}

async function rxRunComparison(){
  if(rxBusy) return;
  var people = rxFilled();
  if(!rxChild || !rxChild.src || !people.length) return;

  var passes = parseInt((document.querySelector('input[name=passes]:checked') || {}).value || '2', 10);
  rxBusy = true; rxRefreshCompare();
  document.getElementById('results').hidden = true;

  try{
    await rxEnsureMesh();

    // First reading, at the true crop. It also decides who is in the comparison at all: a photo the
    // mesh cannot find a face in is reported and set aside, rather than being carried through as a
    // row of blanks that drag on everyone else's scores.
    await rxEnsureEmbedder();
    rxUseScale(rxEmbeddingReady ? 'blend' : 'geometry');
    rxStatus('Measuring…');
    await rxYield();

    var childRead = await rxReadFace(rxChild, RX_JITTER[0]);
    if(!childRead.ok) throw new Error(childRead.why === 'eyes'
      ? 'The child’s eyes are hidden — sunglasses, heavy shadow or a hat brim. Everything here is measured relative to the distance between the pupils, so with the eyes covered there is nothing to measure against. Use a photo where both eyes are visible.'
      : 'No face could be found in the child’s photo. Try a clearer, straight-on picture, or frame the head by hand.');
    rxChild.pose = childRead.pose; rxChild.faces = childRead.faces;

    var firstReads = [];
    for(var fi = 0; fi < people.length; fi++) firstReads.push(await rxReadFace(people[fi], RX_JITTER[0]));
    var failed = [], keep = [];
    firstReads.forEach(function(r, i){
      if(r.ok){ keep.push(i); return; }
      var who = rxDisplayName(people[i], rxPeople.indexOf(people[i]));
      failed.push(r.why === 'eyes'
        ? who + ': the eyes are hidden — sunglasses, heavy shadow or a hat brim. Every measurement is scaled and levelled by the line between the pupils, so with that line guessed the nose, jaw and face shape would be wrong too, not just the eyes. Left out of the comparison; use a photo with both eyes visible.'
        : who + ': no face could be found in that photo, so they were left out of the comparison.');
    });
    if(!keep.length) throw new Error('None of the other photos could be measured — check the notes on each one. Faces need to be straight-on with both eyes visible.');

    people = keep.map(function(i){ return people[i]; });
    var names = people.map(function(c){ return rxDisplayName(c, rxPeople.indexOf(c)); });
    var prepared = keep.map(function(i){ return firstReads[i].prepared; });
    var poses = keep.map(function(i){ return firstReads[i].pose; });
    var faceCounts = keep.map(function(i){ return firstReads[i].faces; });
    var childPrepared = childRead.prepared, childBlend = childRead.blend;

    var childWorn = rxOccluderBlocks(rxChild.worn);
    var blocked = keep.map(function(i){
      return rxMergeBlocks(rxBlocked(childBlend, firstReads[i].blend),
                           rxMergeBlocks(childWorn, rxOccluderBlocks(people[i].worn)));
    });
    var expressionNotes = rxExpressionNotes(childBlend, keep.map(function(i){ return firstReads[i]; }), names, blocked);
    var rounds = [rxRound(childRead.vals, keep.map(function(i){ return firstReads[i].vals; }), blocked)];

    // Further readings re-crop slightly, so what moves between them is measurement noise.
    for(var k = 1; k < passes; k++){
      rxStatus('Measuring… reading ' + (k + 1) + ' of ' + passes);
      await rxYield();
      var jitter = RX_JITTER[k % RX_JITTER.length];
      var again = await rxReadFace(rxChild, jitter);
      var others = [];
      for(var oi = 0; oi < people.length; oi++) others.push(await rxReadFace(people[oi], jitter));
      if(!again.ok || others.some(function(r){ return !r.ok; })) continue;   // a wobbly re-crop is not a failure
      rounds.push(rxRound(again.vals, others.map(function(r){ return r.vals; }),
                          others.map(function(r, i2){
                            return rxMergeBlocks(rxBlocked(again.blend, r.blend),
                                                 rxMergeBlocks(childWorn, rxOccluderBlocks(people[i2].worn)));
                          })));
    }

    // One embedding likeness per person, against the child. Null when the model is unavailable, in
    // which case rxOverall falls back to the measurements and the geometry scale is already selected.
    var embScores = null;
    if(rxEmbeddingReady && childRead.vec){
      embScores = keep.map(function(i){
        return firstReads[i].vec ? rxEmbLikeness(rxCosine(childRead.vec, firstReads[i].vec)) : null;
      });
    }

    rxStatus('');
    rxShowResults({ people: people, names: names, prepared: prepared, childPrepared: childPrepared,
                    embScores: embScores, embeddingUsed: !!embScores,
                    // The count reported is the number of readings that actually landed, not the
                    // number asked for: a re-crop the mesh could not read is skipped, and saying
                    // "3 readings" over 2 would be a small lie in the app's own provenance line.
                    rounds: rounds, passes: rounds.length, failed: failed, poses: poses, faceCounts: faceCounts,
                    expressionNotes: expressionNotes });
  }catch(e){
    rxStatus(e.message || 'The comparison could not be completed.', 'bad');
  }finally{
    rxBusy = false; rxRefreshCompare();
  }
}

// Let the browser paint the status line before a reading blocks the thread for a moment.
function rxYield(){ return new Promise(function(r){ setTimeout(r, 0); }); }

/* Which features were left out for whom, and on account of which expression. Collected from the
   first reading, since the crops barely differ. */
var RX_EXPR_WORDS = {
  jawOpen: 'an open mouth', mouthSmileLeft: 'a smile', mouthSmileRight: 'a smile',
  mouthPucker: 'pursed lips', mouthFunnel: 'a rounded mouth',
  eyeBlinkLeft: 'a half-closed eye', eyeBlinkRight: 'a half-closed eye',
  eyeSquintLeft: 'a squint', eyeSquintRight: 'a squint', eyeWideLeft: 'wide eyes', eyeWideRight: 'wide eyes',
  browDownLeft: 'a lowered brow', browDownRight: 'a lowered brow',
  browInnerUp: 'a raised brow', browOuterUpLeft: 'a raised brow', browOuterUpRight: 'a raised brow'
};
/* An expression that moves a feature makes that feature unmeasurable, not merely noisier — a grin
   really does widen a mouth. Whichever photo is pulling the face, the measurement is dropped from
   BOTH sides of that pair, so the note names the photo at fault rather than blaming the comparison. */
function rxExpressionNotes(childBlend, reads, names, blocked){
  var notes = [];
  blocked.forEach(function(b, i){
    if(!reads[i].ok) return;
    var reasons = b.__reasons || [];
    if(!reasons.length) return;
    var features = {};
    RX_MEASURES.forEach(function(m){ if(b[m.key]) features[m.feature] = true; });
    var list = Object.keys(features).map(function(fk){ return rxFeature(fk).short; });
    if(!list.length) return;
    var words = {}, whose = {};
    reasons.forEach(function(name){
      words[RX_EXPR_WORDS[name] || 'an expression'] = true;
      if((childBlend && childBlend[name] || 0) >= RX_EXPR_LEVEL) whose.child = true;
      if((reads[i].blend && reads[i].blend[name] || 0) >= RX_EXPR_LEVEL) whose.them = true;
    });
    var who = whose.child && whose.them ? 'both photos'
            : whose.child ? 'the child’s photo' : names[i] + '’s photo';
    notes.push('Some ' + rxList(list) + ' measurements were dropped from the comparison with ' +
      names[i] + ', because of ' + rxList(Object.keys(words)) + ' in ' + who + '. ' +
      'A relaxed, neutral face compares best.');
  });
  return notes;
}

/* ============================ results ============================ */

function rxShowResults(run){
  var n = run.people.length;
  var table = rxMergeRounds(run.rounds, n);
  var overall = rxOverall(table, n, run.embScores);
  var calls = rxAllCalls(table, n);
  var verdict = rxVerdict(overall, calls, run.rounds, n);
  rxLastRun = { run: run, table: table, overall: overall, calls: calls, verdict: verdict };

  rxRenderVerdict(run, overall, verdict);
  rxRenderLineup(run, overall, verdict);
  rxRenderMix(run, calls);
  rxRenderFeatures(run, table, calls);
  rxRenderCaveats(run, table, calls, verdict);

  document.getElementById('provenance').textContent =
    run.passes + (run.passes === 1 ? ' reading' : ' readings, each from a slightly different crop') +
    (run.embeddingUsed ? ' · face-recognition model + measurements (60/40)' : ' · measurements only') +
    ' · all on this device · nothing was uploaded';

  var res = document.getElementById('results');
  res.hidden = false;
  res.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function rxPct(v){ return typeof v === 'number' ? Math.round(v) : '–'; }

function rxRenderVerdict(run, overall, verdict){
  var box = document.getElementById('verdict');
  var sub;
  if(verdict.confidence === 'only'){
    sub = 'Only one person had a photo, so there is nothing to weigh this against — a likeness of ' +
          rxPct(overall.raw[verdict.leader]) + '/100 means little on its own. Add someone else to compare with.';
  }else{
    // Every verdict is quoted against the measured null: how often two UNRELATED adults produce a
    // winning margin this big against one child, by chance alone. Without that number a gap is just
    // a number, and this app spent its first version reading noise as a result.
    var gap = Math.round(verdict.gap);
    var chance = rxChanceOf(verdict.gap);
    var odds = 'A gap this size turns up between two unrelated people about ' + chance + '% of the time.';
    if(verdict.confidence === 'clear'){
      sub = gap + ' points ahead of ' + run.names[verdict.runnerUp] + ', and every reading agreed. ' + odds;
    }else if(verdict.confidence === 'lean'){
      sub = 'A lean, not a landslide: ' + gap + ' points ahead of ' + run.names[verdict.runnerUp] + '. ' + odds +
            (verdict.stability < 1 ? ' The readings also disagreed with each other, so treat it lightly.' : '');
    }else{
      sub = 'Too close to call: ' + gap + ' points between the top two. ' + odds +
            ' On a difference that small this is not telling you anything — it is a genuine mix, ' +
            'or the photographs cannot separate them.';
    }
  }
  box.className = 'verdict v-' + verdict.confidence;
  box.innerHTML = '<p class="v-lead"></p><p class="v-sub"></p>';
  box.querySelector('.v-lead').textContent = rxHeadline(verdict, run.names);
  box.querySelector('.v-sub').textContent = sub;
}

function rxRenderLineup(run, overall, verdict){
  var box = document.getElementById('lineup');
  box.innerHTML = '';
  var childWrap = document.createElement('div');
  childWrap.className = 'line-child';
  childWrap.innerHTML = '<img alt="The prepared crop of the child that was measured"><span class="line-name"></span>';
  childWrap.querySelector('img').src = run.childPrepared.dataUrl;
  childWrap.querySelector('.line-name').textContent = rxChild.name || 'The little one';
  box.appendChild(childWrap);

  var rows = document.createElement('div');
  rows.className = 'line-rows';
  run.names.forEach(function(name, i){
    var row = document.createElement('div');
    row.className = 'line-row ' + RX_TONES[i % RX_TONES.length] + (i === verdict.leader ? ' leads' : '');
    row.innerHTML =
      '<img alt="The prepared crop that was measured">' +
      '<div class="line-body">' +
        '<div class="line-top"><span class="line-name"></span><span class="line-share"></span></div>' +
        '<div class="bar"><span></span></div>' +
        '<div class="line-raw"></div>' +
      '</div>';
    row.querySelector('img').src = run.prepared[i].dataUrl;
    row.querySelector('.line-name').textContent = name;
    row.querySelector('.line-share').textContent = rxPct(overall.share[i]) + '%';
    row.querySelector('.bar span').style.width = Math.max(2, rxPct(overall.share[i])) + '%';
    row.querySelector('.line-raw').textContent = 'likeness ' + rxPct(overall.raw[i]) + '/100';
    rows.appendChild(row);
  });
  box.appendChild(rows);

  // Said on screen, not just in the README: the percentages compare these people with each other,
  // which is a real comparison. The 0–100 likeness is a ruler of the app's own devising — there is
  // no database of family noses behind it — so it is fine for "who is closer" and not a statistic.
  if(run.names.length > 1){
    var note = document.createElement('p');
    note.className = 'lineup-note';
    note.textContent = 'The percentages split the resemblance between these people — that is the ' +
      'comparison this can actually make. The 0–100 likeness is a relative scale, not a percentage ' +
      'of anything: use it to see who is closer, not to judge whether 46 is a lot.';
    box.appendChild(note);
  }
}

function rxRenderMix(run, calls){
  var box = document.getElementById('mixLine');
  var parts = [];
  run.names.forEach(function(name, i){
    var won = rxWonBy(calls, i);
    if(won.length) parts.push('<strong>' + rxEsc(name) + '</strong>’s ' +
      rxEsc(rxList(won.map(function(f){ return f.short; }))));
  });
  var shared = calls.filter(function(c){ return c.answered && c.shared; })
                    .map(function(c){ return rxFeature(c.key).short; });
  var html = parts.length ? parts.join(' &nbsp;·&nbsp; ')
                          : 'No single feature stood out strongly enough to hand to one person.';
  if(shared.length) html += '<span class="shared"> &nbsp;·&nbsp; shared between them: ' + rxEsc(rxList(shared)) + '</span>';
  box.innerHTML = html;
}

function rxRenderFeatures(run, table, calls){
  var box = document.getElementById('featureTable');
  box.innerHTML = '';
  if(run.embeddingUsed){
    var note = document.createElement('p');
    note.className = 'ftable-note';
    note.textContent = 'The verdict above mostly comes from a face-recognition model, which produces ' +
      'a single number. The breakdown below is the measurements — it is where "whose eyes" comes from, ' +
      'and it can disagree with the headline.';
    box.appendChild(note);
  }
  calls.forEach(function(call){
    var f = rxFeature(call.key);
    var row = document.createElement('div');
    row.className = 'frow';

    var head = document.createElement('div');
    head.className = 'frow-head';
    head.innerHTML = '<span class="fname"></span><span class="fchip"></span>';
    head.querySelector('.fname').textContent = f.label;
    var chip = head.querySelector('.fchip');
    if(!call.answered){ chip.textContent = 'could not be measured'; chip.className = 'fchip chip-none'; }
    else if(call.unsteady){ chip.textContent = 'the readings disagreed'; chip.className = 'fchip chip-shaky'; }
    else if(call.partial){ chip.textContent = 'not comparable for everyone'; chip.className = 'fchip chip-none'; }
    else if(call.shared){ chip.textContent = 'too close to call'; chip.className = 'fchip chip-shared'; }
    else { chip.textContent = run.names[call.winner]; chip.className = 'fchip chip-win ' + RX_TONES[call.winner % RX_TONES.length]; }
    row.appendChild(head);

    var bars = document.createElement('div');
    bars.className = 'fbars';
    run.names.forEach(function(name, i){
      var v = table.features[call.key].mean[i];
      var b = document.createElement('div');
      b.className = 'fbar ' + RX_TONES[i % RX_TONES.length] + (call.winner === i && rxAttributed(call) ? ' win' : '');
      b.innerHTML = '<span class="fbar-name"></span><span class="bar"><span></span></span><span class="fbar-v"></span>';
      b.querySelector('.fbar-name').textContent = name;
      b.querySelector('.bar span').style.width = (typeof v === 'number' ? Math.max(1, v) : 0) + '%';
      b.querySelector('.fbar-v').textContent = rxPct(v);
      bars.appendChild(b);
    });
    row.appendChild(bars);

    if(rxAttributed(call) && call.winner >= 0){
      var note = rxFeatureNote(table, call.key, call.winner);
      if(note){
        var p = document.createElement('p');
        p.className = 'fnote';
        p.textContent = run.names[call.winner] + ': ' + note + '.';
        row.appendChild(p);
      }
    }
    box.appendChild(row);
  });
}

function rxRenderCaveats(run, table, calls, verdict){
  var box = document.getElementById('caveats');
  var items = [];

  if(verdict.stability < 1 && run.passes > 1){
    items.push('The readings did not all pick the same person overall — ' + Math.round(verdict.stability * 100) +
      '% agreed. That usually means the two really are close, or that one photo is hard to read.');
  }
  var wobbly = calls.filter(function(c){ return c.answered && c.unsteady; })
                    .map(function(c){ return rxFeature(c.key).short; });
  if(wobbly.length){
    items.push('Re-cropping the photos slightly moved the ' + rxList(wobbly) +
      ' measurements more than the people differ on them, so those are not settled by these photographs.');
  }
  var missing = calls.filter(function(c){ return !c.answered; }).map(function(c){ return rxFeature(c.key).short; });
  if(missing.length) items.push('Nothing could be measured for: ' + rxList(missing) + '.');

  run.failed.forEach(function(t){ items.push(t); });
  [rxChild].concat(run.people).forEach(function(c, i){
    var who = i === 0 ? (rxChild.name || 'The child') : run.names[i - 1];
    if(c.quality && c.quality.warnings.length) items.push(who + ': ' + c.quality.warnings.join(' '));
    var pose = rxPoseWarning(i === 0 ? rxChild.pose : run.poses[i - 1]);
    if(pose) items.push(who + ': ' + pose);
    var fc = i === 0 ? rxChild.faces : run.faceCounts[i - 1];
    if(fc > 1) items.push(who + ': more than one face in that photo — the biggest was used.');
  });
  run.expressionNotes.forEach(function(t){ items.push(t); });
  ([[rxChild, rxChild.name || 'The child']].concat(run.people.map(function(c, i){ return [c, run.names[i]]; })))
    .forEach(function(pair){
      var worn = (pair[0].worn || []).map(function(id){ return RX_OCCLUDER_BY_ID[id]; }).filter(Boolean);
      if(!worn.length) return;
      var costly = worn.filter(function(o){ return o.costly; });
      items.push(pair[1] + ': ' + rxList(worn.map(function(o){ return o.label.toLowerCase(); })) +
        ' — the affected measurements were left out. ' +
        (costly.length ? 'Leaving out colour weakens the comparison noticeably.'
                       : 'On real families that costs nothing measurable.'));
    });

  items = items.filter(function(t, i){ return items.indexOf(t) === i; });
  if(!items.length){ box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = '<h3 class="sub">Worth knowing</h3><ul></ul>';
  var ul = box.querySelector('ul');
  items.forEach(function(t){ var li = document.createElement('li'); li.textContent = t; ul.appendChild(li); });
}

/* ============================ odds and ends ============================ */

function rxEsc(s){ return String(s).replace(/[&<>"]/g, function(c){
  return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
function rxList(items){
  if(items.length <= 1) return items[0] || '';
  return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
}

function rxResultText(){
  var L = rxLastRun;
  if(!L) return '';
  var lines = [rxHeadline(L.verdict, L.run.names), ''];
  L.run.names.forEach(function(name, i){
    lines.push(name + ': ' + rxPct(L.overall.share[i]) + '% of the resemblance (likeness ' +
               rxPct(L.overall.raw[i]) + '/100)');
  });
  lines.push('');
  L.calls.forEach(function(c){
    var who = !c.answered ? 'could not be measured'
            : c.unsteady ? 'unsteady between readings'
            : c.partial ? 'not comparable for everyone'
            : c.shared ? 'too close to call' : L.run.names[c.winner];
    lines.push(rxFeature(c.key).label + ': ' + who);
  });
  lines.push('');
  lines.push('Measured on-device from face geometry. For fun only — this compares two photographs, ' +
             'and is not a paternity, DNA or identity test.');
  return lines.join('\n');
}

function rxCopyResult(){
  var btn = document.getElementById('copyBtn');
  function done(ok){
    btn.textContent = ok ? 'Copied' : 'Press ⌘/Ctrl+C';
    setTimeout(function(){ btn.textContent = 'Copy the result as text'; }, 1800);
  }
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(rxResultText()).then(function(){ done(true); }, function(){ done(false); });
  }else{ done(false); }
}

/* ============================ installing it ============================ */

/* It has been installable all along — a manifest, a service worker and a full offline cache — but
   nothing on the page said so, and "add to home screen" is buried three menus deep on every
   platform. So: a real button where the browser offers one, and the actual gesture spelled out
   where it does not (iOS gives no install event at all, only the Share sheet). */
var rxInstallPrompt = null;

function rxStandalone(){
  return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
         navigator.standalone === true;
}
function rxIsIOS(){
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
         (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);   // iPadOS reports as a Mac
}

function rxInstallUI(){
  var row = document.getElementById('installRow');
  var btn = document.getElementById('installBtn');
  var why = document.getElementById('installWhy');
  if(!row) return;

  if(rxStandalone()){ row.hidden = true; return; }         // already installed: nothing to offer

  if(rxInstallPrompt){
    row.hidden = false;
    btn.hidden = false;
    why.textContent = 'Keeps working with no signal, and the photos never leave the device.';
    return;
  }
  if(rxIsIOS()){
    // Safari has no install event; the only route is the Share sheet, so say exactly that.
    row.hidden = false;
    btn.hidden = true;
    why.textContent = 'To install: tap Share, then “Add to Home Screen”.';
  }
}

window.addEventListener('beforeinstallprompt', function(e){
  e.preventDefault();                                       // keep the browser's own mini-infobar out of the way
  rxInstallPrompt = e;
  rxInstallUI();
});
window.addEventListener('appinstalled', function(){
  rxInstallPrompt = null;
  var row = document.getElementById('installRow');
  if(row) row.hidden = true;
});

function rxInstall(){
  if(!rxInstallPrompt) return;
  rxInstallPrompt.prompt();
  rxInstallPrompt.userChoice.then(function(){ rxInstallPrompt = null; rxInstallUI(); });
}

function rxInit(){
  rxChild = rxNewCard('child', '');
  document.getElementById('childSlots').appendChild(rxBuildCard(rxChild, 0));
  rxAddPerson();
  rxAddPerson();
  document.getElementById('addPersonBtn').addEventListener('click', rxAddPerson);
  document.getElementById('compareBtn').addEventListener('click', rxRunComparison);
  document.getElementById('againBtn').addEventListener('click', function(){
    document.getElementById('results').hidden = true;
    document.querySelector('.masthead').scrollIntoView({ behavior: 'smooth' });
  });
  document.getElementById('copyBtn').addEventListener('click', rxCopyResult);
  document.getElementById('installBtn').addEventListener('click', rxInstall);
  rxInstallUI();
  rxRefreshCompare();
  if('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(function(){});
}

if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', rxInit);
else rxInit();
