/* resemble.js — the comparison itself: what gets asked, how the answers get combined, and what
   verdict comes out the other end. Pure logic: no DOM, no network, no canvas. Everything here is a
   plain function over plain data so the part that is easy to get quietly wrong — the scoring — can
   be unit-tested without a browser or an API key.

   THE PROBLEM WITH ASKING ONCE. "Who does she look like, Mum or Dad?" is exactly the kind of
   question a model will answer confidently and inconsistently. Three known ways the answer drifts:

     • Name bias. Told a photo is "Dad", a model reaches for what it expects a child to share with a
       father. So names NEVER leave this device. Photos go up labelled A, B, C and come back as
       A, B, C; the names are re-attached here, afterwards.
     • Position bias. Whoever is shown first tends to score a little higher. So each pass sends the
       photos in a different order — a shuffled base rotated one step per pass, which guarantees a
       given person sits in a different slot every time rather than merely hoping a reshuffle moves
       them.
     • Halo. One "she's the image of him" impression bleeds across every feature. So each feature is
       scored on its own, and features that disagree are reported as disagreeing rather than being
       smoothed into one number.

   WHAT COMES BACK. Per pass, a 0–100 similarity for every (feature, person) pair. Those are averaged
   across passes; the spread between passes is kept, because a feature that swung 30 points between
   passes has not been measured, it has been guessed, and the UI says so instead of picking a winner.

   Not a paternity or identity test — see the note in index.html. This measures what a careful
   observer would say about two faces, which is a real thing, and is not evidence of anything. */

/* ---- the features, and why these ----
   Ten traits that (a) a person can actually point at in a photo, and (b) survive the age gap between
   a toddler and an adult. Weights tilt the overall score towards bone structure — nose bridge, eye
   spacing, jaw, proportions — because that is what stays put as a face grows. Colouring is real and
   heritable but it is one of the first things a camera gets wrong, so it counts least. */
var RX_FEATURES = [
  { key:'eyes',      label:'Eyes',            short:'eyes',      weight:1.25 },
  { key:'nose',      label:'Nose',            short:'nose',      weight:1.25 },
  { key:'shape',     label:'Face shape',      short:'face shape',weight:1.15 },
  { key:'jaw',       label:'Jaw & chin',      short:'jaw',       weight:1.10 },
  { key:'mouth',     label:'Mouth & lips',    short:'mouth',     weight:1.00 },
  { key:'brows',     label:'Eyebrows',        short:'eyebrows',  weight:0.90 },
  { key:'cheeks',    label:'Cheeks',          short:'cheeks',    weight:0.90 },
  { key:'ears',      label:'Ears',            short:'ears',      weight:0.70 },
  { key:'hairline',  label:'Hairline & hair', short:'hairline',  weight:0.70 },
  { key:'colouring', label:'Colouring',       short:'colouring', weight:0.60 }
];
var RX_FEATURE_KEYS = RX_FEATURES.map(function(f){ return f.key; });

/* How big a difference has to be before it is called a difference. Both are in raw 0–100 similarity
   points and both are deliberately blunt: a 3-point edge on a judgement this soft is noise. */
var RX_FEATURE_MARGIN = 8;   // per-feature: below this, the feature is shared, not won
var RX_CLEAR_GAP     = 10;   // overall: a clear resemblance
var RX_LEAN_GAP      = 4;    // overall: a lean; below it, a genuine mix

function rxLabel(i){ return String.fromCharCode(65 + i); }            // 0 → 'A'
function rxFeature(key){ return RX_FEATURES.filter(function(f){ return f.key === key; })[0] || null; }

/* ---- 1. planning the passes (blinding + order) ----
   A permutation per pass: order[slot] = index of the person shown in that slot, so slot 0 is
   photo "A". The base order is shuffled, then rotated one step per pass. Rotation (rather than a
   fresh shuffle each time) is what makes the position spread even: over k ≤ n passes nobody
   occupies the same slot twice, so first-photo bias is shared out instead of landing on one person.
   `rand` is injectable so tests are deterministic. */
