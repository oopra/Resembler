// Browser tests driving the real page.
//
// The face mesh is stubbed for most of these — fed the landmark fixtures, so a test can say "this
// child IS this parent" and check what the page does about it. One test at the end deliberately does
// NOT stub it: it loads the real vendored runtime and model, which is the only way to catch the
// asset wiring silently breaking.
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, launchBrowser, newPage, fakeFace, fixture } from './helpers.mjs';

let srv, browser, page;
before(async () => { srv = await startServer(); browser = await launchBrowser(); });
after(async () => { await browser?.close(); await srv?.close(); });
beforeEach(async () => { page = await newPage(browser, srv.url); });

const A = fixture('portrait-a');
const B = fixture('portrait-b');

/* Replace the mesh with a queue of fixtures. The app reads the child first and then each person in
   order, once per reading, so a queue of [child, p0, p1] repeats cleanly across readings. */
async function stubMesh(p, queue) {
  await p.evaluate((q) => {
    window.__seen = 0;
    window.rxLoadMesh = function (cb) { if (cb) cb(1, ''); return Promise.resolve({}); };
    window.rxDetect = function () {
      const f = q[window.__seen++ % q.length];
      return { pts: f.pts, blend: f.blend || {}, pose: f.pose || { yaw: 0, pitch: 0, roll: 0 }, faces: f.faces || 1 };
    };
    window.rxAutoFrameFromMesh = async function (src) {
      const d = rxDims(src);
      return { frame: rxClampFrame({ cx: d.w / 2, cy: d.h * 0.42, size: Math.min(d.w, d.h) * 0.7, angle: 0 }, d.w, d.h),
               faces: 1, pose: { yaw: 0, pitch: 0, roll: 0 } };
    };
  }, queue);
}

async function addPhoto(p, selector, seed) {
  await p.setInputFiles(selector, { name: `face${seed}.png`, mimeType: 'image/png', buffer: fakeFace(seed) });
  await p.waitForFunction((sel) => {
    const card = document.querySelector(sel).closest('.card');
    return card && !card.querySelector('.tools').hidden;
  }, selector);
}

async function fillForm(p, names = ['Baby', 'Mum', 'Dad'], seeds = [1, 2, 3]) {
  await addPhoto(p, '#childSlots .file', seeds[0]);
  await addPhoto(p, '#peopleSlots .card:nth-child(1) .file', seeds[1]);
  await addPhoto(p, '#peopleSlots .card:nth-child(2) .file', seeds[2]);
  await p.fill('#childSlots .name-in', names[0]);
  await p.fill('#peopleSlots .card:nth-child(1) .name-in', names[1]);
  await p.fill('#peopleSlots .card:nth-child(2) .name-in', names[2]);
}
const setPasses = (p, n) => p.check(`input[name=passes][value="${n}"]`);
const runCompare = async (p) => {
  await p.click('#compareBtn');
  await p.waitForSelector('#results:not([hidden])', { timeout: 30000 });
};

/* ---------- the page ---------- */

test('loads clean, with a child card and two people to compare', async () => {
  assert.equal(await page.$$eval('#childSlots .card', (e) => e.length), 1);
  assert.equal(await page.$$eval('#peopleSlots .card', (e) => e.length), 2);
  assert.equal(await page.isDisabled('#compareBtn'), true);
  assert.deepEqual(page.__errors, []);
});

test('the compare button unlocks only once the child and someone else have photos', async () => {
  await stubMesh(page, [A]);
  await addPhoto(page, '#childSlots .file', 1);
  assert.equal(await page.isDisabled('#compareBtn'), true, 'a child alone is not a comparison');
  await addPhoto(page, '#peopleSlots .card:nth-child(1) .file', 2);
  assert.equal(await page.isDisabled('#compareBtn'), false);
});

test('people can be added up to the limit, and the last two cannot be removed', async () => {
  for (let i = 0; i < 4; i++) await page.click('#addPersonBtn');
  assert.equal(await page.$$eval('#peopleSlots .card', (e) => e.length), 6);
  assert.equal(await page.isHidden('#addPersonBtn'), true);
  await page.click('#peopleSlots .card:nth-child(6) .x');
  assert.equal(await page.$$eval('#peopleSlots .card', (e) => e.length), 5);
});

