// Pure-logic tests. js/*.js ship as plain browser scripts but expose their functions through a
// module.exports guard, so the real shipped code is what runs here — no duplicated copy to drift.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const R = require('../js/resemble.js');
const F = require('../js/faces.js');
const ROOT = fileURLToPath(new URL('..', import.meta.url));

/* ---------- blinding and pass planning ---------- */

test('rxPlanRounds: over n passes nobody sits in the same slot twice', () => {
  const n = 4, plan = R.rxPlanRounds(n, n);
  for (let person = 0; person < n; person++) {
    const slots = plan.map((order) => order.indexOf(person));
    assert.equal(new Set(slots).size, n, `person ${person} should visit every slot exactly once`);
  }
});

test('rxPlanRounds: every pass is a permutation of everyone', () => {
  const plan = R.rxPlanRounds(3, 2);
  for (const order of plan) assert.deepEqual([...order].sort(), [0, 1, 2]);
});

test('rxRoundScores: letters map back through the order they were sent in', () => {
  // Sent as [person 2, person 0, person 1] → letter A is person 2.
  const round = R.rxRoundScores([2, 0, 1], { eyes: { A: 90, B: 10, C: 50, note: 'x' } });
  assert.deepEqual(round.eyes.scores, [10, 50, 90]);
  assert.equal(round.eyes.note, 'x');
});

test('rxRoundScores: a missing letter is null, not zero', () => {
  const round = R.rxRoundScores([0, 1], { ears: { A: 70 } });
  assert.equal(round.ears.scores[0], 70);
  assert.equal(round.ears.scores[1], null);
});

test('rxRoundScores: scores outside 0-100 are clamped', () => {
  const round = R.rxRoundScores([0, 1], { nose: { A: 140, B: -20 } });
  assert.deepEqual(round.nose.scores, [100, 0]);
});

/* ---------- merging passes ---------- */

const allFeatures = (perLetter) => {
  const f = {};
  for (const k of R.RX_FEATURE_KEYS) f[k] = { ...perLetter };
  return f;
};
const round = (order, perLetter) => R.rxRoundScores(order, allFeatures(perLetter));

test('rxMerge: means across passes, and the spread between them', () => {
  const rounds = [round([0, 1], { A: 80, B: 20 }), round([1, 0], { A: 40, B: 60 })];
  // pass 1: p0=80 p1=20 · pass 2: A is person 1 → p1=40, p0=60
  const t = R.rxMerge(rounds, 2);
  assert.equal(t.eyes.mean[0], 70);
  assert.equal(t.eyes.mean[1], 30);
  assert.equal(t.eyes.spread[0], 20);
  assert.equal(t.eyes.spread[1], 20);
});

test('rxMerge: a pass that skipped a person does not drag their average down', () => {
  const rounds = [round([0, 1], { A: 80, B: 80 }), R.rxRoundScores([0, 1], allFeatures({ A: 80 }))];
  const t = R.rxMerge(rounds, 2);
  assert.equal(t.eyes.mean[1], 80, 'averaged over the pass that answered, not over a phantom zero');
});

/* ---------- the overall score ---------- */

test('rxOverall: raw is a weighted mean; share splits it to 100', () => {
  const t = R.rxMerge([round([0, 1], { A: 90, B: 30 })], 2);
  const o = R.rxOverall(t, 2);
  assert.equal(Math.round(o.raw[0]), 90);
  assert.equal(Math.round(o.raw[1]), 30);
  assert.equal(Math.round(o.share[0] + o.share[1]), 100);
  assert.equal(Math.round(o.share[0]), 75);
});

test('rxOverall: share cannot distinguish two strong from two weak — raw can', () => {
  const strong = R.rxOverall(R.rxMerge([round([0, 1], { A: 80, B: 78 })], 2), 2);
  const weak = R.rxOverall(R.rxMerge([round([0, 1], { A: 30, B: 29.25 })], 2), 2);
  assert.ok(Math.abs(strong.share[0] - weak.share[0]) < 1, 'shares are near-identical');
  assert.ok(strong.raw[0] - weak.raw[0] > 40, 'raw likeness is not');
});

test('rxOverall: structural features outweigh colouring', () => {
  // Person 0 wins only colouring; person 1 wins only the nose. The nose weighs more.
  const scores = { eyes: { A: 50, B: 50 }, nose: { A: 20, B: 90 }, shape: { A: 50, B: 50 },
    jaw: { A: 50, B: 50 }, mouth: { A: 50, B: 50 }, brows: { A: 50, B: 50 }, cheeks: { A: 50, B: 50 },
    ears: { A: 50, B: 50 }, hairline: { A: 50, B: 50 }, colouring: { A: 90, B: 20 } };
  const o = R.rxOverall(R.rxMerge([R.rxRoundScores([0, 1], scores)], 2), 2);
  assert.ok(o.raw[1] > o.raw[0], 'the nose should carry more weight than colouring');
});

/* ---------- calling features ---------- */

