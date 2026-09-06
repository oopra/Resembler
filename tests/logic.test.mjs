// Pure-logic tests. js/*.js ship as plain browser scripts but expose their functions through a
// module.exports guard, so the real shipped code is what runs here — no duplicated copy to drift.
//
// The fixtures are 478 face-mesh landmarks detected from two public-domain photographs (Wikimedia
// Commons), kept as numbers only: real faces to test the maths against, no photographs in the repo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const F = require('../js/faces.js');
const M = require('../js/measure.js');
const R = require('../js/resemble.js');

const fixture = (n) => JSON.parse(readFileSync(new URL(`fixtures/${n}.json`, import.meta.url), 'utf8'));
const A = fixture('portrait-a');
const B = fixture('portrait-b');
const measure = (f) => M.rxMeasure(f.pts, f.w, f.h);
const VA = measure(A), VB = measure(B);

// A face part-way between two others, used as ground truth: a child who is literally 50/50 must come
// out a mix, and one identical to a parent must come out as that parent.
const blend = (a, b, t) => {
  const o = {};
  for (const k of Object.keys(a)) o[k] = a[k] * (1 - t) + b[k] * t;
  return o;
};
const runFor = (childVals, peopleVals, passes = 1) => {
  const rounds = Array.from({ length: passes }, () => R.rxRound(childVals, peopleVals, null));
  const table = R.rxMergeRounds(rounds, peopleVals.length);
  const overall = R.rxOverall(table, peopleVals.length);
  const calls = R.rxAllCalls(table, peopleVals.length);
  return { table, overall, calls, verdict: R.rxVerdict(overall, calls, rounds, peopleVals.length) };
};

/* ---------- putting a face in the standard pose ---------- */

test('rxAlign: the two irises end up one unit apart, level, either side of the origin', () => {
  const P = M.rxAlign(A.pts, A.w, A.h);
  assert.ok(Math.abs(P[M.RX_P.irisL][0] + 0.5) < 1e-9);
  assert.ok(Math.abs(P[M.RX_P.irisR][0] - 0.5) < 1e-9);
  assert.ok(Math.abs(P[M.RX_P.irisL][1]) < 1e-9 && Math.abs(P[M.RX_P.irisR][1]) < 1e-9);
});

test('rxAlign: landmarks are put back into pixels first, so a tall photo is not stretched', () => {
  // The same face described on a 2:1 canvas: normalised y values halve, and a naive implementation
  // that skipped the pixel conversion would report a face half as tall.
  const tall = A.pts.map(([x, y, z]) => [x, y / 2, z]);
  const v1 = M.rxMeasure(A.pts, A.w, A.h);
  const v2 = M.rxMeasure(tall, A.w, A.h * 2);
  for (const k of ['face_h', 'nose_len', 'third_mid']) {
    assert.ok(Math.abs(v1[k] - v2[k]) < 1e-9, `${k} must not depend on the shape of the canvas`);
  }
});

test('measurements survive scaling and rotating the whole face', () => {
  const rot = (deg, s) => {
    const t = deg * Math.PI / 180, c = Math.cos(t), sn = Math.sin(t);
    return A.pts.map(([x, y, z]) => [0.5 + ((x - 0.5) * c - (y - 0.5) * sn) * s,
                                     0.5 + ((x - 0.5) * sn + (y - 0.5) * c) * s, z * s]);
  };
  const moved = M.rxMeasure(rot(17, 0.7), A.w, A.w);   // square canvas so the rotation is rigid
  const still = M.rxMeasure(rot(0, 1.0), A.w, A.w);
  for (const m of M.RX_MEASURES) {
    if (still[m.key] === undefined) continue;
    assert.ok(Math.abs(moved[m.key] - still[m.key]) < Math.max(0.01, Math.abs(still[m.key]) * 0.02),
      `${m.key} should not care how big or how tilted the face was in the photo`);
  }
});

/* ---------- the measurements themselves, on a real face ---------- */

test('rxMeasure on a real face: the numbers describe a face and not a shipwreck', () => {
  for (const [name, v] of [['A', VA], ['B', VB]]) {
    assert.ok(v.alar_width > 0.3 && v.alar_width < 1.2, `${name} nose width`);
    assert.ok(v.face_w > v.alar_width * 2, `${name} face is much wider than the nose`);
    assert.ok(v.mouth_w > v.alar_width, `${name} mouth is wider than the nose`);
    assert.ok(v.bigonial < v.face_w, `${name} jaw is narrower than the widest part of the face`);
    assert.ok(Math.abs(v.third_up + v.third_mid + v.third_low - 1) < 1e-9, `${name} facial thirds sum to the whole face`);
    assert.ok(v.gonial > 100 && v.gonial < 170, `${name} jaw angle is a jaw angle`);
    assert.ok(Math.abs(v.canthal_tilt) < 25, `${name} eye tilt is a few degrees, not a diagonal`);
  }
});

