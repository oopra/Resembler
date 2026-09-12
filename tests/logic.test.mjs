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
  const files = ['faces.js', 'measure.js', 'mesh.js', 'resemble.js', 'kinmap.js', 'app.js'];
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

/* ---------- can we see the eyes at all ---------- */

// A synthetic eye region: a bright sclera with a dark iris on it, or a flat dark lens over both.
// Built as a real canvas-shaped buffer so rxEyeVisibility is exercised exactly as it runs.
function eyeCanvas({ lens }) {
  const W = 200, H = 200, data = new Uint8ClampedArray(W * H * 4);
  const put = (x, y, v) => { const i = ((y | 0) * W + (x | 0)) * 4; data[i] = data[i + 1] = data[i + 2] = v; data[i + 3] = 255; };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) put(x, y, 150);         // skin/cheek
  const eyes = [[70, 100], [130, 100]];
  for (const [cx, cy] of eyes) {
    for (let y = cy - 14; y <= cy + 14; y++) for (let x = cx - 22; x <= cx + 22; x++) {
      if ((x - cx) ** 2 / 484 + (y - cy) ** 2 / 196 > 1) continue;
      const iris = (x - cx) ** 2 + (y - cy) ** 2 < 90;
      put(x, y, lens ? 20 : (iris ? 45 : 215));                                   // lens: all dark
    }
  }
  return {
    width: W, height: H,
    getContext: () => ({ getImageData: () => ({ data }) })
  };
}
// Landmarks the metric needs, positioned to match the drawing above (normalised).
const eyePts = (() => {
  const p = Array.from({ length: 478 }, () => [0.5, 0.5, 0]);
  p[M.RX_P.irisL] = [70 / 200, 100 / 200, 0];  p[M.RX_P.irisR] = [130 / 200, 100 / 200, 0];
  p[M.RX_P.eyeLouter] = [48 / 200, 100 / 200, 0]; p[M.RX_P.eyeLinner] = [92 / 200, 100 / 200, 0];
  p[M.RX_P.eyeRouter] = [152 / 200, 100 / 200, 0]; p[M.RX_P.eyeRinner] = [108 / 200, 100 / 200, 0];
  p[M.RX_P.cheekL] = [40 / 200, 150 / 200, 0]; p[M.RX_P.cheekR] = [160 / 200, 150 / 200, 0];
  p[M.RX_P.alarL] = [88 / 200, 150 / 200, 0];  p[M.RX_P.alarR] = [112 / 200, 150 / 200, 0];
  return p;
})();

test('rxEyeVisibility: an open eye has a bright sclera beside a dark iris', () => {
  const G = require('../js/mesh.js');
  const v = G.rxEyeVisibility(eyeCanvas({ lens: false }), eyePts);
  assert.ok(v.contrast > G.RX_EYE_CONTRAST_MIN * 2, `contrast ${v.contrast} should be clearly above the floor`);
  assert.ok(v.eyeVsCheek > G.RX_EYE_VS_CHEEK_MIN * 2);
  assert.equal(v.covered, false);
});

test('rxEyeVisibility: a dark lens flattens both signals and is called covered', () => {
  // This is the case that produced a confident wrong answer: MediaPipe still detects a face and
  // still places irises — on the lenses, 0.13–0.16 of an eye-gap out — so every measurement that
  // is scaled and levelled by that line is wrong, not just the eyes.
  const G = require('../js/mesh.js');
  const v = G.rxEyeVisibility(eyeCanvas({ lens: true }), eyePts);
  assert.ok(v.contrast < G.RX_EYE_CONTRAST_MIN, `contrast ${v.contrast} should collapse`);
  assert.ok(v.eyeVsCheek < G.RX_EYE_VS_CHEEK_MIN);
  assert.equal(v.covered, true);
});

test('rxEyeVisibility: a degenerate reading is not reported as sunglasses', () => {
  const G = require('../js/mesh.js');
  const flat = Array.from({ length: 478 }, () => [0.5, 0.5, 0]);   // every point on top of the others
  assert.equal(G.rxEyeVisibility(eyeCanvas({ lens: false }), flat).covered, false);
});

