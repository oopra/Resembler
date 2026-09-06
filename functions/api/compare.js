/* functions/api/compare.js — one blind comparison pass (Cloudflare Pages Function).

   NARROW BY DESIGN. This endpoint answers exactly one question: for each of ten named facial
   features, how similar is each of the supplied adult faces to the supplied child face, on a 0–100
   scale. It is not a chat endpoint and not a general image endpoint. The prompt forbids prose, the
   reply is parsed and validated feature by feature, and anything that does not come back as the
   agreed shape is rejected here rather than handed to the browser to interpret charitably.

   IT NEVER LEARNS WHO ANYONE IS. The browser sends faces as "the child" plus unlabelled A, B, C…
   Names, relationships and the order they were entered in stay on the device. That is not only a
   privacy nicety: a model told a photo is "Dad" answers a different question from a model shown an
   unlabelled face, and the difference flatters whoever was labelled. Blind is the accurate way to
   ask, so it is the only way this endpoint can be asked.

   ONE PASS ONLY. The browser calls this two or three times with the faces in a different order each
   time and combines the answers itself (js/resemble.js), so this stays stateless and nothing about
   a family is ever assembled server-side. Images are held for the length of the request and are
   neither stored nor logged.

   Provider: whichever key is configured —
     • ANTHROPIC_API_KEY → Claude   (default claude-opus-5;      override with COMPARE_MODEL)
     • MISTRAL_API_KEY   → Pixtral  (default pixtral-large-latest; override with COMPARE_MODEL)

   Request:  POST { child: "data:image/jpeg;base64,…", others: ["data:…", …] }   (1–6 others)
   Response: { features: { eyes: { A: 71, B: 44, note: "…" }, … }, issues: [ … ],
               provider, model, usage: { input, output, total } }                                  */

export const FEATURES = ['eyes', 'nose', 'shape', 'jaw', 'mouth', 'brows', 'cheeks', 'ears', 'hairline', 'colouring'];
const FEATURE_HINT = {
  eyes:      'eye shape, the tilt of the outer corner, spacing between the eyes, eyelid fold, iris colour',
  nose:      'bridge width and profile, tip shape, nostril shape, how the nose meets the lip',
  shape:     'overall outline of the head and the proportions between forehead, midface and lower face',
  jaw:       'jaw width and angle, chin shape, whether the chin is pointed, square, round or dimpled',
  mouth:     'lip fullness (upper vs lower), width of the mouth, the shape of the cupid\'s bow, corners',
  brows:     'brow thickness, arch shape, how far the brow sits above the eye, how far apart they start',
  cheeks:    'cheekbone height and prominence, fullness of the cheeks, the line from cheekbone to jaw',
  ears:      'ear size relative to the head, how far they sit out, lobe attached or free, helix shape',
  hairline:  'hairline shape (straight, widow\'s peak, receding at the temples), hair texture and colour',
  colouring: 'skin tone, eye colour, natural hair colour — judged allowing for the lighting in each photo'
};
const MAX_OTHERS = 6;
const MAX_B64 = 400_000;             // ~300 KB per face; a 448px JPEG is a fraction of this
const DATA_URL_RE = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/;

function buildPrompt(letters){
  const list = letters.join(', ');
  return [
    'You are comparing faces for a family-resemblance app. The first image is a CHILD. The images after it are adults, labelled ' + list + ' in the order they are given.',
    '',
    'Your ONLY job: for each of the ten features below, score how much EACH adult face resembles the child face, from 0 (nothing alike) to 100 (strikingly alike).',
    '',
    'Features and what each one means:',
    ...FEATURES.map(k => '- ' + k + ': ' + FEATURE_HINT[k]),
    '',
    'How to score:',
    '- The child is much younger than the adults. Compare STRUCTURE and PROPORTION — spacing, shape, angle, relative size. Ignore anything that is only about age: baby fat, skin texture, wrinkles, facial hair, absolute size.',
    '- Also ignore anything that is only about the photograph: lighting, camera angle, expression, focus, background, image quality.',
    '- Score each feature INDEPENDENTLY. It is normal and expected for a child to take one feature from one adult and another feature from another. Do not let a strong overall impression set every score.',
    '- No letter is privileged. The order the images arrive in carries no meaning at all, and you are not told how anyone is related to anyone.',
    '- Do not force the scores apart. If two adults really are equally similar on a feature, give them the same number.',
    '- If a feature genuinely cannot be seen in a photo (ears behind hair, forehead covered, face turned away), OMIT that letter for that feature instead of guessing, and say so in "issues".',
    '',
    '"note" is one short phrase (at most 110 characters) naming the concrete visual thing you saw — for example "same narrow bridge and slightly upturned tip". No speculation about who is related to whom, no names, no guesses about ethnicity or parentage.',
    '',
    'Respond with ONLY this JSON — no prose, no markdown, no code fence. The example shows the SHAPE only, with two adults; use one key per letter you were actually given:',
    '{"features":{"eyes":{"A":72,"B":45,"note":"…"},"nose":{"A":40,"B":81,"note":"…"},"shape":{"A":60,"B":58,"note":"…"},"jaw":{"A":55,"B":70,"note":"…"},"mouth":{"A":66,"B":52,"note":"…"},"brows":{"A":48,"B":63,"note":"…"},"cheeks":{"A":71,"B":49,"note":"…"},"ears":{"A":50,"B":50,"note":"…"},"hairline":{"A":62,"B":41,"note":"…"},"colouring":{"A":77,"B":39,"note":"…"}},"issues":["B: ears are covered by hair"]}'
  ].join('\n');
}