test('every measurement belongs to a feature that exists, and every feature has measurements', () => {
  const featureKeys = new Set(R.RX_FEATURE_KEYS);
  const used = new Set();
  for (const m of M.RX_MEASURES) {
    assert.ok(featureKeys.has(m.feature), `${m.key} claims a feature "${m.feature}" that is not shown`);
    assert.ok(m.tol > 0 && m.w > 0, `${m.key} needs a tolerance and a weight`);
    used.add(m.feature);
  }
  for (const k of featureKeys) assert.ok(used.has(k), `feature "${k}" is displayed but nothing measures it`);
});

test('ears and hairline are absent by design, not by accident', () => {
  for (const k of ['ears', 'hairline', 'hair']) {
    assert.ok(!R.RX_FEATURE_KEYS.includes(k), `"${k}" cannot be measured from a face mesh and must not be scored`);
  }
});

/* ---------- turning a difference into a score ---------- */

test('rxScore: identical is 100, one tolerance away is about 37, and it never goes negative', () => {
  assert.equal(M.rxScore(0, 0.05), 100);
  assert.ok(Math.abs(M.rxScore(0.05, 0.05) - 36.79) < 0.01);
  assert.ok(Math.abs(M.rxScore(-0.05, 0.05) - 36.79) < 0.01, 'the sign of the difference is irrelevant');
  assert.ok(M.rxScore(10, 0.05) >= 0);
});

test('rxCompare: a face compared with itself scores 100 on everything', () => {
  const s = M.rxCompare(VA, VA, null);
  for (const m of M.RX_MEASURES) {
    if (typeof VA[m.key] !== 'number') continue;
    assert.equal(Math.round(s[m.key]), 100, m.key);
  }
});

test('rxCompare: two different faces are not all-100, and blocked measurements come back null', () => {
  const open = M.rxCompare(VA, VB, null);
  assert.ok(M.RX_MEASURES.some((m) => open[m.key] !== null && open[m.key] < 60), 'some measurements differ');
  const shut = M.rxCompare(VA, VB, { alar_width: true });
  assert.equal(shut.alar_width, null, 'a blocked measurement is null, never zero');
  assert.ok(typeof shut.nose_len === 'number', 'and its neighbours are untouched');
});

/* ---------- expressions ---------- */

test('rxBlocked: a grin blocks the mouth measurements and leaves the nose alone', () => {
  const b = M.rxBlocked({ mouthSmileLeft: 0.8 }, {});
  assert.equal(b.mouth_w, true);
  assert.ok(!b.alar_width);
  assert.ok(b.__reasons.includes('mouthSmileLeft'));
});

test('rxBlocked: either face pulling the expression is enough to block it', () => {
  assert.equal(M.rxBlocked({}, { jawOpen: 0.9 }).lip_upper, true);
  assert.equal(M.rxBlocked({ jawOpen: 0.9 }, {}).lip_upper, true);
  assert.ok(!M.rxBlocked({ jawOpen: 0.1 }, { jawOpen: 0.1 }).lip_upper, 'a hint of an expression is not a grin');
});

test('rxBlocked: measurements an expression cannot move are never blocked', () => {
  const b = M.rxBlocked({ jawOpen: 1, mouthSmileLeft: 1, browInnerUp: 1, eyeBlinkLeft: 1 }, {});
  for (const k of ['alar_width', 'nose_len', 'intercanthal', 'chin_w', 'skin_a'])
    assert.ok(!b[k], `${k} does not move with an expression`);
});

/* ---------- head pose ---------- */

test('rxPose: a face square to the camera is zero, and a turned one is not', () => {
  const I = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
  const p = M.rxPose(I);
  assert.ok(Math.abs(p.yaw) < 1e-6 && Math.abs(p.pitch) < 1e-6 && Math.abs(p.roll) < 1e-6);
  // 30° about the vertical axis, column-major.
  const c = Math.cos(Math.PI / 6), s = Math.sin(Math.PI / 6);
  const yawed = [c,0,-s,0, 0,1,0,0, s,0,c,0, 0,0,0,1];
  assert.ok(Math.abs(M.rxPose(yawed).yaw - 30) < 0.001);
  assert.equal(M.rxPose(null), null);
});

/* ---------- colour ---------- */