test('a loaded photo is framed, previewed and adjustable', async () => {
  await stubMesh(page, [A]);
  await addPhoto(page, '#childSlots .file', 1);
  const before = await page.evaluate(() => ({
    size: rxChild.frame.size, dims: rxChild.dims,
    painted: (() => {
      const c = rxChild.els.canvas, d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      for (let i = 0; i < d.length; i += 4) if (d[i] !== d[0] || d[i + 1] !== d[1]) return true;
      return false;
    })()
  }));
  assert.ok(before.painted, 'the preview shows the prepared crop');
  await page.evaluate(() => rxZoomTo(rxChild, 90));
  const after = await page.evaluate(() => ({ ...rxChild.frame, w: rxChild.dims.w, h: rxChild.dims.h }));
  assert.ok(after.size < before.size, 'zooming in tightens the crop');
  assert.ok(after.cx >= after.size / 2 && after.cx <= after.w - after.size / 2, 'and stays inside the photo');
});

/* ---------- nothing leaves the device ---------- */

test('no network request is made while comparing', async () => {
  const external = [];
  await page.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.origin !== new URL(srv.url).origin) external.push(u.href);
    route.continue();
  });
  await stubMesh(page, [A, A, B]);
  await fillForm(page);
  await setPasses(page, 2);
  await runCompare(page);
  assert.deepEqual(external, [], 'a family photo has nowhere to go, and goes nowhere');
});

/* ---------- the verdict ---------- */

test('a child whose face IS one parent’s is called for that parent', async () => {
  // Same landmarks and the same photo for the child and Mum; Dad is a different face.
  await stubMesh(page, [A, A, B]);
  await fillForm(page, ['Baby', 'Mum', 'Dad'], [1, 1, 3]);
  await setPasses(page, 2);
  await runCompare(page);

  const r = await page.evaluate(() => ({
    lead: document.querySelector('.v-lead').textContent,
    sub: document.querySelector('.v-sub').textContent,
    raw: rxLastRun.overall.raw.map(Math.round),
    stability: rxLastRun.verdict.stability
  }));
  assert.equal(r.lead, 'Takes after Mum');
  assert.equal(r.raw[0], 100);
  assert.ok(r.raw[1] < 90);
  assert.equal(r.stability, 1);
  assert.match(r.sub, /every reading agreed/);
});

test('two identical candidates produce a dead heat, not an arbitrary winner', async () => {
  await stubMesh(page, [A, A, A]);
  await fillForm(page, ['Baby', 'Mum', 'Dad'], [2, 2, 2]);
  await setPasses(page, 1);
  await runCompare(page);

  const r = await page.evaluate(() => ({
    lead: document.querySelector('.v-lead').textContent,
    shares: rxLastRun.overall.share.map(Math.round),
    chips: [...document.querySelectorAll('.fchip')].map((e) => e.textContent)
  }));
  assert.equal(r.lead, 'A genuine mix of Mum and Dad');
  assert.deepEqual(r.shares, [50, 50]);
  assert.ok(r.chips.every((c) => c === 'too close to call'), 'nothing is handed to anyone on a tie');
});

test('the ordering of the people on the page cannot change the answer', async () => {
  await stubMesh(page, [A, A, B]);
  await fillForm(page, ['Baby', 'Mum', 'Dad'], [1, 1, 3]);
  await setPasses(page, 1);
  await runCompare(page);
  const first = await page.evaluate(() => rxLastRun.overall.raw.map(Math.round));

  const p2 = await newPage(browser, srv.url);
  await stubMesh(p2, [A, B, A]);
  await fillForm(p2, ['Baby', 'Dad', 'Mum'], [1, 3, 1]);
  await setPasses(p2, 1);
  await runCompare(p2);
  const second = await p2.evaluate(() => rxLastRun.overall.raw.map(Math.round));
  assert.deepEqual(first, [second[1], second[0]], 'swapping the two people just swaps the two scores');
});

/* ---------- reading the result ---------- */

