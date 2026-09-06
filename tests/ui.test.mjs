// Browser tests driving the real page, with the comparison API stubbed so the whole flow —
// framing, blinding, rotation, scoring, rendering — runs end to end and deterministically.
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, launchBrowser, newPage, fakeFace } from './helpers.mjs';

let srv, browser, page;
before(async () => { srv = await startServer(); browser = await launchBrowser(); });
after(async () => { await browser?.close(); await srv?.close(); });
beforeEach(async () => { page = await newPage(browser, srv.url); });

const FEATURES = ['eyes', 'nose', 'shape', 'jaw', 'mouth', 'brows', 'cheeks', 'ears', 'hairline', 'colouring'];
const featureBlock = (byLetter) => {
  const f = {};
  for (const k of FEATURES) f[k] = { ...byLetter, note: 'a note about the ' + k };
  return f;
};

// Stub /api/compare, recording every request body so the tests can inspect what actually went out.
// `score` receives the request body and returns { A: n, B: n, … }.
async function stubAPI(p, score) {
  const sent = [];
  await p.route('**/api/compare', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    sent.push(body);
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ features: featureBlock(score(body)), issues: [],
        provider: 'Stub', model: 'stub-1', usage: { input: 10, output: 10, total: 20 } })
    });
  });
  return sent;
}

async function addPhoto(p, selector, seed) {
  await p.setInputFiles(selector, { name: `face${seed}.png`, mimeType: 'image/png', buffer: fakeFace(seed) });
  await p.waitForFunction((sel) => {
    const card = document.querySelector(sel).closest('.card');
    return card && !card.querySelector('.tools').hidden;
  }, selector.replace(' .file', ' .file'));
}

// Child + two people, named, with photos loaded and ready to compare.
async function fillForm(p, names = ['Baby', 'Mum', 'Dad']) {
  await addPhoto(p, '#childSlots .file', 1);
  const people = await p.$$('#peopleSlots .card');
  await addPhoto(p, '#peopleSlots .card:nth-child(1) .file', 2);
  await addPhoto(p, '#peopleSlots .card:nth-child(2) .file', 3);
  assert.equal(people.length, 2);
  await p.fill('#childSlots .name-in', names[0]);
  await p.fill('#peopleSlots .card:nth-child(1) .name-in', names[1]);
  await p.fill('#peopleSlots .card:nth-child(2) .name-in', names[2]);
}
const setPasses = (p, n) => p.check(`input[name=passes][value="${n}"]`);
const runCompare = async (p) => {
  await p.click('#compareBtn');
  await p.waitForSelector('#results:not([hidden])', { timeout: 20000 });
};

/* ---------- the page itself ---------- */

test('loads clean, with a child card and two people to compare', async () => {
  assert.equal(await page.$$eval('#childSlots .card', (e) => e.length), 1);
  assert.equal(await page.$$eval('#peopleSlots .card', (e) => e.length), 2);
  assert.equal(await page.isDisabled('#compareBtn'), true, 'nothing to compare yet');
  assert.deepEqual(page.__errors, []);
});

test('the compare button unlocks only once the child and someone else have photos', async () => {
  await addPhoto(page, '#childSlots .file', 1);
  assert.equal(await page.isDisabled('#compareBtn'), true, 'a child alone is not a comparison');
  await addPhoto(page, '#peopleSlots .card:nth-child(1) .file', 2);
  assert.equal(await page.isDisabled('#compareBtn'), false);
});

test('people can be added up to the limit and the add button then disappears', async () => {
  for (let i = 0; i < 4; i++) await page.click('#addPersonBtn');
  assert.equal(await page.$$eval('#peopleSlots .card', (e) => e.length), 6);
  assert.equal(await page.isHidden('#addPersonBtn'), true);
});

test('the last two people cannot be removed — a comparison needs something to compare', async () => {
  await page.click('#addPersonBtn');
  await page.click('#peopleSlots .card:nth-child(3) .x');
  assert.equal(await page.$$eval('#peopleSlots .card', (e) => e.length), 2);
  assert.equal(await page.isHidden('#peopleSlots .card:nth-child(1) .x'), true);
});

test('a loaded photo is framed, previewed and adjustable', async () => {
  await addPhoto(page, '#childSlots .file', 1);
  const state = await page.evaluate(() => ({
    hasSrc: !!rxChild.src, size: rxChild.frame.size,
    cx: rxChild.frame.cx, dims: rxChild.dims,
    painted: (() => {
      const c = rxChild.els.canvas, d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      for (let i = 0; i < d.length; i += 4) if (d[i] !== d[0] || d[i + 1] !== d[1]) return true;
      return false;
    })()
  }));
  assert.ok(state.hasSrc);
  assert.ok(state.size > 0 && state.size <= Math.min(state.dims.w, state.dims.h));
  assert.ok(state.painted, 'the preview canvas shows the prepared crop');

  // Zooming in shrinks the crop; the frame stays inside the photo.
  await page.evaluate(() => rxZoomTo(rxChild, 90));
  const zoomed = await page.evaluate(() => ({ ...rxChild.frame, w: rxChild.dims.w, h: rxChild.dims.h }));
  assert.ok(zoomed.size < state.size, 'zooming in tightens the crop');
  assert.ok(zoomed.cx >= zoomed.size / 2 && zoomed.cx <= zoomed.w - zoomed.size / 2);
});