/* ---------- calibrated against real families ---------- */

test('rxChanceOf: a verdict is quoted against how often chance produces the same gap', () => {
  assert.equal(R.rxChanceOf(3), 100, 'a tiny gap is what chance does most of the time');
  assert.equal(R.rxChanceOf(8), 50);
  assert.equal(R.rxChanceOf(12), 25);
  assert.equal(R.rxChanceOf(17), 10);
  assert.equal(R.rxChanceOf(20), 5);
  assert.equal(R.rxChanceOf(40), 1, 'a huge gap is rare by chance, never impossible');
});

test('both rulers have thresholds above their own measured noise', () => {
  // The first version called a 10-point gap a "clear lead". Chance alone produces gaps that big
  // 27% of the time, which is how a father was confidently told the wrong thing. There are now two
  // scales — blend and geometry-only — and each must clear ITS OWN null, not the other's.
  for (const name of ['blend', 'geometry']) {
    const sc = R.rxUseScale(name);
    assert.ok(R.rxChanceOf(sc.clear) <= 5, `${name}: "takes after" at ${sc.clear} must beat 95% of chance gaps`);
    assert.ok(R.rxChanceOf(sc.lean) <= 25, `${name}: "leans" at ${sc.lean} must beat 75% of chance gaps`);
    assert.ok(sc.clear > sc.lean, `${name}: clear must be a higher bar than lean`);
  }
  assert.ok(R.RX_SCALES.blend.clear > R.RX_SCALES.geometry.clear,
    'the blended score is noisier in absolute points, so its bar is higher');
  R.rxUseScale('geometry');
});

test('rxEmbLikeness: a cosine lands on the same 0-100 ruler as the measurements', () => {
  assert.equal(R.rxEmbLikeness(R.RX_EMB_LO), 0);
  assert.equal(Math.round(R.rxEmbLikeness(R.RX_EMB_HI)), 100);
  assert.ok(R.rxEmbLikeness(-5) === 0 && R.rxEmbLikeness(5) === 100, 'clamped at both ends');
  assert.equal(R.rxEmbLikeness(null), null);
  assert.equal(R.rxEmbLikeness(NaN), null);
});

test('rxOverall: the blend is 60% model and 40% measurements, and says so in its own output', () => {
  const table = R.rxMergeRounds([R.rxRound(VA, [VA, VB], null)], 2);
  const geoOnly = R.rxOverall(table, 2);
  const blended = R.rxOverall(table, 2, [20, 90]);
  assert.equal(blended.geometry[0], geoOnly.raw[0], 'the measurement score is kept alongside');
  assert.ok(Math.abs(blended.raw[0] - (0.6 * 20 + 0.4 * geoOnly.raw[0])) < 1e-9);
  assert.ok(Math.abs(blended.raw[1] - (0.6 * 90 + 0.4 * geoOnly.raw[1])) < 1e-9);
  assert.ok(blended.raw[1] > blended.raw[0], 'the model can outvote the measurements, which is the point');
});

test('rxOverall: a face the measurements failed on still scores from the model alone', () => {
  const empty = {};
  const table = R.rxMergeRounds([R.rxRound(VA, [empty], null)], 1);
  assert.equal(R.rxOverall(table, 1).raw[0], null, 'no measurements, no geometry score');
  assert.equal(R.rxOverall(table, 1, [72]).raw[0], 72, 'but the model still has an opinion');
});

test('rxSimilarity: recovers a known rotation, scale and shift exactly', () => {
  const Emb = require('../js/embed.js');
  const k = 1.7, th = 0.3, tx = 12, ty = -5;
  const src = [[0, 0], [10, 0], [5, 8], [2, 12], [9, 11]];
  const dst = src.map(([x, y]) => [k * (x * Math.cos(th) - y * Math.sin(th)) + tx,
                                   k * (x * Math.sin(th) + y * Math.cos(th)) + ty]);
  const m = Emb.rxSimilarity(src, dst);
  for (const [x, y] of src) {
    const px = m.a * x + m.c * y + m.e, py = m.b * x + m.d * y + m.f;
    const [ex, ey] = dst[src.findIndex(([a, b]) => a === x && b === y)];
    assert.ok(Math.abs(px - ex) < 1e-6 && Math.abs(py - ey) < 1e-6);
  }
  assert.ok(Math.abs(Math.hypot(m.a, m.b) - k) < 1e-9, 'and the scale it found is the scale applied');
});

