# Resembler

**Whose eyes? Whose nose? Whose stubborn chin?** Put a photo of a child next to photos of the family
and get an answer feature by feature — not one hand-wavy "she's the image of her father", but eight
named features, each scored against each person, with the ones that are genuinely too close to call
saying so.

**It runs entirely on your device.** No account, no API key, no server, no upload. A face-mesh model
is served alongside the page, runs in the browser, and the app works with the network switched off
after the first visit. These are photographs of somebody's children; the right number of copies to
make of them is zero.

A static site. No build step, no framework, no bundler.

---

## The honest bit, first

This measures **what two faces look like in two photographs**. That is all it is, and the app says so
on the page as well as here.

- It is **not a paternity test, not a DNA test, and not face recognition.** It cannot tell you who is
  related to whom, and no result from it is evidence of anything.
- A different pair of photos of the same two people will often give a different answer. Lighting,
  angle, expression and age all move the needle.
- Children change enormously as they grow. The toddler who is "all Dad" is frequently a teenager who
  is all Mum.

Most of the design decisions below exist because the easy version of this app — measure once, print a
percentage — reads as far more authoritative than it has any right to.

---

## How it works

### 1. Prepare the photo — and nothing more

`js/faces.js` is the entire image pipeline, and it does four things:

| Step | Why |
| --- | --- |
| **Decode upright** | Phones store rotation in EXIF, not in the pixels. Without `imageOrientation: 'from-image'`, portrait shots arrive sideways. |
| **Frame the head** | A square crop, forehead to chin. The rest of the photo is a distraction: a comparison should not be swayed by one person being photographed in a garden and the other in a kitchen. The mesh proposes the frame; you can always drag, pinch and tilt it, because a wrong crop quietly poisons everything downstream. |
| **Level and normalise** | Rotate so the eyes sit level, then stretch the exposure so both faces land in the same brightness range. Lighting is the biggest false signal in photo comparison. The same linear map goes on R, G and B, so exposure moves and **hue does not** — eye and hair colour are real resemblance and are kept. |
| **Check it is worth measuring** | Too few pixels across the head, or too soft to see an eyelid fold, and the answer would be confident noise. The photo gets a warning before it is compared. |

No beautifying, no smoothing, no background removal, no recognition, no matching against any
database. "Find the head, hold it still, even out the light" is the whole of it.

### 2. Measure it

`js/mesh.js` runs MediaPipe's face landmarker over the crop: 478 points, both irises, a head-pose
matrix and blendshapes. `js/measure.js` turns those into about thirty-five measurements.

Every measurement is taken after the face is put in a standard pose — rotated so the line between the
irises is horizontal, scaled so that line is exactly 1 unit, centred between the eyes. So
`alar_width: 0.62` means *the nose is 0.62 as wide as the gap between the pupils*: a number you can
compare across two people, two cameras and twenty years.

Examples of what gets measured: the gap between the eyes, the tilt of the outer corner, the width of
the nose against its length, the balance of upper lip to lower, philtrum length, cheekbone height,
jaw width against face width, the gonial angle, the three facial thirds. Colouring is sampled off the
same pixels that were measured — skin from both cheeks and the forehead, eye colour from the iris
ring — by *median*, so a highlight on a cheekbone or a catchlight in the eye cannot drag the answer.
Colours are compared in CIE Lab, where a difference of a few units is roughly what an eye can see.

Similarity for each measurement is `100 × exp(−|difference| ÷ tolerance)`: identical is 100, one
tolerance away is 37, two is 14. A smooth curve, so no single measurement flips a verdict by moving a
hair.

> **On the tolerances.** They are a stated convention, not a population statistic — nobody here has a
> database of family noses. So the 0–100 figure is the ruler that lets people be ranked against each
> other, and should not be read as "72% of noses". *The comparison between candidates is the real
> output; the absolute number is the scale it is drawn on.*

### 3. Refuse to overclaim

`js/resemble.js` rolls measurements into features and features into a verdict, and most of it is
about the cases where an answer should not be given:

- **A feature needs an 8-point lead** to be attributed to anyone. Otherwise it is *shared*.
- **The headline needs a 10-point lead and unanimity** to say "Takes after". At 4 points it is
  "Leans towards". Below that it is "A genuine mix", because it is.
- **Expressions are excluded, not tolerated.** A grin genuinely widens a mouth, so measurements that
  an expression moves are dropped when either photo is pulling that face — and the result tells you
  which ones and why. If that leaves less than half of a feature, the feature is not scored at all: a
  mouth judged on philtrum length alone is not a mouth.
- **Like for like.** A feature is only counted in the overall if *everyone* has it. If a grin made the
  child's mouth uncomparable against one parent, the other parent cannot quietly bank the mouth.
- **A turned head is flagged, not measured.** Turning a face foreshortens one side of everything,
  which looks exactly like a genuinely narrower jaw.
- **Two numbers per person, because they answer different questions.** *Likeness* (0–100) is how alike
  they are at all; *share* (summing to 100) is which of you. Two people can be 80 and 78 alike (a
  strong family face, no winner) or 30 and 28 (nobody especially), and share alone cannot tell those
  apart.
- **Readings are repeated over jittered crops.** Landmark detection is not pixel-perfect, so the same
  faces are measured two or three times from slightly different crops and the *spread* is kept. Where
  that noise is bigger than the difference between people, the feature is reported as unsteady rather
  than being handed to whoever came out ahead.

The eight features — weighted towards bone structure, which is what survives twenty years of growing:

`eyes` · `nose` · `face shape` · `jaw & chin` · `mouth & lips` · `cheeks & midface` · `eyebrows` ·
`colouring`

**Ears and hairline are deliberately absent.** A face mesh stops at the face, so they cannot be
measured, and guessing at them would be the dishonest half of the answer.

---

## What is vendored, and how big it is

| Path | What | Size |
| --- | --- | --- |
| `vendor/mediapipe/vision_bundle.mjs` | MediaPipe Tasks Vision 1.0.1 (Apache-2.0) | 152 KB |
| `vendor/mediapipe/wasm/` | its WebAssembly runtime, SIMD build only | ~12 MB |
| `models/face_landmarker.task` | the face landmarker model, float16 (Apache-2.0) | 3.6 MB |

That is a real download, once. The app is honest about it: the first comparison shows a progress bar
with the size on it rather than a spinner, and the service worker caches those two files
`cache-first` and never revalidates them, so it never happens twice.

Only the SIMD WebAssembly build is shipped, which needs Chrome 91+, Firefox 89+ or Safari 16.4+.

---

## It is already an app

There is no separate "app version" to build. The page ships a web app manifest, three icons and a
service worker that caches the whole thing — code, runtime and model — so it installs to the home
screen or dock and runs with the network off:

| Platform | How |
| --- | --- |
| Android | Chrome / Edge / Samsung Internet offer **Install as an app** — the page shows a button when they do |
| iOS / iPadOS | Safari → Share → **Add to Home Screen** (Safari fires no install event, so the page just says this) |
| Windows / macOS / Linux | Chrome or Edge → the install icon in the address bar, or the page's own button |

Installed, it opens in its own window with no browser chrome, keeps working with no signal, and still
never sends a photograph anywhere. There is a test for exactly this: it warms the cache, sets the
browser offline, reloads, and asserts that both the app and the face mesh start with no network.

What it is *not* is a store listing. See **Native builds** below.

## Native builds

Getting into the App Store and Play Store means wrapping this same web app in
[Capacitor](https://capacitorjs.com) — the web code is unchanged, and the 16 MB of runtime and model
ship inside the package, so there is no first-run download at all. That needs Xcode on a Mac for iOS
and Android Studio for Android, plus the respective developer accounts, and it is not set up in this
repo. Nothing about the app blocks it.

## Running it

```bash
npm install
npx playwright install chromium     # for the browser tests
npm test                            # geometry, scoring, and the whole flow in a real browser
npm run lint
npx serve .                         # any static file server will do
```

There is nothing else to configure. There are no environment variables, because there is nothing to
authenticate to.

## Deploying

Any static host — there is no build step, so the repo *is* the site.

**GitHub Pages.** Settings → Pages → Deploy from a branch → `main`, folder `/ (root)`. The
`.nojekyll` file at the root matters: without it Pages pipes everything through Jekyll on the way
out, which has its own ideas about directories called `vendor/` — and `vendor/` is where the entire
face-mesh runtime lives. (`.github/workflows/pages.yml` is there for the "GitHub Actions" source
option instead; either route works.)

**Cloudflare Pages.** Point it at the repo, no build command, output directory `/`. This is the only
host where `_headers` takes effect, giving a Content-Security-Policy with no `connect-src` beyond
`self` — there is nowhere for a photo to go, and the browser enforces it.

Whichever you pick, it must be served over HTTPS (or localhost). Service workers are refused on plain
HTTP, and without one there is no offline mode and no install.

## Layout

```
index.html                 the page
css/styles.css             one stylesheet, no framework, no web fonts
js/faces.js                decode · frame · level · normalise · quality-check
js/measure.js              478 landmarks → ~35 measurements → a score per feature   (pure)
js/mesh.js                 loads and runs the face mesh; samples skin and eye colour
js/resemble.js             measurements → features → a verdict                      (pure)
js/app.js                  cards, dragging, the run, the results
sw.js                      caches the mesh so 16 MB is downloaded once
tests/fixtures/*.json      478 landmarks from two public-domain photographs — numbers only
```

`js/*.js` are plain browser scripts sharing one global scope, loaded in order. They expose their
functions through a `module.exports` guard purely so the tests exercise the real shipped code rather
than a copy of it.

## The tests worth knowing about

Ground truth is constructed rather than assumed: a child's measurements are interpolated between two
real faces, so the right answer is known in advance.

- *"a child identical to one parent is called for that parent"* — scores 100, says "Takes after".
- *"a child exactly half way between two parents is called a mix"* — 50/50, and no winner is named.
- *"a feature whose measurements were mostly knocked out is not won on the remainder"*.
- *"a feature only one person could be measured on is not silently won by them"*.
- *"no network request is made while comparing"* — fails if anything at all is fetched off-origin.
- *"the vendored face mesh actually loads and starts from these files alone"* — no stub; loads the
  real 16 MB and creates a landmarker, which is the only way to catch a vendored asset going missing
  or being served with the wrong MIME type.
- *"no two shipped scripts define the same global"* — with no bundler, a name defined twice is not an
  error anywhere; the last file loaded just silently wins. This is in the suite because it happened:
  `app.js`'s `rxCompare` button handler ate `measure.js`'s `rxCompare(child, adult)`, and every
  comparison quietly returned nothing.

The landmark fixtures were checked against the photographs they came from before being trusted —
outer eye corner outside the inner one, brow above the lid, subnasale below the nose tip, chin the
lowest point — because a wrong landmark index produces a plausible-looking number, not an error.