/* ---------- what actually leaves the device ---------- */

test('names never leave the device, and each pass sends a different order', async () => {
  const sent = await stubAPI(page, () => ({ A: 70, B: 40 }));
  await fillForm(page, ['Baby', 'Mum', 'Dad']);
  await setPasses(page, 3);
  await runCompare(page);

  assert.equal(sent.length, 3, 'three passes, three calls');
  for (const body of sent) {
    // Compare against the body with the image payloads trimmed: a 50 KB base64 blob contains every
    // short letter sequence by chance, so searching it for "Mum" only ever finds coincidences.
    const scrubbed = JSON.stringify({ ...body, child: body.child.slice(0, 40), others: body.others.map((u) => u.slice(0, 40)) });
    for (const name of ['Baby', 'Mum', 'Dad']) assert.ok(!scrubbed.includes(name), `"${name}" must not be sent`);
    assert.deepEqual(Object.keys(body).sort(), ['child', 'others']);
    assert.equal(body.others.length, 2);
    assert.ok(body.child.startsWith('data:image/jpeg;base64,'));
  }
  // With two people, rotation means pass 2 reverses pass 1.
  assert.notDeepEqual(sent[0].others, sent[1].others, 'the running order changed between passes');
  assert.deepEqual(sent[0].others, sent[2].others, 'and rotated back round on the third');
});

test('a reader that always flatters the first photo produces a dead heat, not a false winner', async () => {
  // This is the whole point of rotating the order: a fixed position bias has to cancel out.
  await stubAPI(page, () => ({ A: 88, B: 32 }));
  await fillForm(page);
  await setPasses(page, 2);
  await runCompare(page);

  const r = await page.evaluate(() => ({
    lead: document.querySelector('.v-lead').textContent,
    confidence: rxLastRun.verdict.confidence,
    raw: rxLastRun.overall.raw.map(Math.round)
  }));
  assert.deepEqual(r.raw, [60, 60], 'the two passes cancelled the position bias exactly');
  assert.equal(r.confidence, 'mix');
  assert.equal(r.lead, 'A genuine mix of Mum and Dad');
});

test('a reader that consistently favours one face names that person, whatever slot they were in', async () => {
  // Score by image content, not by slot — the same face scores 86 whichever letter it arrives as,
  // so the right name must come out no matter how the passes shuffled the order.
  let favourite = null;
  await stubAPI(page, (body) => {
    if (!favourite) favourite = body.others[0];
    const out = {};
    body.others.forEach((url, i) => { out[String.fromCharCode(65 + i)] = url === favourite ? 86 : 34; });
    return out;
  });
  await fillForm(page, ['Baby', 'Mum', 'Dad']);
  await setPasses(page, 2);
  await runCompare(page);

  // Which person was the favoured face? Ask the page, using the very crops it sent.
  const r = await page.evaluate((fav) => ({
    who: rxLastRun.run.prepared.findIndex((p) => p.dataUrl === fav),
    lead: document.querySelector('.v-lead').textContent,
    names: rxLastRun.run.names,
    stability: rxLastRun.verdict.stability,
    shares: rxLastRun.overall.share.map(Math.round)
  }), favourite);
  assert.ok(r.who >= 0, 'the favoured crop is one of the two that were sent');
  assert.equal(r.lead, 'Takes after ' + r.names[r.who]);
  assert.equal(r.stability, 1, 'both passes agreed');
  assert.equal(r.shares[r.who], 72);
  assert.equal(r.shares[1 - r.who], 28);
});

/* ---------- reading the result ---------- */

test('the result shows every feature, the winners, and the crops that were compared', async () => {
  await stubAPI(page, (body) => {
    // Give the first-sent face the eyes and the second the nose, whichever slot they land in.
    return { A: 60, B: 60 };
  });
  await fillForm(page);
  await setPasses(page, 1);
  await runCompare(page);

  const r = await page.evaluate(() => ({
    rows: document.querySelectorAll('.frow').length,
    names: [...document.querySelectorAll('.line-row .line-name')].map((e) => e.textContent),
    childShown: document.querySelector('.line-child img').src.startsWith('data:image/jpeg'),
    cropsShown: [...document.querySelectorAll('.line-row img')].every((i) => i.src.startsWith('data:image/jpeg')),
    chips: [...document.querySelectorAll('.fchip')].map((e) => e.textContent),
    notes: document.querySelectorAll('.fnote').length,
    provenance: document.getElementById('provenance').textContent
  }));
  assert.equal(r.rows, 10, 'all ten features are reported');
  assert.deepEqual(r.names, ['Mum', 'Dad']);
  assert.ok(r.childShown && r.cropsShown, 'you can see exactly which crops were compared');
  assert.ok(r.chips.every((c) => c === 'too close to call'), 'a dead-level score is never given a winner');
  assert.equal(r.notes, 10);
  assert.match(r.provenance, /1 look · read by Stub \(stub-1\)/);
});