test('rxSrgbToLab: the anchors land where CIE says they should', () => {
  const G = require('../js/mesh.js');
  const white = G.rxSrgbToLab(255, 255, 255), black = G.rxSrgbToLab(0, 0, 0);
  assert.ok(Math.abs(white[0] - 100) < 0.1 && Math.abs(white[1]) < 0.1 && Math.abs(white[2]) < 0.1);
  assert.ok(Math.abs(black[0]) < 0.1);
  const red = G.rxSrgbToLab(255, 0, 0);
  assert.ok(red[1] > 60 && red[2] > 40, 'red is strongly positive on both a* and b*');
  const blue = G.rxSrgbToLab(0, 0, 255);
  assert.ok(blue[2] < -80, 'blue is strongly negative on b*');
});

test('rxPatch: a highlight in the middle of a cheek does not decide its colour', () => {
  const W = 40, H = 40, data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) { data[i * 4] = 180; data[i * 4 + 1] = 130; data[i * 4 + 2] = 110; data[i * 4 + 3] = 255; }
  const G = require('../js/mesh.js');
  const plain = G.rxPatch(data, W, H, 20, 20, 9, 0.15, 0.15);
  for (let i = 0; i < 30; i++) { const j = (20 * W + 5 + i) * 4; data[j] = data[j + 1] = data[j + 2] = 255; }
  const withGlare = G.rxPatch(data, W, H, 20, 20, 9, 0.15, 0.15);
  assert.ok(Math.abs(plain[0] - withGlare[0]) < 2, 'the median ignores the blown-out pixels');
});

test('rxPoseWarning: speaks up about a turned head, stays quiet about a straight one', () => {
  const G = require('../js/mesh.js');
  assert.equal(G.rxPoseWarning({ yaw: 4, pitch: 3, roll: 10 }), null);
  assert.match(G.rxPoseWarning({ yaw: 35, pitch: 0, roll: 0 }), /turned about 35°/);
  assert.match(G.rxPoseWarning({ yaw: 0, pitch: -30, roll: 0 }), /tipped about 30°/);
});

/* ---------- measurements → features ---------- */

test('rxRollUp: a feature with nothing measurable is null, not zero', () => {
  const all = {};
  for (const m of M.RX_MEASURES) all[m.key] = m.feature === 'nose' ? null : 70;
  const f = R.rxRollUp(all);
  assert.equal(f.nose, null, 'unmeasured is not the same as unalike');
  assert.equal(Math.round(f.eyes), 70);
});

test('rxRollUp: within a feature, the heavier measurements count for more', () => {
  const only = (key, v) => {
    const o = {};
    for (const m of M.RX_MEASURES) o[m.key] = m.key === key ? v : (m.feature === 'nose' ? 50 : null);
    return R.rxRollUp(o).nose;
  };
  const heavy = M.RX_MEASURES.filter((m) => m.feature === 'nose').sort((a, b) => b.w - a.w)[0];
  const light = M.RX_MEASURES.filter((m) => m.feature === 'nose').sort((a, b) => a.w - b.w)[0];
  assert.ok(only(heavy.key, 100) > only(light.key, 100), `${heavy.key} should outweigh ${light.key}`);
});

/* ---------- ground truth ---------- */

test('a child identical to one parent is called for that parent', () => {
  const r = runFor(VA, [VA, VB]);
  assert.equal(r.verdict.confidence, 'clear');
  assert.equal(R.rxHeadline(r.verdict, ['Mum', 'Dad']), 'Takes after Mum');
  assert.equal(Math.round(r.overall.raw[0]), 100);
});

test('a child exactly half way between two parents is called a mix', () => {
  const r = runFor(blend(VA, VB, 0.5), [VA, VB]);
  assert.equal(r.verdict.confidence, 'mix');
  assert.ok(Math.abs(r.overall.share[0] - 50) < 1.5, 'and the split is down the middle');
  assert.match(R.rxHeadline(r.verdict, ['Mum', 'Dad']), /^A genuine mix of/);
});

test('a child mostly like one parent leans that way without overclaiming', () => {
  const r = runFor(blend(VA, VB, 0.25), [VA, VB]);
  assert.ok(['clear', 'lean'].includes(r.verdict.confidence));
  assert.equal(r.verdict.leader, 0);
  assert.ok(r.overall.share[0] > r.overall.share[1]);
});

test('the ordering of the people cannot change the answer', () => {
  const child = blend(VA, VB, 0.25);
  const one = runFor(child, [VA, VB]), other = runFor(child, [VB, VA]);
  assert.equal(Math.round(one.overall.raw[0]), Math.round(other.overall.raw[1]));
  assert.equal(one.verdict.leader, 1 - other.verdict.leader);
});

