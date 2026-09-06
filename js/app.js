/* app.js — the page. Cards, dragging, the compare run, and the way the answer is presented.
   Loaded last; depends on faces.js (the image pipeline) and resemble.js (the scoring).

   Two things here are deliberate rather than incidental:

   • The frame is editable, always. Auto-framing is a head start, not an answer — and since a bad
     crop is the single easiest way to get a confidently wrong result, the crop is the first thing
     the interface hands you, not something buried behind a settings panel. What you see in the
     square is exactly the image that gets compared, exposure correction and all.
   • Uncertainty is shown, not smoothed. A 2-point gap is drawn as a 2-point gap and described as a
     mix; a feature the passes disagreed about says so. It would be easy — and much more satisfying —
     to always crown a winner. It would also be a lie most of the time. */

var RX_PREVIEW_PX = 260;
var RX_MAX_PEOPLE = 6;
var RX_NAME_IDEAS = ['Mum', 'Dad', 'Grandma', 'Grandad', 'Auntie', 'Uncle'];
var RX_TONES = ['tone-a', 'tone-b', 'tone-c', 'tone-d', 'tone-e', 'tone-f'];

var rxChild = null;      // the one child card
var rxPeople = [];       // the adult cards, in the order they appear on screen
var rxSeq = 0;
var rxBusy = false;

/* ============================ cards ============================ */

function rxNewCard(kind, name){
  return { id: 'c' + (++rxSeq), kind: kind, name: name || '', src: null, frame: null,
           quality: null, faces: 0, el: null, els: {}, raf: 0 };
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
        '<button type="button" class="tiny auto">Auto-frame</button>' +
        '<button type="button" class="tiny change">Change photo</button>' +
      '</div>' +
    '</div>' +
    '<p class="warn" hidden></p>';

  card.el = el;
  card.els = {
    name: el.querySelector('.name-in'), frame: el.querySelector('.frame'), canvas: el.querySelector('.preview'),
    empty: el.querySelector('.empty'), file: el.querySelector('.file'), tools: el.querySelector('.tools'),
    zoom: el.querySelector('.zoom'), warn: el.querySelector('.warn'), remove: el.querySelector('.x')
  };
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
    if(pts.size === 1){ start = { x: e.clientX, y: e.clientY, cx: card.frame.cx, cy: card.frame.cy }; }
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

// Zoom slider ↔ crop size. 0 on the slider is the widest square the photo allows; 100 is tight on
// the face. Inverted because "more zoom" means "smaller crop".
function rxZoomTo(card, v){
  if(!card.src) return;
  var minDim = Math.min(card.dims.w, card.dims.h);
  rxSetSize(card, minDim * (1 - 0.82 * (v / 100)));
}
function rxSetSize(card, size){
  if(!card.src) return;
  card.frame = rxClampFrame({ cx: card.frame.cx, cy: card.frame.cy, size: size, angle: card.frame.angle },
                            card.dims.w, card.dims.h);
  rxSyncZoom(card);
  rxPreview(card);
}
function rxSyncZoom(card){
  var minDim = Math.min(card.dims.w, card.dims.h);
  card.els.zoom.value = String(Math.round(((1 - card.frame.size / minDim) / 0.82) * 100));
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
    await rxAutoFrameCard(card, true);
  }catch(e){
    card.src = null;
    rxStatus(e.message || 'That photo could not be opened.', 'bad');
  }
  rxRefreshCompare();
}

async function rxAutoFrameCard(card, quiet){
  if(!card.src) return;
  var got = await rxAutoFrame(card.src);
  if(got){
    card.frame = got.frame;
    card.faces = got.faces;
  }else if(!quiet){
    rxStatus('This browser has no face detector, so the frame is yours to set — drag the face into the square and zoom until the head fills most of it.', 'note');
  }
  rxSyncZoom(card);
  rxPreview(card);
}

/* Redraw the square. Throttled to one render per animation frame so a drag stays smooth: the render
   includes the exposure pass, which is a full read of the preview buffer. */
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

function rxShowWarnings(card){
  var w = card.quality ? card.quality.warnings.slice() : [];
  if(card.faces > 1) w.unshift('More than one face in this photo — check the square is on the right person.');
  card.els.warn.hidden = !w.length;
  card.els.warn.textContent = w.join(' ');
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
  if(rxPeople.length <= 2) return;                 // a comparison needs at least two to choose between
  rxPeople = rxPeople.filter(function(c){ return c !== card; });
  card.el.remove();
  rxRefreshCompare();
}