test('rxFeatureCall: a small gap is shared, a big one has a winner', () => {
  const close = R.rxMerge([round([0, 1], { A: 62, B: 58 })], 2);
  const clear = R.rxMerge([round([0, 1], { A: 80, B: 40 })], 2);
  assert.equal(R.rxFeatureCall(close, 'eyes', 2).shared, true);
  const won = R.rxFeatureCall(clear, 'eyes', 2);
  assert.equal(won.shared, false);
  assert.equal(won.winner, 0);
  assert.equal(won.margin, 40);
});

test('rxFeatureCall: passes that wildly disagree are flagged unsteady, not averaged into a verdict', () => {
  const rounds = [round([0, 1], { A: 90, B: 20 }), round([0, 1], { A: 30, B: 80 })];
  const call = R.rxFeatureCall(R.rxMerge(rounds, 2), 'eyes', 2);
  assert.equal(call.unsteady, true);
});

test('rxFeatureCall: a feature nobody could see is answered:false, not a 0-0 draw', () => {
  const rounds = [R.rxRoundScores([0, 1], allFeatures({}))];
  const call = R.rxFeatureCall(R.rxMerge(rounds, 2), 'ears', 2);
  assert.equal(call.answered, false);
});

test('rxWonBy: only outright, steady wins are attributed to a person', () => {
  const rounds = [R.rxRoundScores([0, 1], {
    eyes: { A: 85, B: 40 },        // clear win for person 0
    nose: { A: 61, B: 59 },        // too close
    shape: { A: 30, B: 88 },       // clear win for person 1
    jaw: { A: 50, B: 50 }, mouth: { A: 50, B: 50 }, brows: { A: 50, B: 50 },
    cheeks: { A: 50, B: 50 }, ears: { A: 50, B: 50 }, hairline: { A: 50, B: 50 }, colouring: { A: 50, B: 50 }
  })];
  const calls = R.rxAllCalls(R.rxMerge(rounds, 2), 2);
  assert.deepEqual(R.rxWonBy(calls, 0).map((f) => f.key), ['eyes']);
  assert.deepEqual(R.rxWonBy(calls, 1).map((f) => f.key), ['shape']);
});

/* ---------- the verdict, and refusing to overclaim ---------- */

const verdictFor = (perLetter, passes = 1) => {
  const rounds = Array.from({ length: passes }, () => round([0, 1], perLetter));
  const t = R.rxMerge(rounds, 2);
  return R.rxVerdict(R.rxOverall(t, 2), R.rxAllCalls(t, 2), rounds, 2);
};

test('rxHeadline: a wide, steady gap is stated plainly', () => {
  const v = verdictFor({ A: 82, B: 35 }, 2);
  assert.equal(v.confidence, 'clear');
  assert.equal(R.rxHeadline(v, ['Mum', 'Dad']), 'Takes after Mum');
});

test('rxHeadline: a two-point gap is a mix, never a winner', () => {
  const v = verdictFor({ A: 61, B: 59 }, 2);
  assert.equal(v.confidence, 'mix');
  assert.equal(R.rxHeadline(v, ['Mum', 'Dad']), 'A genuine mix of Mum and Dad');
});

test('rxHeadline: a middling gap leans, it does not declare', () => {
  const v = verdictFor({ A: 70, B: 64 }, 2);
  assert.equal(v.confidence, 'lean');
  assert.equal(R.rxHeadline(v, ['Mum', 'Dad']), 'Leans towards Mum');
});

test('a wide gap that the passes disagreed about is downgraded, not trusted', () => {
  const rounds = [round([0, 1], { A: 88, B: 30 }), round([0, 1], { A: 30, B: 88 })];
  const t = R.rxMerge(rounds, 2);
  const v = R.rxVerdict(R.rxOverall(t, 2), R.rxAllCalls(t, 2), rounds, 2);
  assert.ok(v.stability < 1, 'the passes named different leaders');
  assert.notEqual(v.confidence, 'clear');
});

test('rxStability: unanimous passes score 1', () => {
  const rounds = [round([0, 1], { A: 80, B: 20 }), round([1, 0], { A: 20, B: 80 })];
  const t = R.rxMerge(rounds, 2);
  const v = R.rxVerdict(R.rxOverall(t, 2), R.rxAllCalls(t, 2), rounds, 2);
  assert.equal(v.stability, 1);
  assert.equal(v.leader, 0);
});

/* ---------- the image pipeline ---------- */

test('rxStretchBounds: finds the percentile edges of a histogram', () => {
  const hist = new Uint32Array(256);
  for (let i = 60; i <= 180; i++) hist[i] = 100;          // flat block, 121 levels × 100 = 12100 px
  const total = 12100;
  const b = F.rxStretchBounds(hist, total, 0.02, 0.98);
  assert.ok(b.lo >= 60 && b.lo <= 64, `lo ${b.lo} sits just inside the dark edge`);
  assert.ok(b.hi >= 176 && b.hi <= 180, `hi ${b.hi} sits just inside the bright edge`);
});

test('rxStretchBounds: never returns an inverted or zero-width range', () => {
  const hist = new Uint32Array(256);
  hist[128] = 1000;                                       // every pixel the same grey
  const b = F.rxStretchBounds(hist, 1000, 0.02, 0.98);
  assert.ok(b.hi > b.lo);
});