test('features are attributed one at a time: her eyes from one, his nose from the other', () => {
  // A child with A's nose and B's eyes, and everything else split down the middle.
  const child = blend(VA, VB, 0.5);
  for (const m of M.RX_MEASURES) {
    if (m.feature === 'nose') child[m.key] = VA[m.key];
    if (m.feature === 'eyes') child[m.key] = VB[m.key];
  }
  const r = runFor(child, [VA, VB]);
  const call = (k) => r.calls.find((c) => c.key === k);
  assert.equal(call('nose').winner, 0);
  assert.equal(call('nose').shared, false);
  assert.equal(call('eyes').winner, 1);
  assert.equal(call('eyes').shared, false);
  assert.deepEqual(R.rxWonBy(r.calls, 0).map((f) => f.key), ['nose']);
  assert.deepEqual(R.rxWonBy(r.calls, 1).map((f) => f.key), ['eyes']);
});

/* ---------- refusing to overclaim ---------- */

test('readings that disagree more than the people do are called unsteady, not averaged into a winner', () => {
  const rounds = [R.rxRound(VA, [VA, VB], null), R.rxRound(VA, [VB, VA], null)];
  const table = R.rxMergeRounds(rounds, 2);
  assert.ok(R.rxAllCalls(table, 2).some((c) => c.unsteady), 'wildly different readings must show as unsteady');
});

test('a wide gap that the readings disagreed about is downgraded from "clear"', () => {
  const rounds = [R.rxRound(VA, [VA, VB], null), R.rxRound(VA, [VB, VA], null)];
  const table = R.rxMergeRounds(rounds, 2);
  const v = R.rxVerdict(R.rxOverall(table, 2), R.rxAllCalls(table, 2), rounds, 2);
  assert.ok(v.stability < 1);
  assert.notEqual(v.confidence, 'clear');
});

test('one person on their own is never crowned — there is nothing to beat', () => {
  const r = runFor(VA, [VA]);
  assert.equal(r.verdict.confidence, 'only');
  assert.equal(r.verdict.gap, 0);
  assert.equal(r.verdict.runnerUp, -1);
  assert.equal(R.rxHeadline(r.verdict, ['Mum']), 'Compared with Mum alone');
});

test('a feature nobody could measure is reported as such, not as a draw at zero', () => {
  const blocked = {};
  for (const m of M.RX_MEASURES) if (m.feature === 'mouth') blocked[m.key] = true;
  const rounds = [R.rxRound(VA, [VA, VB], [blocked, blocked])];
  const table = R.rxMergeRounds(rounds, 2);
  const call = R.rxAllCalls(table, 2).find((c) => c.key === 'mouth');
  assert.equal(call.answered, false);
  assert.equal(table.features.mouth.mean[0], null);
});

test('rxFeatureNote: names the measurement that matched and the one that did not', () => {
  const rounds = [R.rxRound(VA, [VB], null)];
  const table = R.rxMergeRounds(rounds, 1);
  const note = R.rxFeatureNote(table, 'nose', 0);
  assert.match(note, /^closest on /);
  const labels = M.RX_MEASURES.filter((m) => m.feature === 'nose').map((m) => m.label);
  assert.ok(labels.some((l) => note.includes(l)), 'the note quotes a real nose measurement');
});

/* ---------- the image pipeline ---------- */

test('rxStretchBounds: finds the percentile edges of a histogram', () => {
  const hist = new Uint32Array(256);
  for (let i = 60; i <= 180; i++) hist[i] = 100;
  const b = F.rxStretchBounds(hist, 12100, 0.02, 0.98);
  assert.ok(b.lo >= 60 && b.lo <= 64);
  assert.ok(b.hi >= 176 && b.hi <= 180);
});

test('rxStretchBounds: never returns an inverted or zero-width range', () => {
  const hist = new Uint32Array(256);
  hist[128] = 1000;
  assert.ok(F.rxStretchBounds(hist, 1000, 0.02, 0.98).hi > F.rxStretchBounds(hist, 1000, 0.02, 0.98).lo);
});

test('rxApplyStretch: lifts a dark photo, keeps its hue, and leaves a good one alone', () => {
  const dark = new Uint8ClampedArray([40, 50, 60, 255, 45, 55, 65, 255]);
  assert.equal(F.rxApplyStretch(dark, 40, 70), true);
  assert.ok(dark[0] < dark[1] && dark[1] < dark[2], 'channel order — and so the hue — is preserved');
  const fine = new Uint8ClampedArray([10, 20, 30, 255]);
  assert.equal(F.rxApplyStretch(fine, 2, 253), false);
  assert.deepEqual([...fine], [10, 20, 30, 255]);
});