test('rxCosine: unit vectors, and a refusal to compare mismatched ones', () => {
  const Emb = require('../js/embed.js');
  assert.ok(Math.abs(Emb.rxCosine([1, 0, 0], [1, 0, 0]) - 1) < 1e-9);
  assert.ok(Math.abs(Emb.rxCosine([1, 0, 0], [0, 1, 0])) < 1e-9);
  assert.equal(Emb.rxCosine([1, 0], [1, 0, 0]), null);
  assert.equal(Emb.rxCosine(null, [1]), null);
});

test('weights come from measured kin signal, not from what sounded plausible', () => {
  // Colouring measured as the strongest family signal and must not be weighted below the geometry
  // again; the reasoning that talked the first version into doing so was wrong.
  const colour = R.rxFeature('colour').weight;
  for (const f of R.RX_FEATURES) {
    if (f.key === 'colour') continue;
    assert.ok(colour > f.weight, `colouring (${colour}) should outweigh ${f.key} (${f.weight})`);
  }
  const byKey = M.RX_MEASURE_BY_KEY;
  assert.ok(byKey.skin_b.w > byKey.nose_len.w, 'skin tone carries more family signal than nose length');
  assert.ok(byKey.eye_a.w > byKey.gonial.w, 'eye colour carries more than the jaw angle');
});

test('rxWhiteBalance: removes a colour cast, leaves a neutral face alone', () => {
  // Two photos taken in one session share a cast; without this they collect credit for it.
  const warm = new Uint8ClampedArray([200, 150, 100, 255, 180, 130, 80, 255]);
  const before = warm[0] - warm[2];
  F.rxWhiteBalance(warm);
  assert.ok(warm[0] - warm[2] < before, 'the orange cast is pulled towards neutral');
  const neutral = new Uint8ClampedArray([120, 120, 120, 255, 130, 130, 130, 255]);
  const copy = [...neutral];
  F.rxWhiteBalance(neutral);
  assert.deepEqual([...neutral], copy, 'an already-neutral image is untouched');
});

/* ---------- things worn on a face ---------- */

test('rxOccluderBlocks: a hat blocks the forehead measurements and nothing else', () => {
  const b = M.rxOccluderBlocks(['hat']);
  assert.equal(b.third_up, true);
  assert.equal(b.forehead_w, true);
  assert.ok(!b.alar_width, 'a hat does not touch the nose');
  assert.ok(!b.skin_a, 'nor the colouring');
  assert.deepEqual(b.__worn, ['hat']);
});

test('rxOccluderBlocks: nothing ticked blocks nothing', () => {
  const b = M.rxOccluderBlocks([]);
  assert.equal(Object.keys(b).filter((k) => !k.startsWith('__')).length, 0);
  assert.deepEqual(M.rxOccluderBlocks(['nonsense']).__worn, [], 'an unknown id is ignored, not obeyed');
});

test('rxMergeBlocks: an expression and a hat combine without either clobbering the other', () => {
  const merged = M.rxMergeBlocks(M.rxBlocked({ jawOpen: 0.9 }, {}), M.rxOccluderBlocks(['hat']));
  assert.equal(merged.lip_upper, true, 'from the open mouth');
  assert.equal(merged.third_up, true, 'from the hat');
  assert.ok(merged.__reasons.includes('jawOpen'));
  assert.deepEqual(merged.__worn, ['hat']);
});

test('the free exclusions really are free, and the costly ones are flagged', () => {
  // Costs are measured on 849 real pairs, not asserted — see tools/README-calibration.md.
  for (const id of ['hat', 'beard', 'lipstick', 'glasses', 'eyemakeup']) {
    const o = M.RX_OCCLUDER_BY_ID[id];
    assert.ok(o.cost < 0.02, `${id} should be free to route around (measured ${o.cost})`);
    assert.ok(!o.costly, `${id} must not be marked costly`);
  }
  for (const id of ['foundation', 'contacts']) {
    const o = M.RX_OCCLUDER_BY_ID[id];
    assert.ok(o.costly, `${id} takes out colour and must be flagged as costly`);
    assert.ok(o.cost >= 0.02);
  }
});

