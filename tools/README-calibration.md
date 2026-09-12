# Where the numbers come from

Every weight and threshold in this app used to be my judgement. This document is what happened when
they were checked against real families, and what changed as a result. The short version: **the
judgement was worthless — it correlated with reality at 0.09 — and it was backwards on its central
claim.**

## The dataset

[KinFaceW-II](http://www.kinfacew.com/) — 1000 parent/child pairs in four relations (father–son,
father–daughter, mother–son, mother–daughter), 64×64 aligned face crops.

> Jiwen Lu, Xiuzhuang Zhou, Yap-Peng Tan, Yuanyuan Shang, Jie Zhou. *Neighborhood Repulsed Metric
> Learning for Kinship Verification.* IEEE TPAMI, vol. 36, no. 2, pp. 331–345, 2014.

Nothing from it is redistributed here — no images, no derived landmarks. It is downloaded, measured
locally, and the only thing that reaches this repository is a handful of weights.

849 of the 1000 pairs survived: both faces had to be detectable and measurable by the app's own
pipeline (`rxRenderFace` → `rxDetect` → `rxMeasure` → `rxSampleColours`), which is a ~92% hit rate on
64×64 crops. Note those crops are far below this app's own quality floor of 170px across the head, so
absolute scores here are pessimistic. As a *relative* test — kin against non-kin at identical
resolution — it is sound.

## What was measured

For each measurement, the similarity score of 849 true pairs against 849 randomly re-paired strangers,
summarised as AUC: the probability that a true pair outscores a stranger pair. 0.50 is a coin toss.

### 1. The guessed weights were noise

Correlation between the weights I had chosen and the measured signal: **0.093**.

The reasoning behind the original weights was that bone structure survives childhood while colouring
is the first thing a camera gets wrong, so colouring was weighted last of eight features at 0.60.
Measured, the six colour measurements are the top six signals in the entire set, and the
carefully-argued bone-structure ratios are the weakest:

| measurement | AUC | old weight |
| --- | --- | --- |
| `skin_b` (skin tone) | 0.770 | 1.00 |
| `eye_a` (eye colour) | 0.716 | 1.10 |
| `eye_b` (eye colour) | 0.689 | 1.10 |
| `skin_a` (skin warmth) | 0.686 | 1.00 |
| … | | |
| `face_wh` (face width vs height) | 0.531 | **1.30** |
| `nose_len` (nose length) | 0.521 | 1.10 |

### 2. Half the colour signal was shared lighting

KinFaceW crops parent and child out of **one photograph**, so a shared colour cast can masquerade as
shared genes. Testing this by white-balancing each face independently (grey-world) before reading
colour:

| measurement | as-shipped | white-balanced | change |
| --- | --- | --- | --- |
| `skin_b` | 0.779 | 0.627 | −0.152 |
| `eye_a` | 0.718 | 0.639 | −0.079 |
| `eye_b` | 0.711 | 0.630 | −0.081 |
| `skin_a` | 0.692 | 0.606 | −0.087 |

So the confound was real and large. **But the surviving colour signal (0.61–0.64) still beats every
geometric measurement in the app** (best geometry: `mouth_w` at 0.591). Colour is genuinely the
strongest family signal here; it was simply being over-credited.

Faces are therefore now white-balanced individually in `rxRenderFace` before any colour is read. This
costs 0.007 AUC *on this benchmark* — because the benchmark contains the confound the correction
removes — and is the right thing to do for photographs taken on different days, which is the actual
use case.

### 3. The sex-bias hypothesis was wrong

The first suspicion was that a young girl's face is structurally closer to any adult woman's, so a
father would systematically lose. Tested, and it is not true:

- unrelated daughters vs unrelated **women**: 51.7
- unrelated daughters vs unrelated **men**: 51.1

A 0.6-point pull, which is nothing. A real father beats an unrelated woman 63% of the time and an
unrelated man 65% of the time — near-identical. The hypothesis was plausible, testable, and false.

### 4. The thresholds were reading noise

The real fault. A null distribution was built from 4000 simulated three-photo comparisons — one
child, two **unrelated** adults — recording the winning margin produced by chance alone:

| chance gap below | |
| --- | --- |
| 6.0 points | 50% of comparisons |
| 10.4 points | 75% |
| 15.6 points | 90% |
| 18.7 points | 95% |
| 25.2 points | 99% |

Against that, the original thresholds:

| threshold | was | chance alone produces it |
| --- | --- | --- |
| "leans towards" | 4 points | **65% of the time** |
| "takes after" | 10 points | **27% of the time** |

The app was announcing winners it had not found. The reported case — a father told his daughter
resembled her mother, on a 14-point gap — is a margin chance produces **13%** of the time.

