/* resemble.js — measurements to a verdict. Pure logic: no DOM, no canvas, no model.

   WHAT CHANGED, AND WHY IT MATTERS. An earlier version of this app asked a hosted vision model to
   judge the faces, and most of the machinery here existed to defend against the model: hide the
   names so "Dad" was not flattered, rotate the running order so the first photo was not flattered,
   ask repeatedly and see whether the answer held still. None of that is needed any more. Measuring a
   nose has no opinion about whose nose it is, does not care which photo came first, and gives the
   same answer every time. The bias defences are gone because the bias is gone.

   ONE HONEST WORRY SURVIVES, in a better form. Landmark detection is not perfectly repeatable: nudge
   the crop and every point shifts a little. So a comparison is run more than once over slightly
   different crops of the same photos, and the SPREAD between those readings is kept. It is no longer
   "did the model change its mind" — it is "how firmly is this measurement actually pinned down by
   these photographs". A feature that wobbles between readings is reported as wobbling.

   The thresholds below are the whole of this app's restraint, so they are stated once, here, in
   points on the 0–100 similarity scale. */

/* measure.js supplies RX_MEASURES and rxCompare. In the browser both files are plain scripts sharing
   one global scope, so they are simply there; under Node's test runner they have to be pulled in.
   Assigning onto globalThis rather than declaring with `var` keeps the browser's real globals from
   being shadowed by a hoisted, never-assigned local. */
if(typeof RX_MEASURES === 'undefined' && typeof require === 'function'){
  globalThis.RX_MEASURES = require('./measure.js').RX_MEASURES;
  globalThis.rxCompare = require('./measure.js').rxCompare;
}

var RX_FEATURE_MARGIN = 8;   // a feature is "shared" unless someone leads it by this much
var RX_CLEAR_GAP     = 10;   // "takes after" needs this overall lead, and every reading agreeing
var RX_LEAN_GAP      = 4;    // "leans towards" needs this much; below it, a genuine mix
/* A feature is scored from several measurements. If an expression knocks out most of them, what is
   left is not really that feature any more — a mouth judged on philtrum length alone is not a mouth.
   Below this fraction of a feature's weight, it stops being attributable to anyone. */
var RX_MIN_COVERAGE = 0.5;

/* The eight features, weighted towards bone structure — which is what survives the twenty years
   between a toddler and an adult — and away from colouring, which a camera gets wrong first.
   Ears and hairline are deliberately absent: a face mesh stops at the face, so they cannot be
   measured, and guessing at them would be the dishonest half of the answer. */
var RX_FEATURES = [
  { key:'eyes',   label:'Eyes',             short:'eyes',       weight:1.25 },
  { key:'nose',   label:'Nose',             short:'nose',       weight:1.25 },
  { key:'shape',  label:'Face shape',       short:'face shape', weight:1.15 },
  { key:'jaw',    label:'Jaw & chin',       short:'jaw',        weight:1.10 },
  { key:'mouth',  label:'Mouth & lips',     short:'mouth',      weight:1.00 },
  { key:'cheeks', label:'Cheeks & midface', short:'cheeks',     weight:0.90 },
  { key:'brows',  label:'Eyebrows',         short:'eyebrows',   weight:0.90 },
  { key:'colour', label:'Colouring',        short:'colouring',  weight:0.60 }
];
var RX_FEATURE_KEYS = RX_FEATURES.map(function(f){ return f.key; });
function rxFeature(key){ return RX_FEATURES.filter(function(f){ return f.key === key; })[0] || null; }

/* ---- 1. measurements → features ----
   Weighted mean of the measurements belonging to a feature, skipping any that were unavailable or
   ruled out by expression. A feature with nothing left is null, not zero: "could not be measured"
   and "measured, and they are nothing alike" must never come out looking the same. */
/* What fraction of each feature's weight actually produced a number — 1 when everything in it was
   measurable, 0 when none of it was. */