test('rxApplyStretch: lifts a dark, flat photo and leaves a well-exposed one alone', () => {
  const dark = new Uint8ClampedArray([40, 50, 60, 255, 45, 55, 65, 255]);
  assert.equal(F.rxApplyStretch(dark, 40, 70), true);
  assert.ok(dark[0] < dark[1] && dark[1] < dark[2], 'channel order — and so the hue — is preserved');
  assert.ok(dark[4] > 0);

  const fine = new Uint8ClampedArray([10, 20, 30, 255]);
  assert.equal(F.rxApplyStretch(fine, 2, 253), false, 'already spanning the range: untouched');
  assert.deepEqual([...fine], [10, 20, 30, 255]);
});

test('rxApplyStretch: the gain is capped so a foggy photo is not amplified into noise', () => {
  const flat = new Uint8ClampedArray([120, 120, 120, 255, 122, 122, 122, 255]);
  F.rxApplyStretch(flat, 119, 123);                        // a 4-level range would be a 60× gain
  assert.ok(flat[4] - flat[0] <= 2 * F.RX_MAX_GAIN + 1, 'difference grew by at most the capped gain');
});

test('rxClampFrame: the crop stays inside the photo and never exceeds the short side', () => {
  const f = F.rxClampFrame({ cx: -50, cy: 10, size: 5000, angle: 0 }, 800, 600);
  assert.equal(f.size, 600);
  assert.equal(f.cx, 300);
  assert.equal(f.cy, 300);
});

test('rxBoxToFrame: a detector box is widened into a whole head and nudged up', () => {
  const f = F.rxBoxToFrame({ x: 100, y: 100, width: 100, height: 100 }, 800, 800);
  assert.ok(f.size > 100, 'a face box is not a head box');
  assert.ok(f.cy < 150, 'a head has more above the eyes than the face box allows');
});

test('rxEyeAngle: levels a small tilt, refuses an implausible one', () => {
  assert.ok(Math.abs(F.rxEyeAngle({ x: 0, y: 0 }, { x: 100, y: 10 }) - Math.atan2(10, 100)) < 1e-9);
  assert.equal(F.rxEyeAngle({ x: 0, y: 0 }, { x: 10, y: 100 }), 0, 'near-vertical "eyes" are a bad detection');
  assert.equal(F.rxEyeAngle(null, { x: 1, y: 1 }), 0);
});

test('rxFocusScore: a sharp edge scores far above a flat wash', () => {
  const w = 32, h = 32;
  const sharp = new Uint8ClampedArray(w * h * 4), flat = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4, v = ((x + y) % 2) ? 220 : 40;
    sharp[i] = sharp[i + 1] = sharp[i + 2] = v; sharp[i + 3] = 255;
    flat[i] = flat[i + 1] = flat[i + 2] = 130; flat[i + 3] = 255;
  }
  assert.ok(F.rxFocusScore(sharp, w, h) > F.RX_FOCUS_MIN * 10);
  assert.ok(F.rxFocusScore(flat, w, h) < F.RX_FOCUS_MIN);
});

test('rxQuality: warns about a tiny head and a soft photo, and stays quiet otherwise', () => {
  assert.equal(F.rxQuality({ size: 600 }, 9).warnings.length, 0);
  assert.equal(F.rxQuality({ size: 60 }, 9).warnings.length, 1);
  assert.equal(F.rxQuality({ size: 60 }, 0.2).warnings.length, 2);
});

/* ---------- the client and the server must agree on the features ---------- */

test('the feature list in the API matches the one the browser scores', async () => {
  const { FEATURES } = await import('../functions/api/compare.js');
  assert.deepEqual(FEATURES, R.RX_FEATURE_KEYS, 'client and server feature keys have drifted apart');

  // Every feature must also carry a description for the prompt, or the model is scoring a bare word,
  // and must have a label and a weight this side, or it cannot be shown or counted.
  const src = readFileSync(new URL('functions/api/compare.js', `file://${ROOT}`), 'utf8');
  const hints = /const FEATURE_HINT = \{([\s\S]*?)\n\};/.exec(src);
  assert.ok(hints, 'the API still describes each feature for the prompt');
  for (const key of FEATURES) {
    assert.ok(new RegExp(`\\b${key}:\\s*'`).test(hints[1]), `${key} has no prompt hint`);
    const f = R.rxFeature(key);
    assert.ok(f && f.label && f.weight > 0, `${key} has no label or weight`);
  }
});

test('one person on their own is never crowned — there is nothing to beat', () => {
  const rounds = [R.rxRoundScores([0], (() => {
    const f = {}; for (const k of R.RX_FEATURE_KEYS) f[k] = { A: 78 }; return f;
  })())];
  const t = R.rxMerge(rounds, 1);
  const v = R.rxVerdict(R.rxOverall(t, 1), R.rxAllCalls(t, 1), rounds, 1);
  assert.equal(v.confidence, 'only');
  assert.equal(v.gap, 0, 'a lone score is not a lead over anybody');
  assert.equal(v.runnerUp, -1);
  assert.equal(R.rxHeadline(v, ['Mum']), 'Compared with Mum alone');
});