Thresholds are now taken from that null: **11 points** to say "leans" (beats 75% of chance gaps) and
**19 points** to say "takes after" (beats 95%). Every verdict is also quoted with how often chance
produces the same gap, so the number is never presented bare.

## Result

Measured on the same 849 pairs, using the shipped code:

| | AUC |
| --- | --- |
| original weights | 0.706 |
| learned weights + per-face white balance | **0.734** |

Weights were learned on a 50/50 split and evaluated on the held-out half (0.699 → 0.751 there), so
the gain is not the model grading its own homework.

## What this still cannot do

**It cannot reliably tell you which of two parents a child takes after.** True pairs score 51.7 and
strangers 44.7 — a 7-point separation against ~8 points of spread. Telling *kin from stranger* is a
weak but real signal. Telling *one parent from the other*, when both are kin, is a much finer
distinction, and the honest answer is that this method mostly cannot make it. That is why the app now
says "too close to call" far more often, and says how often chance would beat the margin it found.

There is also no ground truth for "looks more like Dad" — kinship verification is well defined and
resemblance-ranking between two real parents is not. No dataset can settle it, because the label is
somebody's opinion.

## What it costs to work around a hat, a beard or make-up

You cannot remove a cap from a photograph. Anything claiming to is a model inventing a forehead, and
this app has already been burned once by measuring something a model invented. What it does instead
is leave out the measurements the thing corrupts — and whether that is affordable was measured rather
than assumed.

Method: drop each group, re-score against an **identical** set of stranger pairs (an earlier run that
re-drew the stranger pairing per condition produced differences that were pure sampling noise), and
put a paired bootstrap confidence interval on the change.

| left out | AUC | change | 95% CI | real? |
| --- | --- | --- | --- | --- |
| nothing (baseline) | 0.745 | | | |
| hat / fringe → forehead measurements | 0.747 | +0.001 | [−0.001, +0.004] | no |
| beard → jawline measurements | 0.751 | +0.006 | [+0.002, +0.010] | yes, a slight *gain* |
| lipstick → lip measurements | 0.739 | −0.006 | [−0.011, +0.000] | no |
| glasses / eye make-up → eye outline | 0.744 | −0.002 | [−0.006, +0.002] | no |
| foundation → skin colour | 0.719 | −0.027 | | yes |
| coloured lenses → eye colour | 0.701 | −0.044 | | yes |
| all colour | 0.643 | −0.102 | [−0.120, −0.086] | yes |

**Everything except colour is free to leave out.** That is why these are tick boxes rather than
detectors: a detector can false-positive on a naturally red lip or a dark brow, while a tick box that
costs nothing cannot hurt you. Only the two colour boxes carry a real price, and the app says so on
the card when you tick one.

Sunglasses remain the exception that is detected automatically and refused outright, because they
break the iris line that every other measurement is scaled by — that is not a group to route around,
it is the ruler.

## Adding a face-recognition network

The measurements are thirty-five things a person can point at. A recognition network is hundreds of
thousands of faces' worth of learned structure. Benchmarked the same way, on the same pairs:

| | held-out AUC |
| --- | --- |
| measurements only | 0.734 |
| ArcFace embeddings (buffalo_s / w600k_mbf) | 0.845 |
| **blend, 60% embedding / 40% measurements** | **0.868** |

The blend beats either alone, and the blend weight was tuned on a training half and confirmed on the
held-out half rather than chosen. The two are not seeing the same thing: recognition models are
trained to be robust to lighting, so they largely discard colour — which is the measurements' single
strongest signal.

On the test that started all of this — a daughter, her real father, and an unrelated woman:

| | picks the real father |
| --- | --- |
| measurements only | 67.8% |
| ArcFace | 77.4% |
| blend | 80.8% |

### Verified on the shipped code, not just the experiment

Re-running the whole thing through the actual `js/*.js` the app serves, on 836 pairs it could read
end to end: **AUC 0.720 → 0.851**, and the father test **69.3% → 75.5%**. Lower than the figures
above because it is a different pair set with a different random stranger pairing; these are the
numbers that ship.

That run also found two real bugs the experiment could not:

1. **ONNX Runtime resolves `wasmPaths` against its own module URL**, not the document, so
   `./vendor/onnxruntime/` became `/vendor/onnxruntime/vendor/onnxruntime/` and nothing loaded. Three
   different bases are in play in `embed.js` — `fetch` uses the document, `import()` uses the script,
   ORT uses its own — and the comment there now says so.