test('rxApplyStretch: the gain is capped so a foggy photo is not amplified into noise', () => {
  const flat = new Uint8ClampedArray([120, 120, 120, 255, 122, 122, 122, 255]);
  F.rxApplyStretch(flat, 119, 123);
  assert.ok(flat[4] - flat[0] <= 2 * F.RX_MAX_GAIN + 1);
});

test('rxClampFrame: the crop stays inside the photo and never exceeds the short side', () => {
  const f = F.rxClampFrame({ cx: -50, cy: 10, size: 5000, angle: 0 }, 800, 600);
  assert.deepEqual([f.size, f.cx, f.cy], [600, 300, 300]);
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

test('a feature only one person could be measured on is not silently won by them', () => {
  // A grin in Dad's photo makes the mouth uncomparable for him. Mum must not inherit the mouth.
  const blocked = {};
  for (const m of M.RX_MEASURES) if (m.feature === 'mouth') blocked[m.key] = true;
  const rounds = [R.rxRound(VA, [VA, VB], [null, blocked])];
  const table = R.rxMergeRounds(rounds, 2);
  const call = R.rxAllCalls(table, 2).find((c) => c.key === 'mouth');
  assert.equal(call.partial, true);
  assert.equal(R.rxAttributed(call), false, 'a walkover is not a win');
  assert.deepEqual(R.rxWonBy(R.rxAllCalls(table, 2), 0).map((f) => f.key).includes('mouth'), false);
});

test('a feature that is not comparable for everyone is left out of the overall for everyone', () => {
  const blocked = {};
  for (const m of M.RX_MEASURES) if (m.feature === 'mouth') blocked[m.key] = true;
  const table = R.rxMergeRounds([R.rxRound(VA, [VA, VB], [null, blocked])], 2);
  const overall = R.rxOverall(table, 2);
  // Person 0 is identical to the child; dropping a feature they scored 100 on must not dent them.
  assert.equal(Math.round(overall.raw[0]), 100, 'the like-for-like set is still all-100 for a perfect match');
  assert.ok(typeof overall.raw[1] === 'number');
});

test('no two shipped scripts define the same global', () => {
  // These files share one global scope with no bundler and no modules, so a name defined twice is
  // not an error anywhere — the last file loaded simply wins, silently. That is how app.js's
  // `rxCompare` button handler once ate measure.js's `rxCompare(child, adult)` and turned every
  // comparison into nulls. Cheap to check, so it is checked.
  const dir = new URL('../js/', import.meta.url);
  const files = ['faces.js', 'measure.js', 'mesh.js', 'resemble.js', 'app.js'];
  const owner = new Map();
  const clashes = [];
  for (const f of files) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    for (const m of src.matchAll(/^(?:function\s+(\w+)|var\s+(\w+)\s*=)/gm)) {
      const name = m[1] || m[2];
      if (owner.has(name) && owner.get(name) !== f) clashes.push(`${name} (${owner.get(name)} and ${f})`);
      owner.set(name, f);
    }
  }
  assert.deepEqual(clashes, [], 'a global is declared in two files; the later one silently wins');
  assert.ok(owner.size > 50, 'the scan found the declarations it was meant to find');
});

test('a feature whose measurements were mostly knocked out is not won on the remainder', () => {
  // A smile blocks the mouth's width and lips but not the philtrum. A mouth judged on philtrum
  // length alone is not a mouth, and must not be handed to anyone.
  const blocked = M.rxBlocked({}, { mouthSmileLeft: 0.9, jawOpen: 0.9, mouthPucker: 0.9 });
  const rounds = [R.rxRound(VA, [VA, VB], [null, blocked])];
  const table = R.rxMergeRounds(rounds, 2);
  assert.ok(table.coverage.mouth.mean[1] > 0, 'something in the mouth did survive');
  assert.ok(table.coverage.mouth.mean[1] < R.RX_MIN_COVERAGE, 'but not enough of it');
  const call = R.rxAllCalls(table, 2).find((c) => c.key === 'mouth');
  assert.equal(call.partial, true);
  assert.equal(R.rxAttributed(call), false);
});

test('rxCoverage: everything measurable is 1, nothing measurable is 0', () => {
  const all = {}, none = {};
  for (const m of M.RX_MEASURES) { all[m.key] = 50; none[m.key] = null; }
  assert.equal(R.rxCoverage(all).nose, 1);
  assert.equal(R.rxCoverage(none).nose, 0);
});