test('every occluder blocks measurements that actually exist', () => {
  const keys = new Set(M.RX_MEASURES.map((m) => m.key));
  for (const o of M.RX_OCCLUDERS) {
    assert.ok(o.blocks.length > 0, `${o.id} blocks nothing`);
    for (const k of o.blocks) assert.ok(keys.has(k), `${o.id} blocks "${k}", which is not a measurement`);
  }
});

test('ticking a costly box really does drop colour out of the comparison', () => {
  const worn = M.rxOccluderBlocks(['foundation', 'contacts']);
  const rounds = [R.rxRound(VA, [VA, VB], [worn, worn])];
  const table = R.rxMergeRounds(rounds, 2);
  const call = R.rxAllCalls(table, 2).find((c) => c.key === 'colour');
  assert.equal(call.answered, false, 'colouring cannot be scored once skin and eyes are excluded');
});

test('rxEyeVisibility: a blurred eye is not mistaken for a lens', () => {
  // A soft photo loses the sclera-to-iris edge but the eye stays about as bright as the cheek.
  // Treating either signal alone as proof rejected ~40% of ordinary photographs in benchmarking.
  const G = require('../js/mesh.js');
  const W = 200, H = 200, data = new Uint8ClampedArray(W * H * 4);
  const put = (x, y, v) => { const i = ((y | 0) * W + (x | 0)) * 4; data[i] = data[i + 1] = data[i + 2] = v; data[i + 3] = 255; };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) put(x, y, 150);
  for (const [cx, cy] of [[70, 100], [130, 100]]) {
    for (let y = cy - 14; y <= cy + 14; y++) for (let x = cx - 22; x <= cx + 22; x++) {
      if ((x - cx) ** 2 / 484 + (y - cy) ** 2 / 196 > 1) continue;
      put(x, y, 146);                                   // smeared: no iris edge, but not dark
    }
  }
  const v = G.rxEyeVisibility({ width: W, height: H, getContext: () => ({ getImageData: () => ({ data }) }) }, eyePts);
  assert.ok(v.contrast < G.RX_EYE_CONTRAST_MIN, 'the sclera edge really has gone');
  assert.ok(v.eyeVsCheek > G.RX_EYE_VS_CHEEK_MIN, 'but the region is not dark like a lens');
  assert.equal(v.covered, false, 'so it is blurry, not covered');
});

/* ---------- the same person twice ---------- */

test('rxSamePerson: the line sits between family and identity, where it was measured', () => {
  // Measured through this pipeline: same person median cosine 0.600, parent/child 0.125 (95th 0.298),
  // strangers 0.009 (95th 0.116). Three separated populations; the line goes in the upper gap.
  assert.equal(R.rxSamePerson(0.60), true, 'a typical same-person pair');
  assert.equal(R.rxSamePerson(R.RX_SAME_PERSON_COS), true, 'the threshold itself counts');
  assert.equal(R.rxSamePerson(0.30), false, 'the 95th percentile of real parent/child must not trip it');
  assert.equal(R.rxSamePerson(0.125), false, 'nor a typical parent and child');
  assert.equal(R.rxSamePerson(0.009), false, 'nor two strangers');
  assert.equal(R.rxSamePerson(null), false);
  assert.equal(R.rxSamePerson(NaN), false);
  assert.ok(R.RX_SAME_PERSON_COS > R.RX_EMB_HI,
    'and it sits above the top of the family scale, which is why same-person used to clamp to 100');
});

