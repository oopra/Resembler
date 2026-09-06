# Resembler

**Whose eyes? Whose nose? Whose stubborn chin?** Put a photo of a child next to photos of the family
and get an answer feature by feature — not one hand-wavy "she's the image of her father", but ten
named traits, each scored against each person, with the ones that are genuinely too close to call
saying so.

A static page plus one small server endpoint. No build step, no framework, no bundler.

---

## The honest bit, first

This compares **what two faces look like in two photographs**. That is all it is, and the app says so
on the page as well as here.

- It is **not a paternity test, not a DNA test, and not face recognition.** It cannot tell you who is
  related to whom, and no result from it is evidence of anything.
- A different pair of photos of the same two people will often give a different answer. Lighting,
  angle, expression and age all move the needle.
- Children change enormously as they grow. The toddler who is "all Dad" is frequently a teenager who
  is all Mum.

The design decisions below exist because the easy version of this app — ask once, print a percentage —
is confidently wrong a lot of the time, and reads as far more authoritative than it has any right to.

---

## How it works

### 1. On the device: find the head, hold it still, even out the light

`js/faces.js` is the entire image pipeline, and it does four things:

| Step | Why |
| --- | --- |
| **Decode upright** | Phones store rotation in EXIF, not in the pixels. Without `imageOrientation: 'from-image'`, portrait shots arrive sideways. |
| **Frame the head** | A square crop, forehead to chin. The rest of the photo is a distraction: a comparison should not be swayed by one person being photographed in a garden and the other in a kitchen. Auto-framed where the browser has a face detector, hand-adjustable always — drag, pinch, tilt. |
| **Level and normalise** | Rotate so the eyes sit level (a tilted head reads as a different face shape), then stretch the exposure so both faces land in the same brightness range. Lighting is the single biggest false signal in photo comparison. The same linear map is applied to R, G and B, so exposure moves and **hue does not** — eye and hair colour are real resemblance and are kept. |
| **Check it is worth sending** | Too few pixels across the head, or too soft to see an eyelid fold, and the answer would be confident noise. The photo gets a warning before it is ever compared. |

What the pipeline deliberately does **not** do: no beautifying, no smoothing, no skin retouching, no
background removal, no face embeddings, no recognition, no matching against any database. "Find the
head, hold it still, even out the light" is the whole of it.

### 2. Asking, blind, more than once

`js/resemble.js` handles the part that is easy to get quietly wrong. Three known ways a
one-shot answer drifts, and what is done about each:

- **Name bias.** Told a photo is "Dad", a reader reaches for what it expects a child to share with a
  father. So **names never leave the device.** Photos go up as `A`, `B`, `C` and come back as
  `A`, `B`, `C`; the names are re-attached afterwards, here.
- **Position bias.** Whoever is shown first scores a little higher. So each pass sends the photos in a
  different order — a shuffled base **rotated one step per pass**, which guarantees a given person
  sits in a different slot every time rather than merely hoping a reshuffle moves them. Over *n*
  passes nobody occupies the same slot twice.
- **Halo.** One "she's the image of him" impression bleeds across every feature. So each of the ten
  features is scored on its own, and features that disagree are reported as disagreeing.

### 3. Combining, and refusing to overclaim

Scores are averaged across passes, and **the spread between passes is kept**. A feature that swung 30
points between passes has not been measured, it has been guessed, and it is shown as
*"the passes disagreed"* rather than being smoothed into a winner.

- A feature is only attributed to someone if they lead it by **8 points or more**; otherwise it is
  *shared*.
- The headline only says *"Takes after X"* on a **10-point** lead that every pass agreed on. A
  4-point lead is *"Leans towards X"*. Below that it is *"A genuine mix"* — because it is.
- Two numbers are reported per person, because they answer different questions. **Likeness** (0–100)
  is *how alike are they at all*; **share** (summing to 100%) is *which of you*. Two people can be 80
  and 78 alike (a strong family face, no winner) or 30 and 28 (nobody especially), and the share alone
  cannot tell those apart.

The ten features, weighted towards bone structure — which is what survives the age gap between a
toddler and an adult — and away from colouring, which is the first thing a camera gets wrong:

`eyes` · `nose` · `face shape` · `jaw & chin` · `mouth & lips` · `eyebrows` · `cheeks` · `ears` ·
`hairline & hair` · `colouring`

### 4. The endpoint

`functions/api/compare.js` is a Cloudflare Pages Function that answers exactly one question and
validates the answer feature by feature before returning it. It is not a chat endpoint and not a
general image endpoint: prose, missing features and unscored letters are rejected there rather than
handed to the browser to interpret charitably.

It never learns who anyone is. It is called once per pass, is stateless, and holds the images only
for the length of the request — nothing about a family is ever assembled server-side.

---

## Running it

```bash
npm install
npx playwright install chromium     # for the browser tests
npm test                            # scoring, image pipeline, API validation, and the full UI flow
npm run lint
```

The page itself is static — any file server will do:

```bash
npx serve .        # then open http://localhost:3000
```

…but `/api/compare` needs a server, so use `npx wrangler pages dev .` for the whole thing locally.

## Deploying

Built for **Cloudflare Pages**: point it at the repo, no build command, output directory `/`. The
`functions/` directory is picked up automatically.

Set one API key as an environment variable — whichever you have:

| Variable | Reader used |
| --- | --- |
| `ANTHROPIC_API_KEY` | Claude (default `claude-opus-5`) |
| `MISTRAL_API_KEY` | Pixtral (default `pixtral-large-latest`) |
| `COMPARE_MODEL` | *optional* — override the model for either |

With no key set, the app loads and frames photos as normal and says plainly that comparing is not
configured, rather than failing mysteriously.

## Layout

```
index.html                 the page
css/styles.css             one stylesheet, no framework, no web fonts
js/faces.js                decode · frame · level · normalise · quality-check
js/resemble.js             blinding · pass planning · scoring · the verdict   (pure, no DOM)
js/app.js                  cards, dragging, the compare run, the results
functions/api/compare.js   one blind comparison pass, validated
tests/logic.test.mjs       the scoring and the image maths, in plain Node
tests/api.test.mjs         what the endpoint refuses to pass on
tests/ui.test.mjs          the whole flow in a real browser, API stubbed
```

`js/*.js` are plain browser scripts sharing one global scope, loaded in order — no modules, no
bundler. They expose their functions through a `module.exports` guard purely so the tests exercise the
real shipped code rather than a copy of it.

Two tests are worth knowing about, because they are the ones that would catch this app quietly
becoming dishonest:

- *"a reader that always flatters the first photo produces a dead heat, not a false winner"* — stubs
  an API that unconditionally scores slot A at 88 and slot B at 32, and asserts the result comes out
  exactly 60–60. That is the order rotation doing its job.
- *"names never leave the device"* — inspects every outgoing request body and fails if a name appears
  in it.