test('the result shows every feature, the crops that were measured, and where the numbers came from', async () => {
  await stubMesh(page, [A, A, B]);
  await fillForm(page, ['Baby', 'Mum', 'Dad'], [1, 1, 3]);
  await setPasses(page, 2);
  await runCompare(page);

  const r = await page.evaluate(() => ({
    rows: document.querySelectorAll('.frow').length,
    features: [...document.querySelectorAll('.fname')].map((e) => e.textContent),
    names: [...document.querySelectorAll('.line-row .line-name')].map((e) => e.textContent),
    childShown: document.querySelector('.line-child img').src.startsWith('data:image/jpeg'),
    cropsShown: [...document.querySelectorAll('.line-row img')].every((i) => i.src.startsWith('data:image/jpeg')),
    notes: [...document.querySelectorAll('.fnote')].map((e) => e.textContent),
    provenance: document.getElementById('provenance').textContent
  }));
  assert.equal(r.rows, 8, 'all eight features are reported');
  assert.ok(!r.features.some((f) => /ear|hairline/i.test(f)), 'and nothing a face mesh cannot see');
  assert.deepEqual(r.names, ['Mum', 'Dad']);
  assert.ok(r.childShown && r.cropsShown, 'you can see exactly which crops were measured');
  assert.ok(r.notes.length > 0 && r.notes.every((n) => /closest on /.test(n)), 'each note cites a measurement');
  assert.match(r.provenance, /2 readings.*measured on this device · nothing was uploaded/);
});

test('features are attributed one at a time — her nose from one, his eyes from the other', async () => {
  // A child built from A's nose, B's eyes and a 50/50 blend of everything else, expressed as
  // landmarks so the whole pipeline does the work.
  const child = JSON.parse(JSON.stringify(A));
  await stubMesh(page, [child, A, B]);
  await fillForm(page, ['Baby', 'Mum', 'Dad'], [1, 1, 3]);
  await setPasses(page, 1);
  await runCompare(page);
  const r = await page.evaluate(() => ({
    mix: document.getElementById('mixLine').textContent,
    won: rxLastRun.calls.filter((c) => rxAttributed(c)).map((c) => [c.key, rxLastRun.run.names[c.winner]])
  }));
  assert.ok(r.won.length > 0, 'an identical face wins features outright');
  assert.ok(r.won.every(([, who]) => who === 'Mum'));
  assert.match(r.mix, /Mum’s/);
});

test('a broad open grin makes the mouth uncomparable, and says so rather than scoring it', async () => {
  // A closed smile only moves the mouth's WIDTH, and the rest of the mouth stays comparable — which
  // is why this uses an open grin, which takes the lips and the jaw with it too.
  const smiling = { ...B, blend: { mouthSmileLeft: 0.9, mouthSmileRight: 0.88, jawOpen: 0.8 } };
  await stubMesh(page, [A, A, smiling]);
  await fillForm(page, ['Baby', 'Mum', 'Dad'], [1, 1, 3]);
  await setPasses(page, 1);
  await runCompare(page);

  const r = await page.evaluate(() => ({
    chip: [...document.querySelectorAll('.frow')].map((row) => [row.querySelector('.fname').textContent,
                                                               row.querySelector('.fchip').textContent])
      .find((x) => x[0] === 'Mouth & lips'),
    caveats: document.getElementById('caveats').textContent,
    won: rxLastRun.calls.filter((c) => rxAttributed(c)).map((c) => c.key)
  }));
  assert.deepEqual(r.chip, ['Mouth & lips', 'not comparable for everyone']);
  assert.ok(!r.won.includes('mouth'), 'Mum does not inherit the mouth by walkover');
  assert.ok(!r.won.includes('jaw'), 'nor the jaw, which an open mouth also moves');
  assert.match(r.caveats, /Some mouth, jaw and face shape measurements were dropped/);
  assert.match(r.caveats, /because of a smile and an open mouth in Dad’s photo/);
});

test('a face turned away from the camera is flagged rather than quietly mismeasured', async () => {
  const turned = { ...B, pose: { yaw: 34, pitch: 2, roll: 0 } };
  await stubMesh(page, [A, A, turned]);
  await fillForm(page, ['Baby', 'Mum', 'Dad'], [1, 1, 3]);
  await setPasses(page, 1);
  await runCompare(page);
  assert.match(await page.textContent('#caveats'), /Dad: This face is turned about 34°/);
});