function rxCoverage(mscores){
  var got = {}, all = {}, out = {};
  RX_MEASURES.forEach(function(m){
    all[m.feature] = (all[m.feature] || 0) + m.w;
    var v = mscores[m.key];
    if(typeof v === 'number' && isFinite(v)) got[m.feature] = (got[m.feature] || 0) + m.w;
  });
  RX_FEATURE_KEYS.forEach(function(fk){ out[fk] = all[fk] ? (got[fk] || 0) / all[fk] : 0; });
  return out;
}

function rxRollUp(mscores){
  var out = {};
  RX_FEATURE_KEYS.forEach(function(fk){ out[fk] = null; });
  var acc = {};
  RX_MEASURES.forEach(function(m){
    var v = mscores[m.key];
    if(typeof v !== 'number' || !isFinite(v)) return;
    if(!acc[m.feature]) acc[m.feature] = { s: 0, w: 0 };
    acc[m.feature].s += v * m.w;
    acc[m.feature].w += m.w;
  });
  Object.keys(acc).forEach(function(fk){ if(acc[fk].w > 0) out[fk] = acc[fk].s / acc[fk].w; });
  return out;
}

/* One reading: the child's measurements against everyone else's. Keeps both levels — the individual
   measurements (so the result can say WHICH thing matched) and the feature roll-up. */
function rxRound(childVals, peopleVals, blocked){
  var measures = {}, features = {}, coverage = {}, n = peopleVals.length;
  RX_MEASURES.forEach(function(m){ measures[m.key] = new Array(n); });
  RX_FEATURE_KEYS.forEach(function(fk){ features[fk] = new Array(n); coverage[fk] = new Array(n); });
  peopleVals.forEach(function(vals, p){
    var ms = rxCompare(childVals, vals, blocked && blocked[p]);
    RX_MEASURES.forEach(function(m){ measures[m.key][p] = ms[m.key]; });
    var fs = rxRollUp(ms), cv = rxCoverage(ms);
    RX_FEATURE_KEYS.forEach(function(fk){ features[fk][p] = fs[fk]; coverage[fk][p] = cv[fk]; });
  });
  return { measures: measures, features: features, coverage: coverage };
}

/* ---- 2. several readings → one table ----
   Mean over the readings that produced a number, and the spread between them. The spread is the
   honesty channel: it is how the UI knows the difference between two readings agreeing on 71 and one
   saying 45 while the other said 88. */
function rxMergeRounds(rounds, n){
  function fold(pick, keys){
    var t = {};
    keys.forEach(function(k){
      var mean = [], spread = [], p, i, vals, sum;
      for(p = 0; p < n; p++){
        vals = [];
        for(i = 0; i < rounds.length; i++){
          var v = pick(rounds[i])[k][p];
          if(typeof v === 'number' && isFinite(v)) vals.push(v);
        }
        if(!vals.length){ mean.push(null); spread.push(0); continue; }
        sum = vals.reduce(function(a, b){ return a + b; }, 0);
        mean.push(sum / vals.length);
        spread.push(Math.max.apply(null, vals) - Math.min.apply(null, vals));
      }
      t[k] = { mean: mean, spread: spread };
    });
    return t;
  }
  return {
    features: fold(function(r){ return r.features; }, RX_FEATURE_KEYS),
    coverage: fold(function(r){ return r.coverage; }, RX_FEATURE_KEYS),
    measures: fold(function(r){ return r.measures; }, RX_MEASURES.map(function(m){ return m.key; }))
  };
}

/* ---- 3. the overall score ----
   Two numbers per person, because they answer different questions. `raw` is how alike they are at
   all; `share` is the same numbers normalised to 100 — the "60% Mum / 40% Dad" split people want.
   Two people can be 80 and 78 alike (a strong family face, no winner) or 30 and 28 (nobody
   especially), and share alone cannot tell those apart. */