2. **The sunglasses check was too eager.** Requiring *either* signal to fail rejected about 40% of
   ordinary photographs at low resolution: a blurred eye loses its sclera edge but stays as bright as
   the cheek. Requiring *both* still catches every real lens (they fail both at once, 0.00 and 0.10)
   and stopped punishing grainy snapshots. Detection went from ~60% back to ~92%.

### Two rulers

The blend and the measurements-alone score have different noise, so each carries its own null and its
own thresholds — using one's thresholds on the other would be the original mistake in a new coat.

| | "leans" | "takes after" | chance gap p50 / p95 |
| --- | --- | --- | --- |
| blend | 16 | 27 | 9.3 / 27.0 |
| measurements only | 11 | 19 | 6.0 / 18.7 |

The app selects the scale by whether the recognition model actually loaded, and says which it used in
the line under the result.

### Telling the same person from a relative

The obvious sanity check — compare someone with themselves — was answered with "a genuine mix of Dad
and Mum" and two ordinary likeness scores. The 0-100 scale tops out in *family* territory
(cosine 0.31), so anything closer clamped to 100. The model underneath is a **recognition** model:
distinguishing one person from another is precisely what it is built for, and that answer was being
discarded.

Measured through this exact pipeline, on the standard LFW verification pairs plus the KinFaceW pairs:

| | n | median cosine | 95th percentile |
| --- | --- | --- | --- |
| same person | 593 | **0.600** | |
| parent and child | 836 | 0.125 | 0.298 |
| two strangers | 587 | 0.009 | 0.116 |

Three separated populations. Choosing the line:

| threshold | catches same-person | flags strangers | flags real parent/child |
| --- | --- | --- | --- |
| ≥ 0.35 | 97.1% | 0.0% | 1.6% |
| **≥ 0.40** | **92.9%** | **0.0%** | **0.5%** |
| ≥ 0.50 | 78.9% | 0.0% | 0.1% |

**Identity is transitive, and using that is worth about one catch in fourteen.** At 0.40, 7.1% of
genuine same-person pairs still fall below the line — the hard ones: a big age gap, a profile, bad
light, a toddler looking down. Comparing only each candidate against the child tests *n* pairs and
misses those; comparing every pair and joining the links tests *n(n+1)/2*, so a weak edge is rescued
by any strong edge elsewhere. Three photographs of one person are recognised as one person even when
one of the three pairings is poor. This is the alternative to lowering the threshold, which would
start accusing real parents and children instead.

**And the rest of the page has to agree.** The first version of this replaced the headline and left
the body printing a resemblance split and "Mum's eyes · Dad's nose" about a single child. Once
identity is established the percentage split is dropped, the whose-eyes line is hidden, the feature
table is folded away behind a label saying it now describes the difference between two photographs
rather than a family resemblance, and the copy-as-text output says the same thing the screen does.

0.40 is the shipped line. The 0-100 scale was deliberately *not* stretched to reach 0.6: that would
squash the entire family range into its bottom third, and telling families apart is the app's actual
job. Same-person is announced separately, above the verdict, and the resemblance verdict is
suppressed — "takes after Mum" is meaningless if Mum is the child.

### What it does not fix

The recognition model produces one number. It cannot say whose eyes a child has — that remains the
measurements' job, which is the other reason both are kept, and the feature breakdown now carries a
note saying it can disagree with the headline.

And a caveat that cannot be tested from here: recognition models are known to vary in accuracy across
demographic groups, and KinFaceW-II is one dataset of limited diversity. This is better on average.
It is not guaranteed better for any particular family, and the app has no way to tell you which you
are.

## How humans do it, and which parts of that are worth copying

Three claims from face-perception research, each tested here rather than taken on trust.

### 1. Holistic, not feature-by-feature — confirmed, and it was the whole early mistake

People do not read faces part by part. The face inversion effect (faces are far harder to recognise
upside down than other objects), the composite effect (the top half of one face and the bottom of
another fuse into a new identity), and part-whole effects all point the same way: a face is processed
as a configuration. This app began as thirty-five separate measurements, which is the opposite, and
that is the best explanation for why a recognition network — trained end to end on whole faces —
beat it by 0.11 AUC without being designed for kinship at all.

### 2. Norm-based coding: a rare shared trait is worth more — confirmed and implemented

A face is encoded as its departure from an average, so a match counts for as much as it is unusual.
Two people with ordinary noses both having an ordinary nose is not evidence; most people have one.

Tested on 836 pairs against an identical stranger pairing, weighting each measurement by how far the
shared value sits from the population norm (the milder of the two departures, conservatively):

| rarity multiplier | AUC |
| --- | --- |
| 0 (flat, as it was) | 0.7258 |
| 1 | 0.7361 |
| **2 (shipped)** | **0.7388** |
| 4 | 0.7397 |