function rxShuffle(n, rand){
  var r = rand || Math.random, a = [], i, j, t;
  for(i = 0; i < n; i++) a.push(i);
  for(i = n - 1; i > 0; i--){ j = Math.floor(r() * (i + 1)); t = a[i]; a[i] = a[j]; a[j] = t; }
  return a;
}
function rxPlanRounds(n, rounds, rand){
  var base = rxShuffle(n, rand), plan = [], r, i, order;
  for(r = 0; r < rounds; r++){
    order = [];
    for(i = 0; i < n; i++) order.push(base[(i + r) % n]);
    plan.push(order);
  }
  return plan;
}

/* ---- 2. one pass of letters → scores per person ----
   The server answers in letters because that is all it was ever shown. `order` maps them back:
   the score under letter A belongs to person order[0]. A missing letter becomes null rather than 0 —
   "not answered" and "answered zero" must not average to the same thing. */
function rxRoundScores(order, featuresByLetter){
  var out = {}, n = order.length;
  RX_FEATURE_KEYS.forEach(function(key){
    var got = (featuresByLetter || {})[key] || {}, scores = new Array(n), s, v;
    for(s = 0; s < n; s++){
      v = got[rxLabel(s)];
      scores[order[s]] = (typeof v === 'number' && isFinite(v)) ? Math.max(0, Math.min(100, v)) : null;
    }
    out[key] = { scores: scores, note: typeof got.note === 'string' ? got.note : '' };
  });
  return out;
}

/* ---- 3. many passes → one table ----
   Mean per (feature, person) over the passes that actually answered, plus the spread (max − min).
   Spread is the honesty channel: it is how the UI knows the difference between "these two passes
   agreed on 71" and "one said 45, the other 88, and the mean of 66 means nothing". */
function rxMerge(rounds, n){
  var table = {};
  RX_FEATURE_KEYS.forEach(function(key){
    var mean = [], spread = [], notes = [], p, vals, i, sum;
    for(p = 0; p < n; p++){
      vals = [];
      for(i = 0; i < rounds.length; i++){
        var v = rounds[i][key] && rounds[i][key].scores[p];
        if(typeof v === 'number') vals.push(v);
      }
      if(!vals.length){ mean.push(null); spread.push(0); continue; }
      sum = vals.reduce(function(a, b){ return a + b; }, 0);
      mean.push(sum / vals.length);
      spread.push(Math.max.apply(null, vals) - Math.min.apply(null, vals));
    }
    rounds.forEach(function(rd){ if(rd[key] && rd[key].note) notes.push(rd[key].note); });
    table[key] = { mean: mean, spread: spread, notes: notes };
  });
  return table;
}

/* ---- 4. the overall score ----
   Weighted mean across features, skipping any a pass failed to answer so one missing ear does not
   drag a person down. Returns raw 0–100 similarity per person, plus `share`: the same numbers
   normalised to sum to 100, which is the "60% Mum / 40% Dad" split people actually want. The two say
   different things and both are shown — raw is "how alike are they at all", share is "which of you".
   Two people can be 80 and 78 alike (a strong family face, no winner) or 30 and 28 (nobody
   especially), and share alone cannot tell those apart. */
function rxOverall(table, n){
  var raw = [], p, wsum, vsum, i, f, v;
  for(p = 0; p < n; p++){
    wsum = 0; vsum = 0;
    for(i = 0; i < RX_FEATURES.length; i++){
      f = RX_FEATURES[i];
      v = table[f.key] ? table[f.key].mean[p] : null;
      if(typeof v !== 'number') continue;
      vsum += v * f.weight; wsum += f.weight;
    }
    raw.push(wsum ? vsum / wsum : null);
  }
  var total = raw.reduce(function(a, b){ return a + (typeof b === 'number' ? b : 0); }, 0);
  var share = raw.map(function(v){
    if(typeof v !== 'number' || total <= 0) return null;
    return (v / total) * 100;
  });
  return { raw: raw, share: share };
}

/* ---- 5. calling each feature ----
   Who won this feature, by how much, and whether that margin is worth saying out loud. A feature is
   "shared" when the top two are within RX_FEATURE_MARGIN, and "unsteady" when the passes disagreed
   with each other by more than they disagreed about the people — measured, not asserted. */
