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
  var rxM = require('./measure.js');
  globalThis.RX_MEASURES = rxM.RX_MEASURES;
  globalThis.rxCompare = rxM.rxCompare;
  globalThis.rxWeights = rxM.rxWeights;
}

/* ---- the two scales ----
   The app scores on the blend of a face-recognition embedding and the measurements when the model is
   available, and on the measurements alone when it is not (an old browser, a failed download). Those
   are different rulers with different noise, so each carries its own thresholds and its own measured
   null — using the geometry's thresholds on the blend, or the reverse, would be the same mistake as
   before in a new coat. Both sets were derived the same way: 4000 simulated comparisons between one
   child and two UNRELATED adults, on KinFaceW-II. See tools/README-calibration.md. */
var RX_EMB_WEIGHT = 0.6;      // blend: 60% recognition model, 40% measurements. Tuned on a training
                              // half and confirmed on the held-out half (0.868 vs 0.845 and 0.734).
var RX_EMB_LO = -0.1314;      // 1st and 99th percentile of the cosine between two aligned faces,
var RX_EMB_HI = 0.3079;       // used to put the embedding on the same 0-100 scale as the geometry.

/* ---- the feature-by-feature ruler ----
   When the per-region maps in kinmap.js are loaded, the eyes, nose and mouth rows stop being
   landmark ratios and become network evidence about that feature, and the arithmetic above changes
   with them. Measured on KinFaceW-I — a second dataset whose parent and child photographs were
   taken on different days, so there is no shared lighting to exploit — the headline goes from 0.848
   to 0.878 and picking the real parent out of a lineup of two from 85.9% to 88.7%.

   These constants are separate from the two above rather than replacing them, because each set is
   internally consistent with the null distribution measured alongside it. Mixing a scale from one
   with a threshold from the other is how the first version of this app came to announce winners it
   had not found.

   RX_REGION_WEIGHT is 0 because the grid said so: with the network's answer for a feature in hand,
   the landmark ratios for that same feature added nothing on top. They are still computed — they
   are what the app falls back to when the maps do not load, they are what decides whether a feature
   is usable at all, and an expression or a pair of sunglasses still rules a feature out through
   them. */
var RX_ID_WEIGHT = 0.35;      // how much of the headline is "is this the same face at all", with the
                              // rest coming from the eight features. 0.6 without the region maps.
var RX_ID_LO = -0.1218;       // the same 1st/99th-percentile scaling as above, re-measured over both
var RX_ID_HI = 0.3479;        // datasets for the path that uses it.
var RX_REGION_WEIGHT = 0;     // weight kept on the landmark measurements for a region-backed feature
var RX_REGION_SCALE = {       // 1st and 99th percentile of each region's mapped cosine
  eyes:  [-0.2532, 0.5318],
  nose:  [-0.2822, 0.5776],
  mouth: [-0.2577, 0.5511]
};
function rxRegionLikeness(name, cosine){
  var s = RX_REGION_SCALE[name];
  if(!s || typeof cosine !== 'number' || !isFinite(cosine)) return null;
  return Math.max(0, Math.min(100, 100 * (cosine - s[0]) / (s[1] - s[0])));
}
function rxIdLikeness(cosine){
  if(typeof cosine !== 'number' || !isFinite(cosine)) return null;
  return Math.max(0, Math.min(100, 100 * (cosine - RX_ID_LO) / (RX_ID_HI - RX_ID_LO)));
}

/* ---- is this the same person twice? ----
   The obvious sanity check — compare someone with themselves — produced "a genuine mix of Dad and
   Mum" and two ordinary-looking likeness scores, because the 0-100 scale above tops out in FAMILY
   territory and anything closer simply clamps to 100. The model underneath is a recognition model:
   telling one person from another is the thing it is actually built for, and that answer was being
   thrown away.

   Measured on the standard LFW verification pairs through this exact pipeline, plus the KinFaceW
   parent/child pairs for comparison:

     same person       n=593   median cosine 0.600
     parent and child  n=836   median cosine 0.125,  95th percentile 0.298
     two strangers     n=587   median cosine 0.009,  95th percentile 0.116

   Three separated populations. At 0.40 the line catches 92.9% of same-person pairs while wrongly
   flagging 0.0% of strangers and 0.5% of real parent/child pairs. The scale itself is deliberately
   NOT stretched to cover this: widening it to reach 0.6 would squash the whole family range into the
   bottom third, and telling families apart is the app's actual job. Same-person is announced
   separately instead. */