export function extractJSON(text){
  const s = String(text || '');
  const start = s.indexOf('{'), end = s.lastIndexOf('}');
  if(start < 0 || end <= start) return null;
  try{ return JSON.parse(s.slice(start, end + 1)); }catch(e){ return null; }
}

/* Whatever came back → exactly the shape the browser is allowed to see, or null. Every feature key
   must be present with at least one usable score; individual letters may be missing (that is the
   documented way to say "I could not see it") and are simply left out. Exported alongside onRequest
   so the validation can be tested directly — Pages only ever calls onRequest. */
export function normalise(raw, letters){
  if(!raw || typeof raw !== 'object') return null;
  const src = raw.features;
  if(!src || typeof src !== 'object') return null;
  const features = {};
  for(const key of FEATURES){
    const got = src[key];
    if(!got || typeof got !== 'object') return null;
    const out = {};
    let scored = 0;
    for(const L of letters){
      const v = got[L];
      if(typeof v !== 'number' || !isFinite(v)) continue;
      out[L] = Math.max(0, Math.min(100, Math.round(v)));
      scored++;
    }
    if(!scored) return null;
    const note = typeof got.note === 'string' ? got.note.trim().slice(0, 140) : '';
    if(note) out.note = note;
    features[key] = out;
  }
  const issues = Array.isArray(raw.issues)
    ? raw.issues.filter(x => typeof x === 'string').map(x => x.trim().slice(0, 140)).filter(Boolean).slice(0, 8)
    : [];
  return { features, issues };
}

export async function onRequest(context){
  const { request, env } = context;
  const H = { 'content-type': 'application/json', 'cache-control': 'no-store' };
  const json = (o, s) => new Response(JSON.stringify(o), { status: s || 200, headers: H });
  if(request.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  let body = {};
  try{ body = await request.json(); }catch(e){ return json({ error: 'bad request' }, 400); }

  const raw = [body.child].concat(Array.isArray(body.others) ? body.others : []);
  if(raw.length < 2) return json({ error: 'Send the child photo and at least one other face.' }, 400);
  if(raw.length > MAX_OTHERS + 1) return json({ error: `At most ${MAX_OTHERS} people can be compared at once.` }, 400);

  const images = [];
  for(const url of raw){
    const m = DATA_URL_RE.exec(String(url || ''));
    if(!m) return json({ error: 'Each face must be a JPEG, PNG or WebP base64 data URL.' }, 400);
    if(m[2].length > MAX_B64) return json({ error: 'A face image is too large — the app should render it to about 448px first.' }, 413);
    images.push({ mediaType: m[1], data: m[2] });
  }

  const letters = images.slice(1).map((_, i) => String.fromCharCode(65 + i));
  const prompt = buildPrompt(letters);
  const anthKey = env.ANTHROPIC_API_KEY, mistralKey = env.MISTRAL_API_KEY;

  try{
    let text = '', provider = '', model = '', usage = { input: 0, output: 0, total: 0 };

    if(anthKey){
      provider = 'Claude'; model = env.COMPARE_MODEL || 'claude-opus-5';
      const content = images.map(im => ({ type: 'image', source: { type: 'base64', media_type: im.mediaType, data: im.data } }));
      content.push({ type: 'text', text: prompt });
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': anthKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: 1400, temperature: 0, messages: [{ role: 'user', content }] })
      });
      const d = await r.json();
      if(!r.ok) return json({ error: (d.error && d.error.message) || 'Claude API error' }, r.status);
      text = (d.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
      const u = d.usage || {};
      usage = { input: u.input_tokens || 0, output: u.output_tokens || 0, total: (u.input_tokens || 0) + (u.output_tokens || 0) };

    } else if(mistralKey){
      provider = 'Mistral'; model = env.COMPARE_MODEL || 'pixtral-large-latest';
      const content = [{ type: 'text', text: prompt }].concat(
        images.map(im => ({ type: 'image_url', image_url: `data:${im.mediaType};base64,${im.data}` })));
      const r = await fetch('https://api.mistral.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'authorization': `Bearer ${mistralKey}` },
        body: JSON.stringify({ model, max_tokens: 1400, temperature: 0, response_format: { type: 'json_object' },
          messages: [{ role: 'user', content }] })
      });
      const d = await r.json();
      if(!r.ok) return json({ error: (d.error && (d.error.message || d.error)) || d.message || 'Mistral API error' }, r.status);
      text = String((((d.choices || [])[0] || {}).message || {}).content || '');
      const u = d.usage || {};
      usage = { input: u.prompt_tokens || 0, output: u.completion_tokens || 0, total: u.total_tokens || ((u.prompt_tokens || 0) + (u.completion_tokens || 0)) };

    } else {
      return json({ error: 'Comparing isn’t set up on this deployment — no vision-capable API key is configured on the server.' }, 503);
    }

    const clean = normalise(extractJSON(text), letters);
    if(!clean) return json({ error: 'The comparison came back in a shape this app can’t read. Try again — and if it keeps happening, try clearer, closer photos.' }, 502);
    return json({ features: clean.features, issues: clean.issues, provider, model, usage });

  }catch(e){
    return json({ error: 'The comparison service could not be reached.' }, 502);
  }
}