function rxFilled(){ return rxPeople.filter(function(c){ return !!c.src; }); }
function rxDisplayName(card, i){ return card.name || RX_NAME_IDEAS[i] || ('Person ' + rxLabel(i)); }

function rxRefreshCompare(){
  var ready = !!(rxChild && rxChild.src) && rxFilled().length >= 1;
  var btn = document.getElementById('compareBtn');
  btn.disabled = !ready || rxBusy;
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

/* ============================ the run ============================ */

async function rxCompare(){
  if(rxBusy) return;
  var people = rxFilled();
  if(!rxChild || !rxChild.src || !people.length) return;

  var passes = parseInt((document.querySelector('input[name=passes]:checked') || {}).value || '2', 10);
  rxBusy = true; rxRefreshCompare();
  document.getElementById('results').hidden = true;

  try{
    rxStatus('Preparing the faces…');
    var childUrl = rxRenderFace(rxChild.src, rxChild.frame, {}).dataUrl;
    var prepared = people.map(function(c){ return rxRenderFace(c.src, c.frame, {}); });
    var names = people.map(function(c, i){ return rxDisplayName(c, rxPeople.indexOf(c)); });

    var plan = rxPlanRounds(people.length, passes);
    var rounds = [], issues = [], meta = null;

    for(var p = 0; p < plan.length; p++){
      rxStatus(passes > 1 ? ('Looking… pass ' + (p + 1) + ' of ' + passes + ' (order shuffled, names hidden)')
                          : 'Looking…');
      var order = plan[p];
      var res = await rxPost({ child: childUrl, others: order.map(function(i){ return prepared[i].dataUrl; }) });
      rounds.push(rxRoundScores(order, res.features));
      (res.issues || []).forEach(function(s){ issues.push(rxDeLetter(s, order, names)); });
      meta = meta || { provider: res.provider, model: res.model, tokens: 0 };
      meta.tokens += (res.usage && res.usage.total) || 0;
    }

    rxStatus('');
    rxShowResults({ people: people, names: names, prepared: prepared, childUrl: childUrl,
                    rounds: rounds, issues: issues, meta: meta, passes: passes });
  }catch(e){
    rxStatus(e.message || 'The comparison could not be completed.', 'bad');
  }finally{
    rxBusy = false; rxRefreshCompare();
  }
}

async function rxPost(body){
  var r;
  try{
    r = await fetch('/api/compare', { method: 'POST', headers: { 'content-type': 'application/json' },
                                      body: JSON.stringify(body) });
  }catch(e){ throw new Error('Could not reach the comparison service — check your connection.'); }
  var d = {};
  try{ d = await r.json(); }catch(e){ /* fall through to the status-based message */ }
  if(!r.ok) throw new Error(d.error || ('The comparison service answered with an error (' + r.status + ').'));
  if(!d.features) throw new Error('The comparison came back empty.');
  return d;
}

// The server talks in letters; the user does not. Turn "B: ears are covered by hair" back into
// "Dad: ears are covered by hair" using the order that pass was actually sent in.
function rxDeLetter(text, order, names){
  return String(text).replace(/\b([A-F])\b/g, function(m, L){
    var slot = L.charCodeAt(0) - 65;
    return (slot < order.length && names[order[slot]]) ? names[order[slot]] : m;
  });
}

/* ============================ results ============================ */

function rxShowResults(run){
  var n = run.people.length;
  var table = rxMerge(run.rounds, n);
  var overall = rxOverall(table, n);
  var calls = rxAllCalls(table, n);
  var verdict = rxVerdict(overall, calls, run.rounds, n);
  rxLastRun = { run: run, table: table, overall: overall, calls: calls, verdict: verdict };

  rxRenderVerdict(run, overall, verdict);
  rxRenderLineup(run, overall, verdict);
  rxRenderMix(run, calls, verdict);
  rxRenderFeatures(run, table, calls);
  rxRenderCaveats(run, verdict);

  var m = run.meta || {};
  document.getElementById('provenance').textContent =
    run.passes + (run.passes === 1 ? ' look' : ' looks, each with the photos in a different order') +
    (m.provider ? ' · read by ' + m.provider + ' (' + m.model + ')' : '') +
    (m.tokens ? ' · ' + m.tokens.toLocaleString() + ' tokens' : '');

  var res = document.getElementById('results');
  res.hidden = false;
  res.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
var rxLastRun = null;

function rxPct(v){ return typeof v === 'number' ? Math.round(v) : '–'; }

function rxRenderVerdict(run, overall, verdict){
  var box = document.getElementById('verdict');
  var lead = rxHeadline(verdict, run.names);
  var sub;
  if(verdict.confidence === 'only'){
    sub = 'Only one person had a photo, so there is nothing to weigh this against — a likeness of ' +
          rxPct(overall.raw[verdict.leader]) + '/100 means little on its own. Add someone else to compare with.';
  }else if(verdict.confidence === 'clear'){
    sub = 'A clear lead — ' + Math.round(verdict.gap) + ' points ahead of ' +
          run.names[verdict.runnerUp] + ', and every pass agreed.';
  }else if(verdict.confidence === 'lean'){
    sub = 'A lean, not a landslide: ' + Math.round(verdict.gap) + ' points ahead of ' +
          run.names[verdict.runnerUp] + '.' +
          (verdict.stability < 1 ? ' The passes did not all agree, so treat it lightly.' : '');
  }else{
    sub = 'The scores are too close to call a winner — ' + Math.round(verdict.gap) +
          ' points between the top two. This little one is genuinely a bit of both.';
  }
  box.className = 'verdict v-' + verdict.confidence;
  box.innerHTML = '<p class="v-lead"></p><p class="v-sub"></p>';
  box.querySelector('.v-lead').textContent = lead;
  box.querySelector('.v-sub').textContent = sub;
}

function rxRenderLineup(run, overall, verdict){
  var box = document.getElementById('lineup');
  box.innerHTML = '';

  var childWrap = document.createElement('div');
  childWrap.className = 'line-child';
  childWrap.innerHTML = '<img alt="The prepared photo of the child that was compared"><span class="line-name"></span>';
  childWrap.querySelector('img').src = run.childUrl;
  childWrap.querySelector('.line-name').textContent = (rxChild.name || 'The little one');
  box.appendChild(childWrap);

  var rows = document.createElement('div');
  rows.className = 'line-rows';
  run.names.forEach(function(name, i){
    var row = document.createElement('div');
    row.className = 'line-row ' + RX_TONES[i % RX_TONES.length] + (i === verdict.leader ? ' leads' : '');
    row.innerHTML =
      '<img alt="The prepared photo that was compared">' +
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
}

function rxRenderMix(run, calls, verdict){
  var box = document.getElementById('mixLine');
  var parts = [];
  run.names.forEach(function(name, i){
    var won = rxWonBy(calls, i);
    if(won.length) parts.push('<strong>' + rxEsc(name) + '</strong>’s ' + rxEsc(rxList(won.map(function(f){ return f.short; }))));
  });
  var shared = calls.filter(function(c){ return c.answered && c.shared; })
                    .map(function(c){ return rxFeature(c.key).short; });
  var html = parts.length ? parts.join(' &nbsp;·&nbsp; ') : 'No single feature stood out strongly enough to hand to one person.';
  if(shared.length) html += '<span class="shared"> &nbsp;·&nbsp; shared between them: ' + rxEsc(rxList(shared)) + '</span>';
  box.innerHTML = html;
}

function rxRenderFeatures(run, table, calls){
  var box = document.getElementById('featureTable');
  box.innerHTML = '';
  calls.forEach(function(call){
    var f = rxFeature(call.key);
    var row = document.createElement('div');
    row.className = 'frow';

    var head = document.createElement('div');
    head.className = 'frow-head';
    head.innerHTML = '<span class="fname"></span><span class="fchip"></span>';
    head.querySelector('.fname').textContent = f.label;
    var chip = head.querySelector('.fchip');
    if(!call.answered){ chip.textContent = 'not visible'; chip.className = 'fchip chip-none'; }
    else if(call.unsteady){ chip.textContent = 'the passes disagreed'; chip.className = 'fchip chip-shaky'; }
    else if(call.shared){ chip.textContent = 'too close to call'; chip.className = 'fchip chip-shared'; }
    else { chip.textContent = run.names[call.winner]; chip.className = 'fchip chip-win ' + RX_TONES[call.winner % RX_TONES.length]; }
    row.appendChild(head);

    var bars = document.createElement('div');
    bars.className = 'fbars';
    run.names.forEach(function(name, i){
      var v = table[call.key].mean[i];
      var b = document.createElement('div');
      b.className = 'fbar ' + RX_TONES[i % RX_TONES.length] + (call.winner === i && !call.shared && !call.unsteady ? ' win' : '');
      b.innerHTML = '<span class="fbar-name"></span><span class="bar"><span></span></span><span class="fbar-v"></span>';
      b.querySelector('.fbar-name').textContent = name;
      b.querySelector('.bar span').style.width = (typeof v === 'number' ? Math.max(1, v) : 0) + '%';
      b.querySelector('.fbar-v').textContent = rxPct(v);
      bars.appendChild(b);
    });
    row.appendChild(bars);

    var note = table[call.key].notes[0];
    if(note){
      var p = document.createElement('p');
      p.className = 'fnote';
      p.textContent = '“' + note + '”';
      row.appendChild(p);
    }
    box.appendChild(row);
  });
}

function rxRenderCaveats(run, verdict){
  var box = document.getElementById('caveats');
  var items = [];
  if(verdict.stability < 1 && run.passes > 1){
    items.push('The passes did not all pick the same person overall — ' +
      Math.round(verdict.stability * 100) + '% agreed. That usually means the two really are close, ' +
      'or that one of the photos is hard to read.');
  }
  run.people.forEach(function(c, i){
    var q = c.quality;
    if(q && q.warnings.length) items.push(run.names[i] + ': ' + q.warnings.join(' '));
  });
  if(rxChild.quality && rxChild.quality.warnings.length){
    items.push((rxChild.name || 'The child') + ': ' + rxChild.quality.warnings.join(' '));
  }
  run.issues.forEach(function(s){ items.push(s); });
  items = items.filter(function(t, i){ return items.indexOf(t) === i; });   // passes often repeat themselves

  if(!items.length){ box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = '<h3 class="sub">Worth knowing</h3><ul></ul>';
  var ul = box.querySelector('ul');
  items.forEach(function(t){ var li = document.createElement('li'); li.textContent = t; ul.appendChild(li); });
}

/* ============================ odds and ends ============================ */

function rxEsc(s){ return String(s).replace(/[&<>"]/g, function(c){ return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
function rxList(items){
  if(items.length <= 1) return items[0] || '';
  return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
}

function rxResultText(){
  var L = rxLastRun;
  if(!L) return '';
  var lines = [rxHeadline(L.verdict, L.run.names), ''];
  L.run.names.forEach(function(name, i){
    lines.push(name + ': ' + rxPct(L.overall.share[i]) + '% of the resemblance (likeness ' + rxPct(L.overall.raw[i]) + '/100)');
  });
  lines.push('');
  L.calls.forEach(function(c){
    var f = rxFeature(c.key);
    var who = !c.answered ? 'not visible' : c.unsteady ? 'unsteady across passes' : c.shared ? 'too close to call' : L.run.names[c.winner];
    lines.push(f.label + ': ' + who);
  });
  lines.push('');
  lines.push('For fun only — this compares two photographs, and is not a paternity, DNA or identity test.');
  return lines.join('\n');
}

function rxCopyResult(){
  var text = rxResultText();
  var btn = document.getElementById('copyBtn');
  function done(ok){ btn.textContent = ok ? 'Copied' : 'Press ⌘/Ctrl+C'; setTimeout(function(){ btn.textContent = 'Copy the result as text'; }, 1800); }
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(function(){ done(true); }, function(){ done(false); });
  }else{ done(false); }
}

function rxInit(){
  rxChild = rxNewCard('child', '');
  document.getElementById('childSlots').appendChild(rxBuildCard(rxChild, 0));
  rxAddPerson();
  rxAddPerson();
  document.getElementById('addPersonBtn').addEventListener('click', rxAddPerson);
  document.getElementById('compareBtn').addEventListener('click', rxCompare);
  document.getElementById('againBtn').addEventListener('click', function(){
    document.getElementById('results').hidden = true;
    document.querySelector('.masthead').scrollIntoView({ behavior: 'smooth' });
  });
  document.getElementById('copyBtn').addEventListener('click', rxCopyResult);
  rxRefreshCompare();
}

if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', rxInit);
else rxInit();