test('rxIdentityGroup: a weak link is rescued by a strong one elsewhere in the group', () => {
  // The reported case: child-vs-Dad was a hard pairing and fell under the line, but Dad and Mum
  // were plainly the same face. 7.1% of genuine same-person pairs land below the threshold, so
  // testing every pair instead of only each-against-the-child is worth about one catch in fourteen.
  const child = 0, mum = 1, dad = 2;
  const cos = [
    [1.00, 0.62, 0.21],   // child–dad is weak
    [0.62, 1.00, 0.71],   // but mum–dad is unmistakable
    [0.21, 0.71, 1.00]
  ];
  assert.deepEqual(R.rxIdentityGroup(cos), [true, true, true],
    'all three are one person, including the one the child could not be matched to directly');
  assert.equal(R.rxSamePerson(cos[child][dad]), false, 'and the direct pairing really would have missed it');
});

test('rxIdentityGroup: a real family is not swept into one identity', () => {
  const cos = [
    [1.00, 0.13, 0.11],   // kin-level all round
    [0.13, 1.00, 0.05],
    [0.11, 0.05, 1.00]
  ];
  assert.deepEqual(R.rxIdentityGroup(cos), [true, false, false], 'only the child is in the child’s group');
});

test('rxIdentityGroup: a separate pair of twins does not drag in the child', () => {
  // Two candidates who are the same person as each other, but not as the child.
  const cos = [
    [1.00, 0.10, 0.09],
    [0.10, 1.00, 0.80],
    [0.09, 0.80, 1.00]
  ];
  assert.deepEqual(R.rxIdentityGroup(cos), [true, false, false]);
});

test('rxIdentityGroup: missing embeddings are simply not linked', () => {
  const cos = [[1.00, null], [null, 1.00]];
  assert.deepEqual(R.rxIdentityGroup(cos), [true, false]);
});

/* ---------- rarity: an unusual shared trait counts for more ---------- */

test('rxRarityWeight: a shared ordinary trait counts less than a shared unusual one', () => {
  // Norm-based coding, which is how human face perception works: a face is encoded as its departure
  // from an average, and a match is worth as much as it is unusual. Most people have an ordinary
  // nose, so two of them sharing one is not evidence.
  const m = M.RX_MEASURE_BY_KEY.alar_width;
  const pop = M.RX_POP.alar_width;
  const ordinary = M.rxRarityWeight(m, pop.mu, pop.mu);
  const unusual = M.rxRarityWeight(m, pop.mu + 2 * pop.sd, pop.mu + 2 * pop.sd);
  assert.equal(ordinary, m.w, 'a bang-average shared value carries only the base weight');
  assert.ok(unusual > ordinary * 2, `a strikingly narrow nose should count for much more (${unusual} vs ${ordinary})`);
});

test('rxRarityWeight: rarity is the milder of the two, not the wilder', () => {
  // A match is only as rare as its least unusual half — otherwise one extreme face would make every
  // comparison against it look remarkable.
  const m = M.RX_MEASURE_BY_KEY.alar_width, pop = M.RX_POP.alar_width;
  const lopsided = M.rxRarityWeight(m, pop.mu + 4 * pop.sd, pop.mu);
  assert.equal(lopsided, m.w, 'one extreme value and one ordinary one is not a rare match');
});

test('rxWeights: blocked and unmeasurable things get no weight at all', () => {
  const a = {}, b = {};
  for (const m of M.RX_MEASURES) { a[m.key] = M.RX_POP[m.key] ? M.RX_POP[m.key].mu : 1; b[m.key] = a[m.key]; }
  const open = M.rxWeights(a, b, null);
  assert.ok(open.alar_width > 0);
  const shut = M.rxWeights(a, b, { alar_width: true });
  assert.equal(shut.alar_width, 0);
  const missing = M.rxWeights({}, b, null);
  assert.equal(missing.alar_width, 0, 'a measurement the child has no value for carries nothing');
});

test('the population norms describe every measurement that is scored', () => {
  for (const m of M.RX_MEASURES) {
    const pop = M.RX_POP[m.key];
    assert.ok(pop, `${m.key} has no population norm, so its rarity cannot be judged`);
    assert.ok(pop.sd > 0, `${m.key} has a zero spread, which would divide by nothing`);
  }
});