**+0.013, 95% CI [0.007, 0.016]** on a paired bootstrap — small, real, and in the predicted
direction. Shipped at 2, which takes nearly all of the gain. End to end this moved the measurements
from 0.720 to 0.733 and the blended verdict from 0.851 to 0.854. The norms are the median and half
the 16–84 percentile range over 1816 measured faces; they describe that benchmark, not humanity,
which is why the multiplier is modest.

### 3. The upper face carries more kinship — confirmed, but already exploited

Masking half of each aligned face before the recognition model sees it, on 259 pairs:

| shown to the model | AUC |
| --- | --- |
| whole face | 0.824 |
| eyes, brows, forehead only | 0.790 (−0.033) |
| nose tip, mouth, jaw only | 0.712 (−0.112) |

Upper minus lower: **+0.079, 95% CI [0.031, 0.125]**. Hiding the entire bottom half costs almost
nothing. But adding a separate upper-face view alongside the whole-face one gains **−0.001** on
held-out data: the model already uses what is there, so there is nothing to harvest. Confirmed,
interesting, not actionable.

Worth recording: the hand-built measurements **fail** to reproduce this. With colour removed, the
three regions score 0.605 (upper), 0.591 (middle), 0.620 (lower) — indistinguishable. The earlier
apparent upper-face advantage was entirely eye colour sitting in the upper group. Whatever the
network finds around the eyes, thirty-five ratios do not capture it.

### Making a baby version of the adult first — tested, no gain

An appealing idea: a child's face differs from *any* adult's in systematic ways, so child-vs-adult is
never a like-for-like comparison. De-age the parent first — or generate the baby they would have —
and then compare.

The age offset is real and measurable. In embedding space there is a consistent "growing up"
direction (mean adult minus mean child, length 0.206 in a unit-normalised 512-d space). In the
measurements it shows up as children having a relatively narrower nostril spread (+0.65 population
sd), wider forehead (−0.54), wider cheeks (−0.44) and a rounder face (−0.40).

Subtracting it does nothing. Estimating the direction on a training half and evaluating on the
held-out half:

| | AUC |
| --- | --- |
| embedding, no correction | 0.8174 |
| embedding, de-aged | 0.8207 — **+0.0034, 95% CI [−0.0014, +0.0106], inside noise** |
| measurements, no correction | 0.7483 |
| measurements, de-aged | 0.7504 |

**Why it cannot help, and the reason is worth keeping.** Every candidate is an adult being compared
with the same child, so a systematic child-versus-adult offset shifts *everyone's* score by roughly
the same amount and cancels in the ranking. Removing it removes something that was already cancelling.
(The same argument explained the sex-bias result earlier: a pull that applies to all candidates
equally is not a bias in the answer.)

A correction could only pay if the age effect **interacted with identity** — if growing up moved
different faces differently in ways that matter. A linear direction cannot capture that. A generative
de-ageing model could, in principle, and that is the honest case for the idea.

**What stops it being built here.** Three things, in order of severity:

1. **It hallucinates.** A generator asked for "this man's baby" fills everything it does not know
   from its training prior. The output would then be compared against a real child, and the
   generator's inventions would read as resemblance or its absence. That is the same failure as
   measuring iris positions painted on sunglasses, with a prettier interface.
2. **There is no ground truth to validate it against.** "Which parent does she take after" is not a
   labelled quantity. A generated baby can be *scored* — is the real child closer to it than to a
   random child — but that tests the generator, not the verdict.
3. **Size.** A useful generative face model is one to two orders of magnitude larger than the 41 MB
   this app already asks for, and would have to run on a phone.

The ceiling argument above suggests the payoff would be small even if all three were solved.

### What was not tested, and matters

Human resemblance judgements are badly contaminated by context — people told a child is a man's son
report more resemblance than people shown the same pair unlabelled. That is a fact about people, not
about faces, and it is the reason this app hides nothing from itself but shows the odds against
chance: the number is there to resist the same pull.

## Reproducing

The scripts live in the session that produced this, not in the repo, because they depend on a dataset
that cannot be redistributed. The method is small enough to restate exactly:

1. Download and unzip KinFaceW-II.
2. For every image, run the app's own pipeline: `rxRenderFace` over the whole crop, `rxDetect`,
   `rxMeasure`, `rxSampleColours` — both raw and after grey-world white balance.
3. Per measurement, compute Mann-Whitney AUC of `rxScore` on true pairs vs randomly re-paired ones.
4. Weight each measurement by `(AUC − 0.5) × 10`; give each feature the mean weight of its members.
5. For the null, sample one child and two unrelated adults 4000 times and record `|scoreA − scoreB|`.