var RX_SAME_PERSON_COS = 0.40;
function rxSamePerson(cosine){
  return typeof cosine === 'number' && isFinite(cosine) && cosine >= RX_SAME_PERSON_COS;
}

/* Identity is transitive, and using that is worth about one catch in fourteen.
   At this threshold 7.1% of genuine same-person pairs fall below it — the hard ones: a big age gap,
   a profile, bad light, a toddler looking down. Comparing only each candidate against the CHILD
   tests n pairs and misses those. Comparing every pair and joining the links tests n(n+1)/2, so one
   weak edge is rescued by any strong edge elsewhere in the group: three photographs of one person
   are recognised as one person even when one of the three pairings is a poor match.

   Takes a full pairwise cosine matrix (index 0 is the child) and returns, for each face, whether it
   ends up in the child's group. Plain union-find; no lowering of the threshold, which would start
   accusing real parents and children instead. */
function rxIdentityGroup(cos){
  var n = cos.length, parent = [], i, j;
  for(i = 0; i < n; i++) parent.push(i);
  function find(x){ while(parent[x] !== x){ parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
  function union(a, b){ a = find(a); b = find(b); if(a !== b) parent[b] = a; }
  for(i = 0; i < n; i++){
    for(j = i + 1; j < n; j++){
      if(cos[i] && rxSamePerson(cos[i][j])) union(i, j);
    }
  }
  var out = [];
  for(i = 0; i < n; i++) out.push(find(i) === find(0));
  return out;
}

var RX_SCALES = {
  blend: {
    clear: 27, lean: 16,
    nullGap: [{ gap: 9.3, chance: 50 }, { gap: 15.8, chance: 25 }, { gap: 22.8, chance: 10 },
              { gap: 27.0, chance: 5 }, { gap: 33.9, chance: 1 }]
  },
  geometry: {
    clear: 19, lean: 11,
    nullGap: [{ gap: 6.0, chance: 50 }, { gap: 10.4, chance: 25 }, { gap: 15.6, chance: 10 },
              { gap: 18.7, chance: 5 }, { gap: 25.2, chance: 1 }]
  },
  /* The region ruler, measured the same way on KinFaceW-I: 2724 comparisons between one child and
     two UNRELATED adults, scored exactly as the app scores them. A true parent beats a stranger by
     19.2 points at the median — comfortably clear of the 15.4 that chance manages a quarter of the
     time, which is the whole reason these thresholds exist. */
  regions: {
    clear: 27, lean: 15,
    nullGap: [{ gap: 9.3, chance: 50 }, { gap: 15.4, chance: 25 }, { gap: 22.6, chance: 10 },
              { gap: 27.4, chance: 5 }, { gap: 36.9, chance: 1 }]
  }
};
var rxScale = RX_SCALES.geometry;
function rxUseScale(name){ rxScale = RX_SCALES[name] || RX_SCALES.geometry; return rxScale; }
/* An embedding cosine on the same 0-100 ruler as the measurements. */
function rxEmbLikeness(cosine){
  if(typeof cosine !== 'number' || !isFinite(cosine)) return null;
  return Math.max(0, Math.min(100, 100 * (cosine - RX_EMB_LO) / (RX_EMB_HI - RX_EMB_LO)));
}

/* These three numbers are the whole of this app's restraint, and the first version got them badly
   wrong. They were set by judgement; measured against a null distribution built from 4000 simulated
   three-photo comparisons between UNRELATED people, the old "clear lead" threshold of 10 points fired
   on pure chance 27% of the time, and the old "lean" threshold of 4 points fired 65% of the time.
   The app was therefore announcing winners it had not found — which is exactly what it did to one
   father, on a 14-point gap that chance alone produces 13% of the time.

   They are now set from that null: a gap has to be larger than 75% of chance gaps before the app
   will say "leans", and larger than 95% of them before it will say "takes after". */
/* The per-feature bar stays on the geometry scale whichever headline ruler is in use, because the
   feature scores ARE the measurements — the recognition model produces one number and has no opinion
   about whose nose anyone has. */
var RX_FEATURE_MARGIN = 10;

/* Roughly how often a gap this big turns up between two unrelated people, on whichever ruler is in
   use. This is the number that stops a margin being presented bare. */
function rxChanceOf(gap){
  var N = rxScale.nullGap;
  if(gap >= N[N.length - 1].gap) return 1;
  for(var i = 0; i < N.length; i++) if(gap < N[i].gap) return i === 0 ? 100 : N[i - 1].chance;
  return 1;
}
/* A feature is scored from several measurements. If an expression knocks out most of them, what is
   left is not really that feature any more — a mouth judged on philtrum length alone is not a mouth.
   Below this fraction of a feature's weight, it stops being attributable to anyone. */
var RX_MIN_COVERAGE = 0.5;

/* The eight features. The weights are measured, not chosen: each is the mean measured kin signal of
   the measurements inside it (see measure.js and tools/README-calibration.md). The previous version
   of this table weighted colouring LAST, at 0.60, on the reasoning that a camera gets colour wrong
   and bone structure survives childhood. Against 849 real parent/child pairs, colouring turned out
   to be far and away the strongest family signal and the bone-structure ratios the weakest — so the
   ordering here is now upside down compared with what seemed obvious, because the data said so.

   Ears and hairline are still absent: a face mesh stops at the face, so they cannot be measured, and
   guessing at them would be the dishonest half of the answer. */
/* `weight` is the measured kin signal of a feature read off the landmarks. `mapped` is the same
   quantity when the region maps are loaded and eyes, nose and mouth are read by the network
   instead — measured the same way, over both KinFaceW datasets. The ordering turns over again:
   colouring, which beat every geometric measurement, is now beaten by three features the network
   can see properly. Neither table is a judgement; both are (AUC - 0.5) x 10 on real pairs. */
var RX_FEATURES = [
  { key:'colour', label:'Colouring',        short:'colouring',  weight:1.30, mapped:1.71 },
  { key:'eyes',   label:'Eyes',             short:'eyes',       weight:0.63, mapped:3.35 },
  { key:'mouth',  label:'Mouth & lips',     short:'mouth',      weight:0.62, mapped:3.17 },
  { key:'nose',   label:'Nose',             short:'nose',       weight:0.46, mapped:3.42 },
  { key:'jaw',    label:'Jaw & chin',       short:'jaw',        weight:0.46, mapped:0.67 },
  { key:'brows',  label:'Eyebrows',         short:'eyebrows',   weight:0.46, mapped:0.87 },
  { key:'shape',  label:'Face shape',       short:'face shape', weight:0.44, mapped:0.83 },
  { key:'cheeks', label:'Cheeks & midface', short:'cheeks',     weight:0.43, mapped:0.63 }
];
var RX_REGION_FEATURES = ['eyes', 'nose', 'mouth'];
var RX_FEATURE_KEYS = RX_FEATURES.map(function(f){ return f.key; });
function rxFeature(key){ return RX_FEATURES.filter(function(f){ return f.key === key; })[0] || null; }

/* ---- 1. measurements → features ----
   Weighted mean of the measurements belonging to a feature, skipping any that were unavailable or
   ruled out by expression. A feature with nothing left is null, not zero: "could not be measured"
   and "measured, and they are nothing alike" must never come out looking the same. */
/* What fraction of each feature's weight actually produced a number — 1 when everything in it was
   measurable, 0 when none of it was. */
function rxCoverage(mscores, weights){
  var got = {}, all = {}, out = {};
  RX_MEASURES.forEach(function(m){
    // Coverage is about how much of a feature survived, so it uses the BASE weights: a feature is
    // not better covered just because the traits in it happened to be unusual.
    all[m.feature] = (all[m.feature] || 0) + m.w;
    var v = mscores[m.key];
    if(typeof v === 'number' && isFinite(v)) got[m.feature] = (got[m.feature] || 0) + m.w;
  });
  RX_FEATURE_KEYS.forEach(function(fk){ out[fk] = all[fk] ? (got[fk] || 0) / all[fk] : 0; });
  return out;
}

function rxRollUp(mscores, weights){
  var out = {};
  RX_FEATURE_KEYS.forEach(function(fk){ out[fk] = null; });
  var acc = {};
  RX_MEASURES.forEach(function(m){
    var v = mscores[m.key];
    if(typeof v !== 'number' || !isFinite(v)) return;
    var w = (weights && typeof weights[m.key] === 'number') ? weights[m.key] : m.w;
    if(w <= 0) return;
    if(!acc[m.feature]) acc[m.feature] = { s: 0, w: 0 };
    acc[m.feature].s += v * w;
    acc[m.feature].w += w;
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
    var wts = rxWeights(childVals, vals, blocked && blocked[p]);
    RX_MEASURES.forEach(function(m){ measures[m.key][p] = ms[m.key]; });
    var fs = rxRollUp(ms, wts), cv = rxCoverage(ms, wts);
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
/* `embScores` is an optional array of 0-100 embedding likenesses, one per person. When present the
   headline score is the blend; when absent it is the measurements alone, and the caller is expected
   to have selected the matching scale. The per-feature table is untouched either way — the
   recognition model produces one number and cannot say whose eyes anyone has. */
/* Fold the region evidence into the merged table, in place of the landmark rows for those three
   features. Deliberately conservative in one way: a region score is only used where the landmark
   measurements for that feature survived. If a grin ruled out the mouth, or a pair of sunglasses
   ruled out the eyes, that feature stays ruled out — the network would happily read a mouth off a
   grin or eyes off dark lenses, and measuring an occluder is the mistake this app has already made
   once. The spread for a replaced row is 0 because the embedding does not wobble with the crop the
   way landmarks do; it is one reading of one aligned face. */
function rxApplyRegions(table, n, regionScores){
  if(!regionScores) return false;
  var used = false;
  RX_REGION_FEATURES.forEach(function(key){
    var slot = table.features[key], cov = table.coverage && table.coverage[key], p, v;
    if(!slot) return;
    for(p = 0; p < n; p++){
      v = regionScores[p] && regionScores[p][key];
      if(typeof v !== 'number' || !isFinite(v)) continue;
      if(typeof slot.mean[p] !== 'number') continue;                    // not measurable: leave it
      if(cov && cov.mean[p] !== null && cov.mean[p] < RX_MIN_COVERAGE) continue;
      slot.mean[p] = RX_REGION_WEIGHT * slot.mean[p] + (1 - RX_REGION_WEIGHT) * v;
      slot.spread[p] = RX_REGION_WEIGHT * slot.spread[p];
      used = true;
    }
  });
  return used;
}

function rxOverall(table, n, embScores, mapped){
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
      var w = mapped ? f.mapped : f.weight;
      vsum += v * w; wsum += w;
    }
    raw.push(wsum ? vsum / wsum : null);
  }
  var geometry = raw.slice();
  if(embScores){
    for(p = 0; p < n; p++){
      var e = embScores[p];
      if(typeof e !== 'number' || !isFinite(e)) continue;
      var ew = mapped ? RX_ID_WEIGHT : RX_EMB_WEIGHT;
      raw[p] = (typeof raw[p] === 'number')
        ? ew * e + (1 - ew) * raw[p]
        : e;                       // no measurements survived: the model alone is better than nothing
    }
  }
  var total = raw.reduce(function(a, b){ return a + (typeof b === 'number' ? b : 0); }, 0);
  return { raw: raw, geometry: geometry, embedding: embScores || null,
    share: raw.map(function(v){
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
  else if(gap >= rxScale.clear && stability >= 0.99) confidence = 'clear';
  else if(gap >= rxScale.lean && stability >= 0.5) confidence = 'lean';

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
    RX_FEATURE_MARGIN: RX_FEATURE_MARGIN,
    RX_MIN_COVERAGE: RX_MIN_COVERAGE, RX_SCALES: RX_SCALES, RX_EMB_WEIGHT: RX_EMB_WEIGHT,
    RX_EMB_LO: RX_EMB_LO, RX_EMB_HI: RX_EMB_HI, RX_SAME_PERSON_COS: RX_SAME_PERSON_COS,
    rxSamePerson: rxSamePerson, rxIdentityGroup: rxIdentityGroup, rxUseScale: rxUseScale,
    rxEmbLikeness: rxEmbLikeness,
    RX_ID_WEIGHT: RX_ID_WEIGHT, RX_ID_LO: RX_ID_LO, RX_ID_HI: RX_ID_HI,
    RX_REGION_WEIGHT: RX_REGION_WEIGHT, RX_REGION_SCALE: RX_REGION_SCALE,
    RX_REGION_FEATURES: RX_REGION_FEATURES,
    rxRegionLikeness: rxRegionLikeness, rxIdLikeness: rxIdLikeness, rxApplyRegions: rxApplyRegions,
    rxChanceOf: rxChanceOf,
    rxFeature: rxFeature, rxAttributed: rxAttributed,
    rxRollUp: rxRollUp, rxCoverage: rxCoverage, rxRound: rxRound, rxMergeRounds: rxMergeRounds,
    rxOverall: rxOverall, rxFeatureCall: rxFeatureCall, rxAllCalls: rxAllCalls, rxWonBy: rxWonBy,
    rxFeatureNote: rxFeatureNote, rxStability: rxStability, rxVerdict: rxVerdict, rxHeadline: rxHeadline };
}