test('rxRollUp: a rare match moves a feature more than an ordinary one', () => {
  const mk = (rare) => {
    const child = {}, adult = {};
    for (const m of M.RX_MEASURES) {
      const pop = M.RX_POP[m.key];
      const v = m.feature === 'nose' && rare ? pop.mu + 2.5 * pop.sd : pop.mu;
      child[m.key] = v; adult[m.key] = v;
    }
    return { child, adult };
  };
  const ordinary = mk(false), striking = mk(true);
  const wOrd = M.rxWeights(ordinary.child, ordinary.adult, null);
  const wRare = M.rxWeights(striking.child, striking.adult, null);
  const noseOrd = M.RX_MEASURES.filter((m) => m.feature === 'nose').reduce((s, m) => s + wOrd[m.key], 0);
  const noseRare = M.RX_MEASURES.filter((m) => m.feature === 'nose').reduce((s, m) => s + wRare[m.key], 0);
  assert.ok(noseRare > noseOrd * 2, 'the striking nose carries far more of the verdict');
});

/* ---- the per-feature adult→child maps ---- */

const K = require('../js/kinmap.js');
const KINMAP = K.rxParseKinmap((() => {
  const b = readFileSync(new URL('../models/kinmap.bin', import.meta.url));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
})());

test('the shipped feature maps parse to the shape the app expects', () => {
  assert.ok(KINMAP, 'models/kinmap.bin did not parse');
  assert.equal(KINMAP.D, 512, 'the maps must match the embedding width the model produces');
  for (const name of K.RX_REGIONS) {
    assert.ok(KINMAP[name], `no map for ${name}`);
    assert.equal(KINMAP[name].mu.length, KINMAP.D);
    assert.equal(KINMAP[name].comps.length, KINMAP.P);
    assert.equal(KINMAP[name].comps[0].length, KINMAP.D);
    assert.equal(KINMAP[name].W.length, KINMAP.P);
    assert.equal(KINMAP[name].W[0].length, KINMAP.P);
  }
});

test('a truncated or mislabelled map file is refused rather than half-read', () => {
  const good = readFileSync(new URL('../models/kinmap.bin', import.meta.url));
  const short = good.subarray(0, good.length - 4);
  assert.equal(K.rxParseKinmap(short.buffer.slice(short.byteOffset, short.byteOffset + short.byteLength)), null,
    'a file missing its last floats must not be used as if it were whole');
  const wrong = Buffer.from(good);
  wrong.write('NOPE', 0, 'ascii');
  assert.equal(K.rxParseKinmap(wrong.buffer.slice(wrong.byteOffset, wrong.byteOffset + wrong.byteLength)), null);
});

// A deterministic stand-in for a region embedding: unit length, 512 wide, like the real thing.
function fakeVec(seed) {
  let s = seed >>> 0;
  const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff);
  const v = [];
  for (let i = 0; i < 512; i++) v.push(rnd() * 2 - 1);
  let n = 0; for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return Float32Array.from(v.map((x) => x / n));
}

test('the map runs adult→child, and is not the same comparison reversed', () => {
  const adult = fakeVec(11), child = fakeVec(22);
  const forward = K.rxRegionCosine(KINMAP, 'nose', adult, child);
  const backward = K.rxRegionCosine(KINMAP, 'nose', child, adult);
  assert.ok(typeof forward === 'number' && isFinite(forward));
  assert.ok(Math.abs(forward - backward) > 1e-6,
    'if swapping the two faces gave the same number the map would not be doing anything directional');
});

test('a face compared with itself still comes out top of its own region scale', () => {
  const v = fakeVec(7);
  const self = K.rxRegionCosine(KINMAP, 'eyes', v, v);
  const other = K.rxRegionCosine(KINMAP, 'eyes', v, fakeVec(8));
  assert.ok(self > other, 'the mapped comparison must still rank an identical face above a different one');
});

test('a region cosine lands on the 0-100 scale, and an unusable one stays null', () => {
  assert.equal(R.rxRegionLikeness('nose', null), null);
  assert.equal(R.rxRegionLikeness('ears', 0.5), null, 'only the three fitted regions have a scale');
  assert.equal(R.rxRegionLikeness('nose', -99), 0, 'clamped, not negative');
  assert.equal(R.rxRegionLikeness('nose', 99), 100);
  const mid = R.rxRegionLikeness('nose', (R.RX_REGION_SCALE.nose[0] + R.RX_REGION_SCALE.nose[1]) / 2);
  assert.ok(Math.abs(mid - 50) < 0.001, 'the middle of the measured range is the middle of the scale');
});