test('features are attributed one by one — her eyes from one, his nose from the other', async () => {
  // One face gets the eyes, the other gets the nose, keyed to the image rather than the slot.
  let favourite = null;
  await page.route('**/api/compare', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    if (!favourite) favourite = body.others[0];
    const letter = (url) => String.fromCharCode(65 + body.others.indexOf(url));
    const fav = letter(favourite), other = body.others.map(letter).find((L) => L !== fav);
    const f = {};
    for (const k of FEATURES) f[k] = { [fav]: 55, [other]: 55, note: 'level' };
    f.eyes = { [fav]: 88, [other]: 30, note: 'the same heavy lid' };
    f.nose = { [fav]: 25, [other]: 85, note: 'the same broad bridge' };
    await route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ features: f, issues: [], provider: 'Stub', model: 'stub-1', usage: { total: 20 } }) });
  });
  await fillForm(page, ['Baby', 'Mum', 'Dad']);
  await setPasses(page, 2);
  await runCompare(page);

  const r = await page.evaluate((fav) => ({
    who: rxLastRun.run.prepared.findIndex((p) => p.dataUrl === fav),
    names: rxLastRun.run.names,
    mix: document.getElementById('mixLine').textContent,
    text: rxResultText()
  }), favourite);
  const eyesFrom = r.names[r.who], noseFrom = r.names[1 - r.who];
  assert.ok(r.mix.includes(eyesFrom + '\u2019s eyes'), 'the eyes are attributed by name');
  assert.ok(r.mix.includes(noseFrom + '\u2019s nose'), 'the nose goes to the other one');
  assert.match(r.text, new RegExp('Eyes: ' + eyesFrom));
  assert.match(r.text, new RegExp('Nose: ' + noseFrom));
  assert.match(r.text, /not a paternity, DNA or identity test/);
  // Everything else was level, so nothing else may be claimed for anyone.
  assert.match(r.text, /Jaw & chin: too close to call/);
});

test('what the reader could not see comes back in the caveats, with names restored', async () => {
  await page.route('**/api/compare', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    const f = {};
    for (const k of FEATURES) f[k] = { A: 60, B: 40, note: 'n' };
    delete f.ears.A; delete f.ears.B;
    await route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ features: f, issues: ['B: ears are hidden by hair'], provider: 'Stub', model: 'stub-1', usage: { total: 5 } }) });
  });
  await fillForm(page, ['Baby', 'Mum', 'Dad']);
  await setPasses(page, 1);
  await runCompare(page);

  const caveats = await page.textContent('#caveats');
  assert.ok(/Mum: ears are hidden|Dad: ears are hidden/.test(caveats), 'the letter is turned back into a name');
  assert.ok(!/\bB:/.test(caveats), 'the user never sees the blind letters');
  const chips = await page.$$eval('.frow', (rows) => rows.map((r) => [r.querySelector('.fname').textContent, r.querySelector('.fchip').textContent]));
  assert.deepEqual(chips.find((c) => c[0] === 'Ears'), ['Ears', 'not visible']);
});

test('a server error is shown plainly and nothing is invented', async () => {
  await page.route('**/api/compare', (route) => route.fulfill({
    status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Comparing isn’t set up on this deployment.' })
  }));
  await fillForm(page);
  await page.click('#compareBtn');
  await page.waitForFunction(() => document.getElementById('status').textContent.length > 0);
  assert.match(await page.textContent('#status'), /isn’t set up/);
  assert.equal(await page.isHidden('#results'), true, 'no result is shown when there is no result');
  assert.equal(await page.isDisabled('#compareBtn'), false, 'and you can try again');
  assert.deepEqual(page.__errors, []);
});

test('the page carries the "this is not a paternity test" note without being asked', async () => {
  const footer = await page.textContent('.footnote');
  assert.match(footer, /not a paternity test/i);
  assert.match(footer, /not stored/i);
});

test('comparing against one person says so instead of declaring a winner', async () => {
  await stubAPI(page, () => ({ A: 78 }));
  await addPhoto(page, '#childSlots .file', 1);
  await addPhoto(page, '#peopleSlots .card:nth-child(1) .file', 2);
  await page.fill('#peopleSlots .card:nth-child(1) .name-in', 'Mum');
  await setPasses(page, 1);
  await runCompare(page);

  const r = await page.evaluate(() => ({
    lead: document.querySelector('.v-lead').textContent,
    sub: document.querySelector('.v-sub').textContent,
    rows: document.querySelectorAll('.line-row').length
  }));
  assert.equal(r.lead, 'Compared with Mum alone');
  assert.match(r.sub, /nothing to weigh this against/);
  assert.ok(!/undefined/.test(r.sub + r.lead), 'no phantom runner-up');
  assert.equal(r.rows, 1);
});