function rxOverall(table, n){
  // A feature counts only if EVERY person has a score for it. If a grin made the child's mouth
  // uncomparable against one parent, that mouth cannot quietly be counted for the other parent
  // instead — the comparison has to be like for like or it is not a comparison.
  var usable = {};
  RX_FEATURE_KEYS.forEach(function(key){
    var slot = table.features[key], cov = table.coverage && table.coverage[key], p;
    usable[key] = !!slot;
    if(!slot) return;
    for(p = 0; p < n; p++){
      if(typeof slot.mean[p] !== 'number') usable[key] = false;
      if(cov && cov.mean[p] !== null && cov.mean[p] < RX_MIN_COVERAGE) usable[key] = false;
    }
  });

  var raw = [], p, i, f, v, vsum, wsum;
  for(p = 0; p < n; p++){
    vsum = 0; wsum = 0;
    for(i = 0; i < RX_FEATURES.length; i++){
      f = RX_FEATURES[i];
      if(!usable[f.key]) continue;
      v = table.features[f.key].mean[p];
      if(typeof v !== 'number') continue;
      vsum += v * f.weight; wsum += f.weight;
    }
    raw.push(wsum ? vsum / wsum : null);
  }
  var total = raw.reduce(function(a, b){ return a + (typeof b === 'number' ? b : 0); }, 0);
  return { raw: raw, share: raw.map(function(v){
    return (typeof v !== 'number' || total <= 0) ? null : (v / total) * 100; }) };
}

/* ---- 4. calling a feature ---- */
function rxFeatureCall(table, key, n){
  var slot = table.features[key];
  if(!slot) return { key: key, winner: -1, margin: 0, shared: true, unsteady: false, answered: false };
  var ranked = [], p;
  for(p = 0; p < n; p++) if(typeof slot.mean[p] === 'number') ranked.push({ person: p, score: slot.mean[p] });
  if(!ranked.length) return { key: key, winner: -1, margin: 0, shared: true, unsteady: false, partial: false, answered: false };
  ranked.sort(function(a, b){ return b.score - a.score; });
  var margin = ranked.length > 1 ? ranked[0].score - ranked[1].score : ranked[0].score;
  var worst = Math.max.apply(null, slot.spread.concat([0]));
  // Scored for some people but not all — whoever remains has not won anything, they are simply the
  // only one left standing — or scored for everyone but on too little of the feature to mean it.
  var cov = table.coverage && table.coverage[key];
  var thin = false, q;
  if(cov) for(q = 0; q < n; q++) if(cov.mean[q] !== null && cov.mean[q] < RX_MIN_COVERAGE) thin = true;
  var partial = ranked.length < n || thin;
  return {
    key: key,
    winner: ranked[0].person,
    margin: margin,
    shared: ranked.length > 1 && margin < RX_FEATURE_MARGIN,
    // The readings disagreed with each other by more than the people differ: nothing has been shown.
    unsteady: worst > Math.max(RX_FEATURE_MARGIN, margin * 2),
    partial: partial,
    answered: true
  };
}
function rxAllCalls(table, n){
  return RX_FEATURE_KEYS.map(function(key){ return rxFeatureCall(table, key, n); });
}
function rxAttributed(c){ return c.answered && !c.shared && !c.unsteady && !c.partial; }
function rxWonBy(calls, person){
  return calls.filter(function(c){ return c.winner === person && rxAttributed(c); })
              .map(function(c){ return rxFeature(c.key); }).filter(Boolean);
}

/* Why a feature came out the way it did, in the app's own words rather than a model's: the single
   measurement in it that matched best, and the one that matched worst. Derived from the numbers on
   screen, so it can always be checked against them. */
