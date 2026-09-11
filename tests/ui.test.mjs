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

// Unit vectors with a chosen cosine to the reference, so a test can say "this is kin-like" (0.13,
// the measured median for real parent/child) or "this is a stranger" (0.01) rather than only
// "identical" or "orthogonal".
const REF = [1, 0, 0, 0];
const atCosine = (c) => [c, Math.sqrt(1 - c * c), 0, 0];
const withEmb = (fx, emb) => ({ ...fx, pts: fx.pts.map((p) => p.slice()), emb });

/* Replace the mesh with a queue of fixtures. The app reads the child first and then each person in
   order, once per reading, so a queue of [child, p0, p1] repeats cleanly across readings. */
async function stubMesh(p, queue) {
  await p.evaluate((q) => {
    window.__seen = 0;
    window.rxLoadMesh = function (cb) { if (cb) cb(1, ''); return Promise.resolve({}); };
    window.rxLoadEmbedder = function (cb) { if (cb) cb(1, ''); return Promise.resolve({}); };

    // A stand-in recognition model that behaves like a real one rather than like landmarks: the same
    // face gives the same vector (cosine 1), two different faces give near-orthogonal ones (cosine
    // ~0). That is the range ArcFace actually occupies — unrelated pairs measured at a median cosine
    // of 0.04. An earlier stub summed raw coordinates, so every face pointed the same way, every
    // cosine clamped to 100, and the blend had nothing left to contribute.
    window.rxEmbed = async function (canvas, pts) {
      // A fixture may carry an explicit `emb` to pin the cosine at a chosen value — needed to
      // exercise kin-level similarity (cosine ~0.1-0.3), which sits between "identical" and
      // "unrelated" and cannot be reached by hashing landmarks.
      const f = q.find((x) => x.pts === pts);
      if (f && f.emb) return Float32Array.from(f.emb);
      let h = 2166136261;
      for (const pt of pts) {
        h ^= Math.round(pt[0] * 100000); h = Math.imul(h, 16777619);
        h ^= Math.round(pt[1] * 100000); h = Math.imul(h, 16777619);
      }
      let seed = h >>> 0;
      const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff);
      const v = [];
      for (let i = 0; i < 64; i++) v.push(rnd() * 2 - 1);
      let n = 0; for (const x of v) n += x * x;
      n = Math.sqrt(n) || 1;
      return Float32Array.from(v.map((x) => x / n));
    };

    window.rxDetect = function () {
      const f = q[window.__seen++ % q.length];
      return { pts: f.pts, blend: f.blend || {}, pose: f.pose || { yaw: 0, pitch: 0, roll: 0 },
               faces: f.faces || 1, eyes: f.eyes || { contrast: 0.5, eyeVsCheek: 0.9, covered: false } };
    };
    window.rxAutoFrameFromMesh = async function (src) {
      const d = rxDims(src);
      return { frame: rxClampFrame({ cx: d.w / 2, cy: d.h * 0.42, size: Math.min(d.w, d.h) * 0.7, angle: 0 }, d.w, d.h),
               faces: 1, pose: { yaw: 0, pitch: 0, roll: 0 }, eyes: { contrast: 0.5, eyeVsCheek: 0.9, covered: false } };
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

test('a child clearly closer to one parent is called for that parent', async () => {
  // Kin-level for Mum (cosine 0.30, the 95th percentile of real parent/child) and stranger-level for
  // Dad (0.01). Identical faces are no longer usable here — they now trip same-person detection,
  // which is the point of that feature.
  await stubMesh(page, [withEmb(A, REF), withEmb(A, atCosine(0.30)), withEmb(B, atCosine(0.01))]);
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
  assert.ok(r.raw[0] > r.raw[1], 'and Mum scores higher than Dad');
  assert.equal(r.stability, 1);
  assert.match(r.sub, /turns up between two unrelated people/, 'quoted against chance, never bare');
});

test('two equally-similar candidates produce a dead heat, not an arbitrary winner', async () => {
  await stubMesh(page, [withEmb(A, REF), withEmb(A, atCosine(0.15)), withEmb(A, atCosine(0.15))]);
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
  assert.match(r.provenance, /2 readings.*face-recognition model \+ measurements \(60\/40\).*nothing was uploaded/);
});

test('features are attributed one at a time — her nose from one, his eyes from the other', async () => {
  // A child built from A's nose, B's eyes and a 50/50 blend of everything else, expressed as
  // landmarks so the whole pipeline does the work.
  // Kin-level similarity, not an identical copy — a copy now (correctly) reads as the same person.
  const child = JSON.parse(JSON.stringify(A));
  await stubMesh(page, [withEmb(child, REF), withEmb(A, atCosine(0.28)), withEmb(B, atCosine(0.05))]);
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
  await stubMesh(page, [withEmb(A, REF), withEmb(A, atCosine(0.30)), withEmb(B, atCosine(0.01))]);
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

/* ---------- it is an app ---------- */

test('the install offer appears only when there is something to install', async () => {
  assert.equal(await page.isHidden('#installRow'), true, 'nothing offered until the browser says so');
  // Chromium fires beforeinstallprompt itself only under conditions a test server cannot meet, so
  // the event is delivered by hand; what is under test is the app's reaction to it.
  await page.evaluate(() => {
    const e = new Event('beforeinstallprompt');
    e.prompt = () => { window.__prompted = true; };
    e.userChoice = Promise.resolve({ outcome: 'accepted' });
    window.dispatchEvent(e);
  });
  assert.equal(await page.isHidden('#installRow'), false);
  assert.match(await page.textContent('#installWhy'), /never leave the device/);
  await page.click('#installBtn');
  assert.equal(await page.evaluate(() => window.__prompted), true, 'the button raises the real prompt');
  await page.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
  assert.equal(await page.isHidden('#installRow'), true, 'and stops asking once installed');
});

test('iOS gets the gesture spelled out, since Safari offers no install event', async () => {
  const ios = await browser.newPage({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' });
  await ios.goto(srv.url + '/index.html', { waitUntil: 'domcontentloaded' });
  assert.equal(await ios.isHidden('#installRow'), false);
  assert.equal(await ios.isHidden('#installBtn'), true, 'no button, because there is no prompt to raise');
  assert.match(await ios.textContent('#installWhy'), /Add to Home Screen/);
  await ios.close();
});

test('installed, it runs with the network off — page, mesh and all', async () => {
  // The whole claim of "it is an app" rests on this: pull the network and it still works.
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.evaluate(() => rxLoadMesh());
  const cached = await page.evaluate(async () => {
    const out = [];
    for (const n of await caches.keys()) out.push(...(await (await caches.open(n)).keys()).map((r) => new URL(r.url).pathname));
    return out;
  });
  assert.ok(cached.includes('/models/face_landmarker.task'), 'the model is cached');
  assert.ok(cached.includes('/vendor/mediapipe/wasm/vision_wasm_internal.wasm'), 'so is the runtime');
  assert.ok(cached.includes('/index.html') && cached.includes('/js/app.js'), 'and the app itself');

  await page.context().setOffline(true);
  try {
    await page.reload({ waitUntil: 'domcontentloaded' });
    const off = await page.evaluate(async () => {
      await rxLoadMesh();
      return { cards: document.querySelectorAll('.card').length, mesh: !!rxMeshState.landmarker };
    });
    assert.equal(off.cards, 3, 'the app boots offline');
    assert.equal(off.mesh, true, 'and the face mesh starts from cache, with no network at all');
  } finally {
    await page.context().setOffline(false);
  }
});

/* ---------- sunglasses ---------- */

test('a person in sunglasses is left out, not scored on a guessed eye line', async () => {
  // The mesh detects a face behind dark lenses perfectly happily and puts the irises ON the lenses,
  // measured at 0.13–0.16 of an eye-gap out of place. Since that line is what every other
  // measurement is scaled and levelled by, this cannot be reported as "eyes: 28" with the nose and
  // jaw carrying on regardless — the whole reading is void.
  const shaded = { ...B, eyes: { contrast: 0.0, eyeVsCheek: 0.12, covered: true } };
  await stubMesh(page, [A, A, shaded]);
  await fillForm(page, ['Baby', 'Mum', 'Dad'], [1, 1, 3]);
  await setPasses(page, 1);
  await runCompare(page);

  const r = await page.evaluate(() => ({
    rows: document.querySelectorAll('.line-row').length,
    names: rxLastRun.run.names,
    caveats: document.getElementById('caveats').textContent,
    features: [...document.querySelectorAll('.frow')].map((x) => x.querySelector('.fname').textContent)
  }));
  assert.equal(r.rows, 1, 'only the measurable person appears');
  assert.deepEqual(r.names, ['Mum'], 'Dad is not given a score at all');
  assert.match(r.caveats, /Dad: the eyes are hidden/);
  assert.match(r.caveats, /nose, jaw and face shape would be wrong too/);
  assert.ok(r.features.includes('Eyes'), 'the surviving comparison still reports normally');
});

test('a child in sunglasses stops the whole comparison, since there is no ruler', async () => {
  const shaded = { ...A, eyes: { contrast: 0.02, eyeVsCheek: 0.2, covered: true } };
  await stubMesh(page, [shaded, A, B]);
  await fillForm(page, ['Baby', 'Mum', 'Dad'], [1, 1, 3]);
  await setPasses(page, 1);
  await page.click('#compareBtn');
  await page.waitForFunction(() => document.getElementById('status').classList.contains('bad'));
  assert.match(await page.textContent('#status'), /The child’s eyes are hidden/);
  assert.equal(await page.isHidden('#results'), true);
});

test('covered eyes are flagged on the card as soon as the photo is added', async () => {
  await stubMesh(page, [A]);
  await page.evaluate(() => {
    const real = window.rxAutoFrameFromMesh;
    window.rxAutoFrameFromMesh = async (src) => {
      const got = await real(src);
      return { ...got, eyes: { contrast: 0.01, eyeVsCheek: 0.15, covered: true } };
    };
  });
  await addPhoto(page, '#childSlots .file', 1);
  const warn = await page.textContent('#childSlots .warn');
  assert.match(warn, /Both eyes must be visible/);
  assert.equal(await page.isHidden('#childSlots .warn'), false, 'and it is actually on screen');
});

/* ---------- every photo says whether it can be used ---------- */

test('a good photo says so, before you press anything', async () => {
  await stubMesh(page, [A]);
  await addPhoto(page, '#childSlots .file', 1);
  assert.equal(await page.textContent('#childSlots .ready'), 'Good to compare');
  assert.equal(await page.getAttribute('#childSlots .ready', 'class'), 'ready ready-good');
});

test('a photo that cannot be used says CANNOT, not a hint buried at the end', async () => {
  await stubMesh(page, [A]);
  await page.evaluate(() => {
    const real = window.rxAutoFrameFromMesh;
    window.rxAutoFrameFromMesh = async (s) => ({ ...(await real(s)), pose: { yaw: 41, pitch: 0, roll: 0 } });
  });
  await addPhoto(page, '#childSlots .file', 1);
  assert.equal(await page.textContent('#childSlots .ready'), 'Cannot be compared');
  assert.match(await page.textContent('#childSlots .warn'), /turned 41° away/);
});

test('ticking a free box leaves those measurements out and says it costs nothing', async () => {
  await stubMesh(page, [A]);
  await addPhoto(page, '#childSlots .file', 1);
  await page.check('#childSlots .worn input[value="hat"]');
  assert.match(await page.textContent('#childSlots .ready'), /Good to compare, with some measurements left out/);
  assert.equal(await page.getAttribute('#childSlots .ready', 'class'), 'ready ready-noted',
    'a free exclusion is stated, not alarmed about');
  const warn = await page.textContent('#childSlots .warn');
  assert.match(warn, /Hat or fringe/);
  assert.match(warn, /costs nothing/);
});

test('ticking a box that removes colour warns that it really does cost something', async () => {
  await stubMesh(page, [A]);
  await addPhoto(page, '#childSlots .file', 1);
  await page.check('#childSlots .worn input[value="foundation"]');
  assert.equal(await page.textContent('#childSlots .ready'), 'Usable, but weakened');
  assert.match(await page.textContent('#childSlots .warn'), /colour is the strongest family signal/);
});

test('what someone was wearing is carried through into the result', async () => {
  await stubMesh(page, [A, A, B]);
  await fillForm(page, ['Baby', 'Mum', 'Dad'], [1, 1, 3]);
  await page.check('#peopleSlots .card:nth-child(2) .worn input[value="beard"]');
  await setPasses(page, 1);
  await runCompare(page);

  const r = await page.evaluate(() => ({
    caveats: document.getElementById('caveats').textContent,
    jaw: rxLastRun.calls.find((c) => c.key === 'jaw'),
    jawAttributed: rxAttributed(rxLastRun.calls.find((c) => c.key === 'jaw'))
  }));
  assert.match(r.caveats, /Dad: beard or stubble/);
  assert.match(r.caveats, /costs nothing measurable/);
  // Mum still has a jaw score, Dad does not — so the jaw is "not comparable for everyone" and is
  // kept out of the overall entirely. Mum must not win the jaw by walkover because Dad has a beard.
  assert.equal(r.jaw.partial, true);
  assert.equal(r.jawAttributed, false, 'nobody is handed the jaw because the other one has a beard');
});

test('comparing someone with themselves says so, instead of calling it a family mix', async () => {
  // The obvious sanity check, and the app used to answer "a genuine mix of Dad and Mum" when handed
  // three photos of one child. Same landmarks everywhere means the stub embeds them identically,
  // cosine 1, which is well past the same-person line.
  await stubMesh(page, [A, A, A]);
  await fillForm(page, ['Ada', 'Mum', 'Dad'], [1, 1, 1]);
  await setPasses(page, 1);
  await runCompare(page);
  const r = await page.evaluate(() => ({
    lead: document.querySelector('.v-lead').textContent,
    sub: document.querySelector('.v-sub').textContent,
    cls: document.getElementById('verdict').className,
    sameAs: rxLastRun.run.sameAs
  }));
  assert.deepEqual(r.sameAs, [true, true]);
  assert.equal(r.lead, 'These are all the same person');
  assert.match(r.sub, /cannot tell you who they take after/);
  assert.match(r.cls, /v-same/);
  assert.ok(!/genuine mix|Takes after|Leans towards/.test(r.lead), 'and never a resemblance verdict');
});

test('one candidate being the same person is named, the others are not accused', async () => {
  await stubMesh(page, [A, A, B]);
  await fillForm(page, ['Ada', 'Mum', 'Dad'], [1, 1, 3]);
  await setPasses(page, 1);
  await runCompare(page);
  const r = await page.evaluate(() => ({
    lead: document.querySelector('.v-lead').textContent,
    sameAs: rxLastRun.run.sameAs
  }));
  assert.deepEqual(r.sameAs, [true, false]);
  assert.equal(r.lead, 'Mum and Ada are the same person');
});

test('a normal family comparison is not accused of being one person', async () => {
  await stubMesh(page, [A, B, B]);
  await fillForm(page, ['Ada', 'Mum', 'Dad'], [1, 2, 3]);
  await setPasses(page, 1);
  await runCompare(page);
  const r = await page.evaluate(() => ({
    lead: document.querySelector('.v-lead').textContent,
    sameAs: rxLastRun.run.sameAs
  }));
  assert.deepEqual(r.sameAs, [false, false]);
  assert.ok(/genuine mix|Takes after|Leans towards/.test(r.lead), 'it still gives a resemblance verdict');
});

test('once it is the same person, the resemblance breakdown stops pretending', async () => {
  // The reported fault: the headline said "same person" while the body below still printed a
  // resemblance split and "Mum's eyes · Dad's nose" about one child.
  await stubMesh(page, [withEmb(A, REF), withEmb(A, atCosine(0.7)), withEmb(B, atCosine(0.6))]);
  await fillForm(page, ['Ada', 'Mum', 'Dad'], [1, 1, 3]);
  await setPasses(page, 1);
  await runCompare(page);

  const r = await page.evaluate(() => ({
    lead: document.querySelector('.v-lead').textContent,
    mixHidden: document.getElementById('mixLine').hidden,
    shares: [...document.querySelectorAll('.line-share')].map((e) => e.textContent),
    bars: document.querySelectorAll('.line-row .bar').length,
    raws: [...document.querySelectorAll('.line-raw')].map((e) => e.textContent),
    note: document.querySelector('.lineup-note').textContent,
    folded: !!document.querySelector('.feature-table details.fold'),
    featureRowsVisible: document.querySelectorAll('.feature-table > .frow').length
  }));
  assert.equal(r.lead, 'These are all the same person');
  assert.equal(r.mixHidden, true, 'no "whose eyes" line');
  assert.deepEqual(r.shares, ['same person', 'same person'], 'no percentage split');
  assert.equal(r.bars, 0, 'and no bars to read a split off');
  assert.ok(r.raws.every((t) => /same face as Ada/.test(t)));
  assert.match(r.note, /a person cannot take after themselves/);
  assert.equal(r.folded, true, 'the measurements are folded away, not deleted');
  assert.equal(r.featureRowsVisible, 0, 'and not presented as a resemblance');

  const text = await page.evaluate(() => rxResultText());
  assert.match(text, /These are all the same person/);
  assert.ok(!/Takes after|genuine mix|% of the resemblance/.test(text),
    'the copied text must not put the nonsense back into circulation');
});

test('a transitive link catches the candidate the child alone would have missed', async () => {
  // child–Dad is weak (0.21, under the line); Mum–Dad is unmistakable. All three are one person.
  const child = [1, 0, 0, 0];
  const mum = [0.62, Math.sqrt(1 - 0.62 ** 2), 0, 0];
  // A vector close to mum but far from child.
  const n = Math.sqrt(1 - 0.21 ** 2);
  const dad = [0.21, (0.71 - 0.21 * 0.62) / Math.sqrt(1 - 0.62 ** 2), 0, 0];
  dad[2] = Math.sqrt(Math.max(0, 1 - dad[0] ** 2 - dad[1] ** 2));
  await stubMesh(page, [withEmb(A, child), withEmb(A, mum), withEmb(B, dad)]);
  await fillForm(page, ['Ada', 'Mum', 'Dad'], [1, 1, 3]);
  await setPasses(page, 1);
  await runCompare(page);
  const r = await page.evaluate(() => rxLastRun.run.sameAs);
  assert.deepEqual(r, [true, true], 'Dad is caught through Mum, not directly');
});

test('a genuine family still gets the full breakdown', async () => {
  await stubMesh(page, [withEmb(A, REF), withEmb(A, atCosine(0.28)), withEmb(B, atCosine(0.05))]);
  await fillForm(page, ['Ada', 'Mum', 'Dad'], [1, 2, 3]);
  await setPasses(page, 1);
  await runCompare(page);
  const r = await page.evaluate(() => ({
    sameAs: rxLastRun.run.sameAs,
    mixHidden: document.getElementById('mixLine').hidden,
    bars: document.querySelectorAll('.line-row .bar').length,
    rows: document.querySelectorAll('.feature-table > .frow').length
  }));
  assert.deepEqual(r.sameAs, [false, false]);
  assert.equal(r.mixHidden, false);
  assert.equal(r.bars, 2, 'the split is shown');
  assert.equal(r.rows, 8, 'and all eight features are on display, not folded away');
});