function rxFeatureCall(table, key, n){
  var mean = table[key].mean, spread = table[key].spread;
  var ranked = [], p;
  for(p = 0; p < n; p++) if(typeof mean[p] === 'number') ranked.push({ person: p, score: mean[p] });
  if(!ranked.length) return { key: key, winner: -1, margin: 0, shared: true, unsteady: false, answered: false };
  ranked.sort(function(a, b){ return b.score - a.score; });
  var margin = ranked.length > 1 ? ranked[0].score - ranked[1].score : ranked[0].score;
  var worstSpread = Math.max.apply(null, spread.filter(function(s){ return typeof s === 'number'; }).concat([0]));
  return {
    key: key,
    winner: ranked[0].person,
    margin: margin,
    shared: ranked.length > 1 && margin < RX_FEATURE_MARGIN,
    unsteady: worstSpread > Math.max(RX_FEATURE_MARGIN, margin * 2),
    answered: true
  };
}
function rxAllCalls(table, n){
  return RX_FEATURE_KEYS.map(function(key){ return rxFeatureCall(table, key, n); });
}

/* ---- 6. the headline ----
   How steady the answer was across passes matters as much as the gap: a 12-point lead that came from
   two passes which each named a different leader is not a 12-point lead. `stability` is the fraction
   of passes whose own leader matches the overall leader. */
function rxStability(rounds, n, leader){
  if(!rounds.length || leader < 0) return 1;
  var agree = 0;
  rounds.forEach(function(rd){
    var one = rxOverall(rxMerge([rd], n), n).raw, best = -1, bestV = -1, p;
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
  // With nobody to come second there is no gap to measure. Calling the lone person's own score a
  // "gap" would read as a landslide over an opponent who was never there.
  var gap = ranked.length > 1 ? ranked[0].score - ranked[1].score : 0;
  var stability = rxStability(rounds, n, leader);

  var confidence = 'mix';
  if(ranked.length < 2) confidence = 'only';
  else if(gap >= RX_CLEAR_GAP && stability >= 0.99) confidence = 'clear';
  else if(gap >= RX_LEAN_GAP && stability >= 0.5) confidence = 'lean';

  // Which features each person actually carries — the "your eyes, his nose" line.
  var mix = calls.filter(function(c){ return c.answered && !c.shared && !c.unsteady; });
  return { leader: leader, runnerUp: runnerUp, gap: gap, confidence: confidence, stability: stability, mix: mix };
}

/* Features a given person won outright, in the order they are listed (strongest traits first). */
function rxWonBy(calls, person){
  return calls.filter(function(c){ return c.winner === person && c.answered && !c.shared && !c.unsteady; })
              .map(function(c){ return rxFeature(c.key); })
              .filter(Boolean);
}

/* A plain-English headline. Kept here rather than in the UI so the wording is testable: the one
   thing this app must never do is say "clearly Dad" over a 2-point gap. */
function rxHeadline(verdict, names){
  var who = names[verdict.leader], other = verdict.runnerUp >= 0 ? names[verdict.runnerUp] : null;
  if(verdict.leader < 0) return 'No comparison could be made.';
  if(verdict.confidence === 'only') return 'Compared with ' + who + ' alone';
  if(verdict.confidence === 'clear') return 'Takes after ' + who;
  if(verdict.confidence === 'lean') return 'Leans towards ' + who;
  return other ? 'A genuine mix of ' + who + ' and ' + other : 'A genuine mix';
}

/* Node's test runner imports this file directly for the pure-logic tests; the browser loads it as a
   plain script, where `module` does not exist. */
if(typeof module !== 'undefined' && module.exports){
  module.exports = { RX_FEATURES: RX_FEATURES, RX_FEATURE_KEYS: RX_FEATURE_KEYS, RX_FEATURE_MARGIN: RX_FEATURE_MARGIN,
    RX_CLEAR_GAP: RX_CLEAR_GAP, RX_LEAN_GAP: RX_LEAN_GAP, rxLabel: rxLabel, rxFeature: rxFeature, rxShuffle: rxShuffle,
    rxPlanRounds: rxPlanRounds, rxRoundScores: rxRoundScores, rxMerge: rxMerge, rxOverall: rxOverall,
    rxFeatureCall: rxFeatureCall, rxAllCalls: rxAllCalls, rxStability: rxStability, rxVerdict: rxVerdict,
    rxWonBy: rxWonBy, rxHeadline: rxHeadline };
}