function rxFeatureNote(table, key, person){
  var best = null, worst = null;
  RX_MEASURES.forEach(function(m){
    if(m.feature !== key) return;
    var v = table.measures[m.key] && table.measures[m.key].mean[person];
    if(typeof v !== 'number') return;
    if(!best || v > best.v) best = { m: m, v: v };
    if(!worst || v < worst.v) worst = { m: m, v: v };
  });
  if(!best) return '';
  if(!worst || worst.m === best.m || best.v - worst.v < 12) return 'closest on ' + best.m.label;
  return 'closest on ' + best.m.label + ', furthest on ' + worst.m.label;
}

/* ---- 5. the headline ----
   How steady the readings were counts as much as the gap: a 12-point lead assembled from two
   readings that each named a different leader is not a 12-point lead. */
function rxStability(rounds, n, leader){
  if(!rounds.length || leader < 0) return 1;
  var agree = 0;
  rounds.forEach(function(rd){
    var one = rxOverall(rxMergeRounds([rd], n), n).raw, best = -1, bestV = -1, p;
    for(p = 0; p < n; p++) if(typeof one[p] === 'number' && one[p] > bestV){ bestV = one[p]; best = p; }
    if(best === leader) agree++;
  });
  return agree / rounds.length;
}

function rxVerdict(overall, calls, rounds, n){
  var ranked = [], p;
  for(p = 0; p < n; p++) if(typeof overall.raw[p] === 'number') ranked.push({ person: p, score: overall.raw[p] });
  ranked.sort(function(a, b){ return b.score - a.score; });
  if(!ranked.length) return { leader: -1, runnerUp: -1, gap: 0, confidence: 'none', stability: 0, mix: [] };

  var leader = ranked[0].person;
  var runnerUp = ranked.length > 1 ? ranked[1].person : -1;
  // With nobody to come second there is no gap. Calling the lone person's own score a "gap" would
  // read as a landslide over an opponent who was never there.
  var gap = ranked.length > 1 ? ranked[0].score - ranked[1].score : 0;
  var stability = rxStability(rounds, n, leader);

  var confidence = 'mix';
  if(ranked.length < 2) confidence = 'only';
  else if(gap >= RX_CLEAR_GAP && stability >= 0.99) confidence = 'clear';
  else if(gap >= RX_LEAN_GAP && stability >= 0.5) confidence = 'lean';

  return { leader: leader, runnerUp: runnerUp, gap: gap, confidence: confidence, stability: stability,
           mix: calls.filter(rxAttributed) };
}

/* Kept here rather than in the UI so the wording is testable: the one thing this app must never do
   is say "clearly Dad" over a two-point gap. */
function rxHeadline(verdict, names){
  var who = names[verdict.leader], other = verdict.runnerUp >= 0 ? names[verdict.runnerUp] : null;
  if(verdict.leader < 0) return 'No comparison could be made.';
  if(verdict.confidence === 'only') return 'Compared with ' + who + ' alone';
  if(verdict.confidence === 'clear') return 'Takes after ' + who;
  if(verdict.confidence === 'lean') return 'Leans towards ' + who;
  return other ? 'A genuine mix of ' + who + ' and ' + other : 'A genuine mix';
}

if(typeof module !== 'undefined' && module.exports){
  module.exports = { RX_FEATURES: RX_FEATURES, RX_FEATURE_KEYS: RX_FEATURE_KEYS,
    RX_FEATURE_MARGIN: RX_FEATURE_MARGIN, RX_CLEAR_GAP: RX_CLEAR_GAP, RX_LEAN_GAP: RX_LEAN_GAP,
    RX_MIN_COVERAGE: RX_MIN_COVERAGE, rxFeature: rxFeature, rxAttributed: rxAttributed,
    rxRollUp: rxRollUp, rxCoverage: rxCoverage, rxRound: rxRound, rxMergeRounds: rxMergeRounds,
    rxOverall: rxOverall, rxFeatureCall: rxFeatureCall, rxAllCalls: rxAllCalls, rxWonBy: rxWonBy,
    rxFeatureNote: rxFeatureNote, rxStability: rxStability, rxVerdict: rxVerdict, rxHeadline: rxHeadline };
}
