// The server's job is to refuse anything that is not the agreed shape, so that a model having an
// off day cannot reach the browser as a confident-looking number. These test that refusal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FEATURES, extractJSON, normalise } from '../functions/api/compare.js';

const full = (byLetter) => {
  const f = {};
  for (const k of FEATURES) f[k] = { ...byLetter };
  return f;
};

test('extractJSON: digs the object out of a code fence or a chatty preamble', () => {
  assert.deepEqual(extractJSON('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJSON('Sure! Here you go: {"a":1} — hope that helps'), { a: 1 });
  assert.equal(extractJSON('no json here'), null);
  assert.equal(extractJSON('{ not valid'), null);
});

test('normalise: a complete answer passes through, rounded and clamped', () => {
  const out = normalise({ features: full({ A: 71.6, B: 140, note: 'a note' }) }, ['A', 'B']);
  assert.equal(out.features.eyes.A, 72);
  assert.equal(out.features.eyes.B, 100, 'out-of-range scores are clamped, not rejected');
  assert.equal(out.features.eyes.note, 'a note');
  assert.equal(Object.keys(out.features).length, FEATURES.length);
});

test('normalise: a letter the model could not judge is dropped, not zeroed', () => {
  const f = full({ A: 60, B: 40 });
  delete f.ears.B;
  const out = normalise({ features: f }, ['A', 'B']);
  assert.equal(out.features.ears.A, 60);
  assert.equal('B' in out.features.ears, false, 'absent means absent — a 0 would be a false judgement');
});

test('normalise: rejects an answer that is missing a feature outright', () => {
  const f = full({ A: 60, B: 40 });
  delete f.nose;
  assert.equal(normalise({ features: f }, ['A', 'B']), null);
});

test('normalise: rejects a feature nobody was scored on', () => {
  const f = full({ A: 60, B: 40 });
  f.jaw = { note: 'hard to say' };
  assert.equal(normalise({ features: f }, ['A', 'B']), null);
});

test('normalise: rejects prose, nulls and non-numeric scores', () => {
  assert.equal(normalise(null, ['A']), null);
  assert.equal(normalise({ answer: 'She looks like her father.' }, ['A']), null);
  assert.equal(normalise({ features: full({ A: 'very similar' }) }, ['A']), null);
  assert.equal(normalise({ features: full({ A: NaN }) }, ['A']), null);
});

test('normalise: ignores letters that were never sent', () => {
  const out = normalise({ features: full({ A: 50, B: 50, Z: 99 }) }, ['A', 'B']);
  assert.deepEqual(Object.keys(out.features.eyes).sort(), ['A', 'B']);
});

test('normalise: notes and issues are trimmed, capped and stripped of non-strings', () => {
  const long = 'x'.repeat(500);
  const out = normalise({ features: full({ A: 50, note: long }), issues: [long, 42, null, ' B: hidden '] }, ['A']);
  assert.equal(out.features.eyes.note.length, 140);
  assert.deepEqual(out.issues, ['x'.repeat(140), 'B: hidden']);
});

test('normalise: a missing issues list is an empty list, never undefined', () => {
  assert.deepEqual(normalise({ features: full({ A: 50 }) }, ['A']).issues, []);
});