test('region scores replace the three rows they were fitted for, and nothing else', () => {
  const table = R.rxMergeRounds([R.rxRound(VA, [VA, VB], null)], 2);
  const before = {};
  for (const f of R.RX_FEATURES) before[f.key] = table.features[f.key].mean.slice();
  const used = R.rxApplyRegions(table, 2, [{ eyes: 10, nose: 10, mouth: 10 }, { eyes: 90, nose: 90, mouth: 90 }]);
  assert.equal(used, true);
  for (const f of R.RX_FEATURES) {
    if (R.RX_REGION_FEATURES.includes(f.key)) {
      assert.notDeepEqual(table.features[f.key].mean, before[f.key], `${f.key} should now be the network's answer`);
    } else {
      assert.deepEqual(table.features[f.key].mean, before[f.key], `${f.key} has no map and must be left alone`);
    }
  }
  assert.equal(table.features.nose.mean[1], 90);
});

test('a feature ruled out by an occluder is not quietly rescued by the network', () => {
  // Sunglasses knock out the eye measurements. The network would happily read "eyes" off the
  // lenses — measuring an invention is the mistake this app has already made once, so a feature
  // that the measurements could not reach stays unreached.
  const blocked = {};
  for (const m of M.RX_MEASURES) if (m.feature === 'eyes') blocked[m.key] = true;
  const table = R.rxMergeRounds([R.rxRound(VA, [VA, VB], [blocked, blocked])], 2);
  R.rxApplyRegions(table, 2, [{ eyes: 95, nose: 50, mouth: 50 }, { eyes: 5, nose: 50, mouth: 50 }]);
  assert.equal(table.features.eyes.mean[0], null, 'a blocked feature must stay blocked');
  assert.equal(table.features.eyes.mean[1], null);
  assert.ok(typeof table.features.nose.mean[0] === 'number', 'the features that were readable still get mapped');
});

test('the headline uses the weights that match the evidence it was given', () => {
  // With the maps in play the eyes, nose and mouth rows are network evidence and carry the weights
  // measured for that; without them they are landmark ratios and carry the older ones. Scoring one
  // with the other's table is the same class of mistake as reading a gap off the wrong null.
  const table = R.rxMergeRounds([R.rxRound(VA, [VA, VB], null)], 2);
  const plain = R.rxOverall(table, 2, null, false);
  const asMapped = R.rxOverall(table, 2, null, true);
  assert.ok(typeof plain.raw[1] === 'number' && typeof asMapped.raw[1] === 'number');
  assert.notEqual(Math.round(plain.raw[1] * 100), Math.round(asMapped.raw[1] * 100),
    'the two weight tables must actually differ in effect');
  for (const f of R.RX_FEATURES) {
    assert.ok(typeof f.mapped === 'number' && f.mapped > 0, `${f.key} has no measured mapped weight`);
  }
});

test('the region ruler has its own measured null, and it is stricter than the geometry one', () => {
  const g = R.RX_SCALES.regions;
  assert.ok(g, 'there is no region scale');
  assert.ok(g.clear > g.lean, 'a clear lead must be a bigger gap than a lean');
  // The thresholds are the null: "leans" beats three quarters of chance gaps, "takes after" 95%.
  const quarter = g.nullGap.find((x) => x.chance === 25).gap;
  const five = g.nullGap.find((x) => x.chance === 5).gap;
  assert.ok(Math.abs(g.lean - quarter) <= 1, 'the lean threshold must track the measured 75th percentile');
  assert.ok(Math.abs(g.clear - five) <= 1, 'the clear threshold must track the measured 95th percentile');
  for (let i = 1; i < g.nullGap.length; i++) {
    assert.ok(g.nullGap[i].gap > g.nullGap[i - 1].gap, 'the null table must be ordered');
    assert.ok(g.nullGap[i].chance < g.nullGap[i - 1].chance);
  }
});