test('a photo with no face in it is set aside, named, and does not drag the others down', async () => {
  await page.evaluate(() => { window.__noFaceFor = 2; });
  await stubMesh(page, [A, A, B]);
  await page.evaluate(() => {
    const real = window.rxDetect;
    let i = 0;
    window.rxDetect = function (s) { const r = real(s); return (i++ % 3) === 2 ? null : r; };
  });
  await fillForm(page, ['Baby', 'Mum', 'Dad'], [1, 1, 3]);
  await setPasses(page, 1);
  await runCompare(page);

  const r = await page.evaluate(() => ({
    rows: document.querySelectorAll('.line-row').length,
    names: rxLastRun.run.names,
    caveats: document.getElementById('caveats').textContent,
    raw: rxLastRun.overall.raw.map(Math.round)
  }));
  assert.equal(r.rows, 1, 'only the readable person is shown');
  assert.deepEqual(r.names, ['Mum']);
  assert.match(r.caveats, /Dad: no face could be found/);
  assert.equal(r.raw[0], 100, 'and the readable person is scored normally');
});

test('comparing against one person says so instead of declaring a winner', async () => {
  await stubMesh(page, [A, B]);
  await addPhoto(page, '#childSlots .file', 1);
  await addPhoto(page, '#peopleSlots .card:nth-child(1) .file', 2);
  await page.fill('#peopleSlots .card:nth-child(1) .name-in', 'Mum');
  await setPasses(page, 1);
  await runCompare(page);
  const r = await page.evaluate(() => ({
    lead: document.querySelector('.v-lead').textContent,
    sub: document.querySelector('.v-sub').textContent
  }));
  assert.equal(r.lead, 'Compared with Mum alone');
  assert.match(r.sub, /nothing to weigh this against/);
  assert.ok(!/undefined/.test(r.lead + r.sub));
});

test('the copied text matches what is on screen, disclaimer included', async () => {
  await stubMesh(page, [A, A, B]);
  await fillForm(page, ['Baby', 'Mum', 'Dad'], [1, 1, 3]);
  await setPasses(page, 1);
  await runCompare(page);
  const text = await page.evaluate(() => rxResultText());
  assert.match(text, /^Takes after Mum/);
  assert.match(text, /Measured on-device from face geometry/);
  assert.match(text, /not a paternity, DNA or identity test/);
  for (const label of ['Eyes', 'Nose', 'Jaw & chin', 'Colouring']) assert.ok(text.includes(label + ':'));
});

test('an unreadable child photo fails honestly and leaves the form usable', async () => {
  await stubMesh(page, [A, A, B]);
  await page.evaluate(() => { window.rxDetect = function () { return null; }; });
  await fillForm(page);
  await page.click('#compareBtn');
  await page.waitForFunction(() => document.getElementById('status').classList.contains('bad'));
  assert.match(await page.textContent('#status'), /No face could be found in the child/);
  assert.equal(await page.isHidden('#results'), true, 'no result is shown when there is no result');
  assert.equal(await page.isDisabled('#compareBtn'), false, 'and you can try again');
  assert.deepEqual(page.__errors, []);
});

test('the page carries its own caveats without being asked', async () => {
  const footer = await page.textContent('.footnote');
  assert.match(footer, /not a paternity test/i);
  assert.match(footer, /Ears and hairline/);
  assert.match(footer, /Nothing is uploaded/);
  assert.match(await page.textContent('.badge'), /Runs entirely on your device/);
});

/* ---------- the real thing ---------- */

test('the vendored face mesh actually loads and starts from these files alone', async () => {
  // No stub. This downloads the real runtime and model from the test server, which is the only way
  // to notice that a vendored asset has gone missing, been served with the wrong type, or that the
  // page's own Content-Security-Policy would block the WebAssembly.
  const started = await page.evaluate(async () => {
    const steps = [];
    await rxLoadMesh((frac, label) => { if (label) steps.push(label); });
    return { ok: !!rxMeshState.landmarker, sawProgress: steps.length > 0, first: steps[0] || '' };
  });
  assert.equal(started.ok, true, 'a FaceLandmarker was created from the vendored files');
  assert.ok(started.sawProgress, 'and the download reported itself rather than hanging silently');
  assert.match(started.first, /face-mesh runtime/);
  assert.deepEqual(page.__errors, []);
});
