# Pronunciation scoring — implementation plan

Status: **All phases done** (see §10-§18). We are on **plan A**; every open
decision in §8 is resolved — see §18.6 for where each was settled.

This plan is written to be picked up cold. Read it end to end before writing
code — several of the phases exist specifically to keep later phases
debuggable, and doing them out of order makes every bug ambiguous.

---

## 1. What we're building

A third study direction. The card shows the English, you say the Spanish out
loud, and you get **per-phoneme** feedback — not a percentage, but "your /r/ in
*perro* was a tap, not a trill; your /x/ in *jugar* was too far forward."

Everything runs **on the device**, in the browser, with no API, no key and no
per-use cost. The acoustic model is downloaded once and cached.

Then the per-phoneme results feed back into the existing scheduler: knowledge
is tracked per *phoneme*, so a brand-new card's pronunciation difficulty can be
predicted from the sounds in it before it has ever been attempted.

---

## 2. Hard constraints

From `CLAUDE.md`, and from decisions already taken. Do not revisit these
without asking.

- **Local Supabase only.** No remote project, no `supabase link`, no deploy
  steps, no GitHub workflows.
- **Inference runs client-side in a Web Worker.** Not in an edge function. See
  §3.
- **Migrations are numbered and forward-only.** Next free number is `013`.
  After changing one, run `npm run db:reset`.
- **`src/types/database.types.ts` is generated.** Never hand-edit it. Any
  schema change needs `npm run db:types` (which `db:reset` also runs).
- **Every new table gets its RLS policies in the same migration that creates
  it.** Shared reference data (the deck itself, word frequencies) is readable
  by any signed-in user; anything recording how someone is *doing* is scoped to
  `user_id = auth.uid()`. `phone_state` below is the second kind.
- **`card_reviews` is append-only.** No update or delete policy. Adding
  *nullable* columns is fine and does not disturb this.
- **The deck weighting stays in SQL** (`study_deck`, migration 010; 016 as of
  the variety rework). The client does no ordering at all — the in-session
  requeue this used to allow for was removed in 016, and
  `src/app/lib/session-queue.ts` now only drops the answered card.
- **`card_state` is keyed on `(card_id, prompt_side)`.** Pronunciation becomes
  a third `prompt_side`, not a new keying scheme.
- **The metal look is a CSS vocabulary**, not utility soup — `.plate`, `.well`,
  `.chrome`, `.chip`, `.sheen` in `src/index.css`. Reach for those before
  writing new gradients. See the two gotchas in the README's "Look and feel".

---

## 3. Explicitly rejected approaches

These were considered and ruled out. If you find yourself reaching for one,
re-read the reason first.

**Running inference in a Supabase edge function.** Rejected because:

1. It deletes the point. "Runs entirely on-device, no API cost" is the whole
   claim being made. A server call is what every other project does.
2. The project is local-only, so the edge function runs in a Docker container
   on the same laptop as the browser. A Worker is the same machine minus an
   HTTP hop, minus JWT verification, minus the container.
3. Edge functions are short-lived Deno isolates with tight memory and no
   persistent cache between invocations — you would pay the ~90 MB weight load
   on every cold start to do ~200 ms of work.
4. `translate` is an edge function because MyMemory needs a server-side origin
   and a secret. There is no secret here.

**Streaming audio to the scorer.** Rejected. Utterances are 1–3 seconds.
Streaming forces *online* alignment — incremental Viterbi over a growing
lattice with no known endpoint to backtrace from — which is much harder and
buys nothing for a "say the word, get feedback" interaction. Buffer the whole
utterance, then score it.

**Transcribing with a speech-to-text model and comparing strings.** Rejected,
and knowing why is most of the value of this project:

1. A word-level recogniser carries a language-model prior. It knows *casa* is a
   likely Spanish word and will happily emit it from mangled audio. It is built
   to be forgiving; we need it to be picky.
2. It cannot localise. "Wrong" does not tell you which sound to fix.
3. It gives no degree. Borderline and catastrophic look identical.
4. It normalises away exactly the distinctions being scored.

**Building the audio capture first.** Rejected as a build order — see Phase 0a
for the de-risking spike that replaces it. G2P and the aligner are pure
functions with crisp right answers and no dependencies; build and test those
first, so that when the audio path misbehaves you already know the algorithms
are correct.

---

## 4. Theory you need

Enough to make the design decisions. Four ideas stacked on each other.

### 4.1 Phonemes, and why feedback must be per-phoneme

A **phoneme** is the smallest sound unit that can change a word's meaning.
Spanish has ~24; English ~44. An **allophone** is how a phoneme actually comes
out in context — Spanish /b/ is a hard [b] after a pause but a soft [β] between
vowels, and a native speaker hears no difference. **We must not score
allophones separately**, or we penalise correct native variation.

Learners fail where the languages carve differently: English has no trilled /r/
and no /x/, and does not distinguish /b/ from /v/ the way spelling suggests.
Those are the predictable failure modes and the reason per-phoneme feedback is
worth the effort — "72% correct" is unactionable, "your /r/ was a tap" is not.

### 4.2 G2P: spelling to phonemes

**Orthographic depth** is how predictably sound follows from spelling. English
is deep (`through/though/rough/cough`) and needs a dictionary. Spanish is
shallow — near enough one-to-one — which is the entire reason this is tractable
with a few hundred lines of rules and no pronunciation dictionary.

Three sub-problems, not one:

1. **Context-sensitive letters.** `c` is /k/ before *a/o/u* and /s/ before
   *e/i*; `g` likewise; `h` is silent; `ll` is one phoneme; the *u* in `qu`/`gu`
   is silent; `x` is irregular and needs an exceptions list.
2. **Syllabification**, because stress lands on syllables. The hard part is
   vowel sequences: *i* and *u* are weak and glue onto a neighbouring vowel to
   make one syllable (*tie-rra*), unless accented (*dí-a*, two syllables from
   what looks like the same pattern).
3. **Stress assignment.** Default: stress the last syllable if the word ends in
   a consonant other than *n*/*s*, otherwise the second-to-last. A written
   accent overrides. Stress matters because a stressed vowel is longer and
   clearer, so misplacing it is audible.

### 4.3 Frames and the acoustic model

Audio is 16,000 samples per second — you cannot reason about a sample. Speech
is **quasi-stationary**: over ~25 ms the vocal tract barely moves, so a 25 ms
window holds roughly one sound. Chop the audio into overlapping windows,
stepping ~20 ms. A 2-second clip becomes ~100 **frames**.

An **acoustic model** is then just:

```
one frame of audio  ->  probability distribution over phoneme labels
```

Per frame, ~40 numbers summing to 1. That is the entire interface.

Good ones are free because of **self-supervised pretraining**: models like
wav2vec 2.0 first learn from unlabelled audio by predicting masked spans,
which forces them to represent speech sounds without anyone labelling a
phoneme; only a thin layer is then fine-tuned on labelled data.

### 4.4 CTC and forced alignment — the core algorithm

You have ~100 frames of probabilities and a 4-phoneme target `/k a s a/`. You
need to know **which frames are the /k/**. The mapping is monotonic and
many-to-one, the boundaries are unknown, and the number of ways to divide 100
frames among 4 phonemes is astronomically large. Hence dynamic programming.

**CTC** (Connectionist Temporal Classification) is how the model was trained
without boundary labels, and it gives us the machinery:

1. A **blank** symbol meaning "no new phoneme here".
2. A **collapse rule**: repeats collapse, blanks vanish, so `∅ k k ∅ a a a` and
   `k ∅ a ∅ ∅ ∅ ∅` both decode to `/k a/`. Blanks are what make a genuine
   repeat expressible — `/k k/` needs a blank between them.
3. Training **sums over all alignments** that collapse to the right answer, so
   the model never needs to be told which one is true.

A side effect: CTC models are **peaky** — mostly blank, with sharp spikes where
each phoneme is. Good for locating phonemes, slightly awkward for measuring
their duration.

**Forced alignment** asks the easy question. Not "what was said?" (a search
over all label sequences) but "given that it was `/k a s a/`, *when* did each
part happen?" Expand the target with blanks:

```
∅  k  ∅  a  ∅  s  ∅  a  ∅          <- 9 states
```

Walk from the left end to the right end, one column per frame. At each step you
may only:

- **stay** in the same state (the phoneme continues),
- **advance** one state, or
- **skip** a blank — but *only* between two **different** phonemes.

```
        t=1    t=2    t=3    t=4   ...
 ∅  o------>o
     \       \
 k    o------>o------>o
       \       \       \
 ∅      .      o------>o
         \      \       \
 a        .      .      o------>o
```

Define `best[s][t]` = score of the best legal path reaching state `s` at frame
`t`: the max over the three moves into `s`, plus that frame's log-probability
for `s`'s label. Fill left to right, then **backtrace** from the end — and the
winning path *is* the alignment. Intractable search becomes `O(frames ×
states)`; about 900 cells for *casa*.

Two variants of the same recursion, do not confuse them:

- **Viterbi** takes `max` -> the single best path. **This is what we want.**
- **Forward** takes `sum` (log-sum-exp) -> total probability over all paths.

Same algorithm family as HMM decoding, edit distance and Needleman–Wunsch.

### 4.5 GOP: alignment to score

Now the frames for each phoneme are known, so we can ask whether that stretch
sounded like an /r/. **Goodness of Pronunciation** (Witt & Young, 1997) is a
comparison, not an absolute:

```
GOP(p) = log P(p | frames)  -  max  log P(q | frames)
                              q != p
```

*How much better does the intended phoneme explain this audio than the best
competing phoneme does?*

| GOP | Meaning |
| --- | --- |
| near 0 | The intended sound was also the model's top choice. Good. |
| very negative | Something else explained it better. You said a different sound. |

The comparison is essential: `P(/r/) = 0.4` is uninterpretable alone, but it is
excellent if every rival scored under 0.1 and wrong if tapped /ɾ/ scored 0.55.
And because we know **which** phoneme won instead, feedback can be diagnostic
rather than merely negative.

Alignment also yields **duration** for free — an independent signal, since a
correctly-identified vowel held for 400 ms is still wrong.

### 4.6 Calibration: the problem with no ground truth

GOP scores are **not comparable across phonemes or speakers.** Some phonemes
are intrinsically confusable (/a/ is distinctive and always scores well; /r/ vs
/ɾ/ vs /l/ live close together and score worse *even for natives*). Microphone,
room and voice shift every score together.

So a single global threshold nags about /r/ forever and never catches /x/. And
there are **no labels** — nobody is marking each attempt. That reframes the
task: this is **anomaly detection against a reference distribution**, not
supervised classification. Two normalisations, layered:

1. **Against natives.** Align a few thousand Mozilla Common Voice clips (CC-0,
   free) and build the GOP distribution *per phoneme* for native speech. Score
   the learner as a **z-score** against it: "your /x/ sits 2.4σ below where
   natives sit." That is meaningful, and it makes one threshold work for every
   phoneme.
2. **Against yourself.** Native stats do not cancel out *your* microphone, so
   also normalise using the learner's own recordings of phonemes they have
   already demonstrated. (Score-level cousin of mean-variance normalisation.)

Residual honesty for the write-up: choosing the threshold is a
precision/recall tradeoff with no validation set. The defensible move is to set
it against the native distribution — "flag what fewer than 5% of natives would
produce" — and state plainly that it is a design choice, not a measurement.

### 4.7 Factorised skill and active learning

The scheduler currently models knowledge per `(card, direction)`. But
pronunciation lives in **sounds**, and sounds are shared across cards. So model
skill per phoneme and treat a card's difficulty as a function of the phonemes
in it. (The general frame is item response theory: an observed success depends
on a latent ability and an item's difficulty — here one item exercises several
abilities at once.)

Two consequences:

- **Cold start disappears.** A new card containing /r/ and /x/ is predictably
  hard *before it is ever attempted*. Compare the flat `0.85` unseen-urgency in
  `study_deck` — a constant precisely because a card has no history. A phoneme
  has one.
- **Credit assignment is solved by alignment.** When an attempt fails, *which*
  skill was at fault? In general this is hard. Here, alignment says exactly
  which phoneme scored badly. That is the real reason alignment is worth the
  effort — it is what makes the learner model identifiable.

Then keep a *distribution* per phoneme (a Beta posterior is natural for "how
often do I get this right"), and card selection changes shape. The current
weighting is pure exploitation — it ranks by expected value, `urgency ×
utility`. But some cards are valuable because we are *uncertain*: studying them
teaches the model as well as the learner. Maximising **expected information
gain** is the exploration side, and the tension is the explore/exploit tradeoff.

`study_deck` is already most of the way there: it does not rank by weight, it
runs an **exponential race** (Efraimidis–Spirakis) that samples proportional to
weight. Sampling *is* the exploration mechanism, and the Bayesian version —
draw a value from each phoneme's posterior and act as if it were true — is
**Thompson sampling**. Preserve that structure; do not replace it with a sort.

---

## 5. Repo conventions to follow

- **Put new modules under `src/app/lib/`.** The path aliases in
  `vite.config.ts` and `tsconfig.json` are per-directory (`@/app`, `@/api`,
  `@/components`, `@/pages`, `@/types`) with no root wildcard, so
  `src/app/lib/phonology/g2p.ts` resolves as `@/app/lib/phonology/g2p` with no
  config change. A new top-level `src/phonology/` would require editing both
  config files — don't.
- **Tests are co-located** as `*.test.ts` beside the source. Vitest is
  configured with `globals: true` and `environment: "jsdom"`, but the existing
  tests still import `{ describe, expect, it } from "vitest"` explicitly —
  match that.
- **DB rows are snake_case, the app is camelCase.** Convert at the `src/api`
  boundary (see `toCard` / `toDeckEntry` in `src/types/cards.ts`), never deeper.
- **API functions throw `Error` with a human-readable message**; pages catch and
  render. No `{ data, error }` tuples upward.
- Note `jsdom` has no `AudioContext`. Anything touching Web Audio cannot be
  unit-tested in this setup — another reason the pure phases come first.

### Verify a change

```bash
npm test                          # phases 1, 2, 5
npm run typecheck && npm run build
```

---

## 6. Phase plan

Phases 1 and 2 are the whole intellectual core and require **no new
dependencies**. Do not install anything until Phase 3.

### Phase 0a — mic capture spike (throwaway, ~1 hour)

Scratchpad only, **not** committed. Prove you can get a `Float32Array` of
16 kHz mono out of the browser; log its length and peak level. Then delete it
and move to Phase 1.

The non-obvious part, which is why this spike exists:

```js
getUserMedia({ audio: {
  channelCount: 1,
  echoCancellation: false,   // all three OFF — defaults are true
  noiseSuppression: false,
  autoGainControl: false,
}})
```

Browser audio DSP is tuned for voice calls. Noise suppression gates quiet
fricatives — exactly the sounds being scored — and AGC changes gain
dynamically, which would wreck the per-speaker calibration in §4.6.

### Phase 0b — model availability spike (do this before Phase 1 freezes anything)

**The highest-risk item in the project.** Find a **phoneme-level CTC** acoustic
model that:

1. exports to ONNX,
2. quantizes to a size worth shipping (target ≲100 MB int8),
3. has a **documented output label inventory**.

Do not take this on faith. Download a candidate and dump its labels. The
wav2vec 2.0 XLSR family has multilingual IPA fine-tunes; verify what is
actually exportable rather than assuming.

> **Plan B, and it is a decent one.** Use a **character-level** Spanish CTC
> model instead. Spanish orthography is shallow enough that characters are
> nearly phonemes, and the headline feedback case survives — trilled and tapped
> R are spelled differently (`rr` vs `r`). You lose `c`-softening, `ll`/`y`, and
> the `b`/`v` merge, and "G2P" collapses to "normalise the spelling". Much less
> impressive, dramatically less risky.
>
> **Decide which plan you are on before Phase 1**, because it determines the
> phone inventory.

**Deliverable:** a short note appended to this file recording the model chosen,
its label list, its size, and whether we are on plan A or plan B.

### Phase 1 — G2P (pure TypeScript, no dependencies)

**Files:** `src/app/lib/phonology/{inventory,syllabify,stress,g2p}.ts` plus
co-located tests.

**Decisions already made** — implement these, don't re-open them:

- **Dialect: Latin American.** Seseo (no /θ/, so `c`+*e/i* -> /s/) and yeísmo
  (`ll` -> /ʝ/). Otherwise *casa*/*caza* need a distinction we don't want.
- **Collapse allophones into one scored unit each:** [b]/[β], [d]/[ð],
  [g]/[ɣ], and [n]/[ŋ] before velars. Per §4.1.
- **Keep /ɾ/ and /r/ distinct.** This distinction is the feature. Do not
  collapse it.
- **Diphthongs:** score the weak vowel as a glide, /j/ or /w/.
- `inventory.ts` owns the **mapping from our symbols to model labels**. G2P
  emits our own IPA symbols; a `modelLabelMap` table is the seam, so swapping
  the model is a one-table change.

Starting inventory (~24 scored units): `a e i o u p b t d k g tʃ f s x m n ɲ l
ɾ r ʝ j w`.

**Verify** with table-driven tests: `casa`, `murciélago`, `tierra` vs `día`
(diphthong vs hiatus), `jugar`, `perro` vs `pero`, `cielo` vs `como`, `queso`,
`guitarra`, word-final `y` (`hay`, `muy` -> /i/), and stress on
`hablo`/`habló`/`hábil`.

### Phase 2 — CTC forced alignment (pure TypeScript, no dependencies)

**File:** `src/app/lib/align/ctc.ts` ->
`forcedAlign(logProbs, labels) => PhoneSpan[]` where a span carries the label,
start frame, end frame and score. All arithmetic in **log space**; `max`, not
log-sum-exp (Viterbi, per §4.4).

The trick that makes this testable with no audio and no model: **hand-construct
the posterior matrix.** Build a small `T × labels` array where you have decided
in advance which frames favour which phoneme, and assert the exact spans that
come back.

**Verify:** a clean case; unequal durations; an **adjacent repeated label**
(must *not* skip the blank between them — the rule in §4.4); a degenerate
all-blank input; and a target longer than the frame count (must fail loudly,
not silently mis-align).

At the end of Phase 2 both hard algorithms are done and provably correct, with
nothing installed.

### Phase 3 — acoustic model in a Worker

Add `onnxruntime-web`. Run the model in a Web Worker, cache the weights via the
Cache API so the download happens once.

**Deliverable:** `Float32Array (16 kHz mono) => { logProbs, labels }` behind one
typed `postMessage` contract. Keep that contract narrow — it is the seam that
makes the model swappable (same idea as `Provider` in
`supabase/functions/translate/provider.ts`, one layer out).

**Verify:** commit a Common Voice WAV with a known transcript as a fixture, run
it through Phases 1+2, and assert the phone boundaries land in plausible
places. First real end-to-end proof.

### Phase 4 — real audio capture

**File:** `src/app/lib/audio/` + a `useRecorder` hook.

AudioWorklet -> ring buffer -> `OfflineAudioContext` resample to 16 kHz ->
energy-based endpoint trim, so the aligner doesn't absorb 500 ms of room noise
into the first phoneme.

AudioWorklet rather than `MediaRecorder` because it skips the Opus encode/decode
round-trip *and* gives live sample access for a level meter, which the UI wants
anyway. Carry over the `getUserMedia` constraints from Phase 0a.

### Phase 5 — GOP and calibration

**File:** `src/app/lib/phonology/gop.ts` — ~30 lines once alignment exists
(§4.5).

**Script:** `scripts/gen-native-stats.mjs` — pull N Common Voice clips, align
them, emit per-phoneme GOP mean and σ. This follows the existing
`scripts/gen-word-frequency.py` -> migration 005 pattern of generated reference
data.

**One deviation from that precedent, deliberately:** emit a generated **TS
module** (`src/app/lib/phonology/native-stats.generated.ts`) rather than a
migration. It is ~24 rows, it must be readable synchronously during scoring,
and it should version alongside the algorithm rather than the schema. Mark it
generated in a header comment, the way `database.types.ts` is.

### Phase 6 — schema (migration 009)

- Add `'pronounce'` to the `prompt_side` check constraints on `card_reviews`
  **and** `card_state`.
- Add to `card_reviews`: `score real` and `phone_scores jsonb`, **both
  nullable**. Additive, so append-only is undisturbed.
- Create `phone_state` (per user, per phoneme: attempts, successes, running GOP
  stats), with its RLS policy in the same migration.
- Widen `Side` in `src/types/cards.ts` and the `sides` handling in
  `src/api/cards.ts`.
- `npm run db:reset` (needs Docker and `npm run db:start`).

**Trap — decide this correctly.** `study_deck` enforces one direction per card
per deck with `distinct on (r.id)`. Add `'pronounce'` as a third competing
direction and a card can be dealt as a *pronunciation* prompt instead of a
translation prompt — silently changing a working scheduler while the scoring is
still unproven.

**So: make pronunciation a separate deck mode first.** Pass
`sides => ['pronounce']`, add a fourth option to `DirectionPicker` in
`src/pages/Study.tsx`. Let it compete for slots only once the scores are
trusted.

### Phase 7 — UI

Pronunciation mode in `src/pages/Study.tsx`, with per-phoneme feedback rendered
from the `PhoneScore[]`.

Use the existing CSS vocabulary: a `.well` track per syllable with the GOP
z-score as a lit meter, `.chip` for the "you said /ɾ/, wanted /r/" diagnosis.
Respect `prefers-reduced-motion`, as everything else does.

### Phase 8 — `phone_state` feeds the scheduler

The payoff. Predict a new card's pronunciation difficulty from its phonemes,
and add the exploration term from §4.7. **Stays in SQL** — this is a migration,
not client code.

---

## 7. Traps

Collected from the design discussion and the existing README.

- **Browser audio DSP is on by default** and must be turned off (§Phase 0a) —
  and **read the constraints back**, they can be silently ignored (§10.6).
- **The blank is the top rival on nearly every frame.** GOP's `max over q != p`
  must exclude it or it measures peakiness, not pronunciation (§10.3).
- **`ɡ` is U+0261, not ASCII `g`**, and the blank index is model-specific (0
  here, 37 in the §10.4 fallback). Both fail silently (§10.2).
- **Native stats must be generated with the same quantized build as the app**,
  or the §4.6 z-scores shift under you (§10.3).
- **Common Voice is gated on HuggingFace** — §4.6/Phase 5 assume otherwise
  (§10.5).
- **Do not score allophones separately** — it penalises correct native
  variation (§4.1). The model does emit `β ð ɣ`, and long vowels, so this
  collapse is mandatory, not cosmetic (§10.2).
- **GOP is not comparable across phonemes.** A single global threshold is
  wrong; z-score per phoneme (§4.6).
- **CTC blank-skip is only legal between two *different* labels.** Getting this
  wrong silently mis-aligns any word with a doubled sound.
- **CTC models are peaky**, so phoneme *durations* from alignment are less
  reliable than phoneme *identities*. Weight duration evidence accordingly.
- **`distinct on (r.id)` in `study_deck`** will start dealing pronunciation
  prompts in place of translation prompts the moment `'pronounce'` becomes an
  eligible side (§Phase 6).
- **`jsdom` has no `AudioContext`** — Web Audio code is not unit-testable here.
- **`background-clip: text` (`.chrome`) does not reach transformed
  descendants.** Put `.chrome` on the animated element itself.
- **Off-scale Tailwind opacity steps emit nothing** — `bg-white/8` is silently
  no CSS. Use a real step or bracket notation.

---

## 8. Open decisions

1. ~~**Plan A (IPA phonemes) or plan B (character-level)?**~~ **RESOLVED:
   plan A**, on `wav2vec2-xlsr-53-espeak-cv-ft`. The Phase 1 inventory as
   written is confirmed against the model's labels. See §10.1-10.2.
2. **Native stats as a generated TS module or migration 010?** Recommendation
   in Phase 5 is the TS module; migration 005 sets a precedent for the other
   choice. Either is defensible.
3. **Does pronunciation eventually compete for deck slots, or stay a separate
   mode permanently?** Start separate (Phase 6). Revisit after Phase 8, when
   there is enough data to know whether the scores are trustworthy.
4. **Score threshold.** Deferred to Phase 5, and it is a design choice rather
   than a measurement — say so in the code comment.
5. **Where does native audio come from?** New, raised by Phase 0b: Common Voice
   is gated (§10.5). Manual download, a HF token, or another corpus. Blocks
   Phase 5, nothing earlier.
6. **Merge `ʎ`→`ʝ` and `θ`→`s`?** New (§10.2). Recommended, by the same
   don't-penalise-native-variation logic as §4.1. Phase 1 decision.

---

## 9. Definition of done

- `npm test` covers G2P (Phase 1), forced alignment (Phase 2) and GOP
  (Phase 5), including the adjacent-repeated-label case.
- `npm run typecheck && npm run build` clean.
- A pronunciation deck can be studied end to end offline after first load, with
  per-phoneme feedback on screen.
- `card_reviews` rows carry `score` and `phone_scores` for pronunciation
  attempts; `phone_state` accumulates.
- README updated: a "Pronunciation" section in the same register as "The
  scheduling algorithm" — the maths, the decisions, and what was deliberately
  not done.

---

## 10. Phase 0 results (2026-09-04)

Both spikes are done. **We are on plan A.** Open decision #1 is resolved.

### 10.1 Phase 0b — the model

**Chosen: `facebook/wav2vec2-xlsr-53-espeak-cv-ft`**, taken as a pre-exported
ONNX from **`qnighy/wav2vec2-xlsr-53-espeak-cv-ft-ONNX`** (`onnx/model_q4f16.onnx`).
`Wav2Vec2ForCTC`, 24 layers, hidden 1024, `vocab_size` 392.

The other espeak sibling, `wav2vec2-lv-60-espeak-cv-ft`, is **the wrong one** —
its pretraining is English-only (Libri-light) and it was measurably worse on
Spanish. It has the better-stocked ONNX repo (`onnx-community/...`, including an
int8), which makes it the one you find first. Don't.

| build | size | verdict |
| --- | --- | --- |
| `model.onnx` (fp32) | 1264 MB | reference only |
| `model_fp16.onnx` | 632 MB | no |
| `model_q4.onnx` | 241 MB | works |
| **`model_q4f16.onnx`** | **197 MB** | **ship this** — ran fine on CPU EP, decodes identical to fp32 |

**We miss the ≲100 MB target — 197 MB is the floor for plan A.** Accepted, for
three reasons. There is no base-sized multilingual IPA CTC model (the espeak
family is all `large`); plan B is *the same size class*, so falling back buys
accuracy loss and no megabytes; and the weights are Cache-API'd once on a
local-only personal app. If 197 MB later proves intolerable, the escape hatch is
§10.4, not plan B.

### 10.2 The label inventory — verified, not assumed

392 labels. **All 24 units in the Phase 1 starting inventory are present**, so
the inventory in §Phase 1 stands unchanged. Dumped from
`https://huggingface.co/qnighy/wav2vec2-xlsr-53-espeak-cv-ft-ONNX/resolve/main/vocab.json`
— refetch that when writing `modelLabelMap`; don't retype it from here.

What `inventory.ts` needs to know beyond the plain 1:1 hits:

- **`ɡ` is U+0261 LATIN SMALL LETTER SCRIPT G, not ASCII `g`.** §Phase 1 writes
  it as ASCII. A lookup on the wrong codepoint fails silently and every /g/
  scores as an error.
- **The blank is `<pad>` at index 0** (`pad_token_id: 0`), confirming the Phase 2
  assumption. Read it from config rather than hardcoding — the §10.4 fallback
  puts it at index **37** instead.
- **The allophones are all in the inventory** — `β`, `ð`, `ɣ` are real labels the
  model will emit for intervocalic /b d g/. This makes the §4.1 collapse
  mandatory rather than tidy: without it, correct native *haba* aligns to `b`
  while the model is confidently saying `β`, and GOP tanks on good speech.
- **Add the long vowels to the same collapse.** `aː eː iː oː uː` are all in the
  inventory and the model does emit them (it gave `iː` for the /e/ of *pero*).
  Spanish has no phonemic length, so merge each into its short counterpart.
- **Two dialect merges to decide, same shape as §4.1.** `ʎ` and `θ` both exist as
  labels. We chose yeísmo and seseo, so G2P emits `ʝ` and `s` — but a speaker who
  says `ʎ` in *llave* or `θ` in *cielo* is being Peninsular, not wrong.
  Recommendation: merge `ʎ`→`ʝ` and `θ`→`s` for the same reason we merge `β`→`b`.
- Ignore the junk labels (`??`, `S`, `X`, `dZ`, `tS`, `s^`) and the tone-marked
  CJK entries (`ɑ5`, `əɜ`, …). They are espeak fallback debris.

### 10.3 What the model actually does — measured

Test clips: macOS `say -v Paulina` (es_MX) for seven words, plus one **native
human** recording (`Es-perro.wav`, Wikimedia Commons) as the control. Greedy CTC
decode, q4:

```
nat_perro (native) -> p e r r o      guitarra -> ɡ i t a r r a
casa               -> k a s a        cielo    -> s j e l o
pero               -> p iː ɾ o       jugar    -> uː ɡ a r
```

Read these carefully, because the split matters: **the native clip decodes
essentially perfectly, and the synthetic ones degrade.** The TTS voice is the
weak link, not the model — so do not over-read the misses (`jugar` losing its
/x/, `tierra` mangled). It does mean **`say` is not good enough as a Phase 3
fixture**; use real speech.

Three things this confirms outright:

- `casa` → `k a s a`, which is the exact worked example in §4.4.
- `cielo` → `s j e l o` validates *both* Phase 1 decisions at once: seseo (`s`,
  not `θ`) and diphthong-as-glide (`j`).
- **The tap/trill contrast is real**: *pero* → `ɾ`, *perro* → `r`. The headline
  feature works.

**Frame rate is 20 ms as §4.3 assumes** (7814 samples → 24 frames). The ONNX
output shape is dynamic and self-describing:
`floor(floor(floor(floor(floor(floor(floor(len/5)/2)/2)/2)/2)/2 - 3/2)/2 - 1/2) + 1`.
Input is `input_values` only — **no `attention_mask`** — float32, and
`preprocessor_config.json` sets `do_normalize: true`, so zero-mean/unit-variance
the waveform before the call. Getting that wrong is silent.

**New trap, and it is a big one — GOP must exclude the blank.** Top-5 rivals per
frame on the native clip:

```
p:-0.06  <pad>:-3.70  b:-5.10  k:-6.03  t:-6.18
e:-0.05  i:-4.14  eː:-4.78  <pad>:-4.81  a:-4.89
r:-0.27  <pad>:-1.68  ɾ:-3.62  a:-5.55  e:-5.85
o:-0.06  <pad>:-3.79  u:-4.19  a:-5.17  e:-5.72
```

`<pad>` is the **top rival on nearly every frame** — that is the §4.4 peakiness
showing up in the place it does damage. `max over q != p` in §4.5 taken over the
raw 392 would mostly measure "how blank is this frame", which is not a
pronunciation score at all. **Exclude the blank from the rival set.**

The good news, and it settles a question §4.5 leaves open: once the blank is out,
the rivals are **phonetically sensible without any restriction to a Spanish
subset** — /p/ loses to *b, k, t* (voicing and place), the vowels lose to their
neighbours, and **`ɾ` is the top non-blank rival to `r`**. The diagnostic
feedback this project exists to give falls straight out of the posterior. No
tone-marked junk in any top-5 on native audio. Restricting rivals to the 24 is
still worth doing as a cheap guard, but it is not load-bearing.

**Quantization vs GOP.** q4 against fp32: frame argmax agrees 87.5–100%, and the
GOP margin (blank excluded) has a mean absolute error of **~0.3 nats**. Not
nothing. It is fine *provided* `gen-native-stats.mjs` (Phase 5) runs the **same
build** as the app, because §4.6 z-scores against those stats and a systematic
quantization bias then cancels. **Regenerate native stats whenever the model
build changes** — mixing an fp32 reference distribution with a q4f16 runtime
would silently shift every score.

### 10.4 Escape hatch if 197 MB is too much

`Cnam-LMSSC/wav2vec2-spanish-phonemizer` — Spanish-specific, **wav2vec2-base**
(12 layers, hidden 768, ~94 M params, 378 MB fp32 → **~95 MB int8**, under
target). Its inventory is 38 labels and Spanish-shaped, matching §4.3's "~40
numbers per frame" far better than 392 does:

```
a b d e f i j k l m n o p r s t u w x ð ŋ ɛ ɡ ɣ ɪ ɲ ɾ ʃ ʊ ʎ ʒ ʝ ː β θ
```

Both `r` and `ɾ` present, so the headline feature survives. Caveats: **no `tʃ`**
(so *chico* has nowhere to go), no ONNX export exists so we would have to run the
export ourselves, blank sits at index **37** not 0, and it is essentially
unvetted (~700 downloads). Not chosen. Recorded so Phase 3 has somewhere to go.

### 10.5 Corrections to earlier sections

- **§4.3 says "~40 numbers summing to 1" per frame. It is 392.** Harmless for
  storage (a 2 s clip is ~100 × 392 floats, ~157 KB) but it is what forces the
  rival-set decision above.
- **§4.6 assumes Common Voice clips can just be pulled. They cannot** —
  `mozilla-foundation/common_voice_*` is **gated** on HuggingFace and 403s
  without an auth token. `voxpopuli` and `fleurs` are ungated but too large for
  the datasets-server preview API. **Phase 5 needs a decision it doesn't
  currently have**: accept a manual one-off download, or use a HF token, or
  source native audio elsewhere. Wikimedia Commons has native single-word
  recordings (`Special:FilePath/Es-<word>.wav`) and served as the control here,
  but coverage is patchy and it will not yield "a few thousand clips".

### 10.6 Phase 0a — mic capture

Spike lives in the scratchpad (not committed, per the plan). AudioWorklet → chunk
splice → `OfflineAudioContext` resample to 16 kHz → `Float32Array`, plus a
constraint readback and a WAV download so a capture can be fed straight to 0b.

Driven headlessly against Chrome's fake capture device and against the real
built-in mic. **The full path works**: 48 kHz hardware → 92 672 samples → 30 891
samples at 16 kHz (1.93 s), `Float32Array`, as intended.

- **All four constraints are honoured on the real device**, `channelCount: 1`
  included — the DSP-off trio in §Phase 0a does take effect.
- **But read the constraints back anyway.** Against the *fake* device
  `channelCount: 1` was silently **ignored** (got 2). That is exactly the failure
  mode the spike exists to catch, and the readback is worth carrying into Phase 4
  rather than trusting the constraint object.
- **Float32 audio is not bounded to [-1, 1]** — the fake device peaked at
  **1.1298**. Clamp before any int16 conversion, and don't use peak as a
  normaliser without a guard.
- Chrome will not pull an AudioWorklet that isn't connected to a sink; connect it
  to `destination` even when nothing should be audible.

**One leg is unverified:** headless Chrome gets the real mic but records digital
silence (peak 0.0000) because macOS never granted it TCC access, so *speech
through the real capture path* has not been proven end to end. Everything up to
and including the sample buffer has. Run it in a normal browser window to close
that out.

---

## 11. Phase 1 results (2026-09-04)

Done. `src/app/lib/phonology/{inventory,syllabify,stress,g2p}.ts` plus co-located
tests — 72 tests, no new dependencies, `npm test` / `typecheck` / `build` clean.
Every word in the §Phase 1 verify list is a row in `g2p.test.ts`.

The inventory is **unchanged from the plan** — all 24 units, seseo and yeísmo,
tap and trill kept apart, allophones collapsed. Two decisions the plan left open
are now taken in code:

- **Open decision 6 is implemented as recommended**: `θ`→`s` and `ʎ`→`ʝ` are
  accepted on the model side, so a Peninsular speaker is not marked wrong. One
  line each in `MODEL_LABELS`; reverse it there if you disagree.
- **Stress reads the final *letter*, not the final sound.** *Paraguay* ends in a
  vowel sound but a consonant letter, and takes final stress. Deriving the rule
  from the phones gets it wrong, and it is the sort of thing that looks correct
  until one word disagrees.

### Cross-checked against the real model

The Phase 0b spike is still runnable, so the G2P targets were diffed against
actual decodes rather than only against my own expectations. `casa` → `k a s a`
and `cielo` → `s j e l o` match the model exactly. Two mismatches are real and
are recorded in `inventory.ts` next to the seam, because **both are the
aligner's problem, not G2P's**:

1. **The trill decodes as two labels.** *perro* is `p e r o` to us and
   `p e r r o` to the model — two CTC peaks with a blank between them, not two
   phonemes. Phase 2 must fold that back into one span, and it is exactly the
   adjacent-repeated-label case §Phase 2 already says to test.
2. **A glide can surface as its full vowel** — *muy* is `m w i` to us, `m uː i`
   to the model. Not fixed by widening the table: adding `u` to the `w` row
   would make `MODEL_LABEL_TO_PHONE` ambiguous, and that map has to answer "what
   sound was that?" cleanly for the §4.5 diagnosis. Phase 5 should treat a
   glide/vowel confusion as a near-miss instead.

### Small additions beyond the brief

- `g2pPhrase()`, because card faces are phrases, not words. Each word is
  pronounced independently — **cross-word resyllabification is not modelled**
  (*los amigos* really does run as /lo-sa-mi-gos/), so word boundaries are where
  the aligner's spans will be softest.
- G2P **throws** on characters it cannot pronounce rather than skipping them. A
  silently wrong target mis-aligns every frame after it and reads as the
  learner's mistake.

---

## 12. Phase 2 results (2026-09-04)

Done. `src/app/lib/align/{ctc,target}.ts` plus co-located tests — 36 tests, no
new dependencies. `npm test` is 120 tests green; see the note on `typecheck` at
the end of this section.

Both hard algorithms are now finished and provably correct with nothing
installed, which is what §Phase 2 was for.

### What shipped, and where it differs from the brief

The signature is `forcedAlign(logProbs, target, { blank })`, and the target is
a `TargetUnit[]` — a label to report plus the **model rows that count as it** —
rather than the bare label indices §Phase 2 implies. That is not decoration:
the allophone collapse of §4.1 is numerically a *sum*, `P(/b/) = P(b) + P(β) +
P(v)`, and a sum has to happen inside the emission term where the DP can see
it. Doing it earlier would mean picking one of the rows and throwing the rest
away, which is the mistake §10.2 says tanks the score on good speech.

- **`logProbs` is flat and frame-major** (`data[t * vocabSize + v]`), matching
  the `[1, frames, vocab]` tensor Phase 3's ONNX call hands back, so the worker
  passes its output straight through.
- **`blank` has no default.** It is 0 for the chosen model and 37 for the
  §10.4 fallback, and wrong is silent — so the caller states it (§7).
- **`logSoftmax` is exported** from `ctc.ts` because a CTC head emits
  unnormalised logits and Phase 3 would otherwise hand-roll it. Worth knowing:
  normalising does **not** change the alignment (a per-frame constant shifts
  every state in a column equally), only the readability of the scores. There
  is a test asserting exactly that.
- **`buildTarget(phones, vocab)`** in `target.ts` is the Phase 1 → Phase 2
  seam: it reads the model's `vocab.json` label list and `inventory.ts`'s
  table, so neither the aligner nor G2P ever learns a label string.
- Everything throws on bad input — target longer than the recording, a phone
  with no model label, a unit that counts the blank as itself. Per §11's
  reasoning: a silently mis-aligned target reads back as the learner's mistake.

### Five things the tests pinned down

1. **The doubled trill folds into one span when the dip has evidence in it.**
   §11's open item: *perro* is `p e r o` to us and `p e r r o` to the model.
   With one /r/ in the target the path can only hold one span, and on a matrix
   whose dip keeps real /r/ mass it stretches across both peaks — `r[4,7)`.
   Where the dip is *pure* blank, staying in /r/ and handing the second peak to
   the following vowel score **exactly the same**, and the tie-break decides.

   **§13.3 measured the real clip and it is the second case, not the first** —
   the dip is `<pad>:-0.04` against `r:-3.41`, so the aligner takes the sharper
   peak and leaves the other in the blank state. The rule is the same either
   way; the posterior decides which behaviour you see. Read §13.3 before
   relying on any span *boundary*.
2. **Spans do not tile the recording.** Frames the path spends in a blank state
   belong to no phone, so consecutive spans need not touch. Phase 5 must not
   assume contiguity and Phase 7's per-syllable meter must not assume the
   spans add up to the clip.
3. **Duration is not independent evidence when the phone is absent.** §4.5 gets
   duration "for free", which is true, but when a target phone has no support
   anywhere the path gives its frames to the neighbours and keeps the bare
   minimum. So a short span and a bad score are the same observation, and
   Phase 5 should not count them twice.
4. **`PhoneSpan.score` is the mean per-frame `log P`, not a verdict.** It is
   not comparable across phonemes (§4.6) and it dips on the peaky model's
   internal blank frames. Phase 5 thresholds the margin over the best
   *non-blank* rival (§10.3); the span is the input to that, not a substitute.
5. **Composite labels are handled contextually.** `eɪ` counts as our /e/ *only*
   when the next phone is the /j/ it is half of; an `eɪ` frame in *peso* stays
   a genuine miss. Both units accept the label and share its frames, which
   resolves the second mismatch recorded at the bottom of `inventory.ts`
   without making `MODEL_LABEL_TO_PHONE` ambiguous. The cost is that boundaries
   *inside* a diphthong are arbitrary and the two units score alike.

The §Phase 2 verify list is covered row for row: clean case (the §4.4 *casa*
example), unequal durations, the adjacent-repeated-label rule, an all-blank
degenerate input, and a target longer than the frame count. The repeat case
gets three tests rather than one, because it is the rule that silently
mis-aligns every word with a doubled sound: `n n` with a blank frame between
them stays two spans; with **no** blank frame the aligner spends a frame on the
blank it never saw rather than merging; and `n n` in two frames is refused,
because the blank costs a frame that `n l` does not.

### The schema this plan was written against has moved

The repo has since gained `009_shared_deck.sql`, `010_study_deck.sql`,
`011_seed_cards.sql` and `012_phrase_zipf_probe.sql`, so **§2's "next free
number is 009" is now 013** (§2 has been corrected in place) and Phase 6 should
re-read `010`'s `study_deck` before touching the `distinct on (r.id)` trap.

Two of those matter to Phase 6 directly. `011` seeds 3,479 cards, so anything
that runs per card on a deck build is now on a hot path — which is what `012`
is: `phrase_zipf` had to become an index probe because a 30,000-row hash join
per call cost 14 seconds a deck. Score `phone_state` the same way, per probe
and not per phoneme-times-card.

The shape of the tables changed with them: `public.cards` is the *shared* deck
(no `user_id`, no review counters — `created_by` is authorship only, and unique
on `english` deck-wide), while progress is per user in `card_state`, keyed on
`(user_id, card_id, prompt_side)` and read back through the `card_progress` /
`cards_with_progress` views. `src/types/cards.ts` and `src/api/cards.ts` were
updated to match, and `npm run typecheck`, `npm test` and `npm run build` are
all green; Phase 6 will still touch `src/types/cards.ts` to widen `Side`.

The relevant precedent for Phase 6 is that `phone_state` is progress, not
reference data: it is per user, exactly like `card_state`, and its RLS policy
scopes to `user_id = auth.uid()` even though the words it scores are shared.

### What Phase 3 has to supply

The seam is narrow on purpose. The worker needs to return, and only:

- `logProbs` — the logits, `logSoftmax`'d, with `frames` and `vocabSize` read
  off the **actual** output tensor rather than computed from the §10.3 length
  formula.
- `labels` — the model's `vocab.json` list, index-aligned with the rows, for
  `buildTarget`.
- `blank` — from the model config's `pad_token_id`, not hardcoded.

Then `forcedAlign(logProbs, buildTarget(g2p(word).phones, labels), { blank })`
is the whole call, and the Phase 3 fixture test §Phase 3 asks for is an
assertion about boundaries on real speech — not on `say`, per §10.3.

---

## 13. Phase 3 results (2026-09-04)

Done, and this is the first phase whose result is a measurement rather than a
proof. The model runs, on the wasm backend, in a Worker, in a real browser,
from cache on the second load — and the alignment it feeds is byte-identical
to the Node run.

One new dependency, `onnxruntime-web@^1.29.0`, as §6 allowed. 41 new tests
(`npm test` is 161 green); `npm run typecheck` and `npm run build` clean.

### 13.1 What shipped

```
src/app/lib/acoustic/model-source.json   the model, its URLs, its size, its pad token
src/app/lib/acoustic/protocol.ts         the postMessage contract + labelsByRow
src/app/lib/acoustic/normalize.ts        zero-mean/unit-variance, and the 400-sample floor
src/app/lib/acoustic/session.ts          the inference core — no Worker, no DOM
src/app/lib/acoustic/weights.ts          Cache API, progress, stale-build sweep
src/app/lib/acoustic/worker.ts           browser plumbing only
src/app/lib/acoustic/model.ts            the main thread's handle
src/app/lib/acoustic/fixtures/           es-perro.wav + NOTICE.md + read.ts
src/app/lib/audio/wav.ts                 WAV decode, for fixtures and Phase 5's script
scripts/fetch-acoustic-model.mjs         npm run model:fetch -> .models/ (gitignored)
```

The deliverable is the shape §Phase 3 asked for, and it hands over exactly the
arguments Phase 2 needs:

```ts
const model = await loadAcousticModel({ onProgress });
const { logProbs, labels, blank } = await model.score(samples);   // 16 kHz mono
const spans = forcedAlign(logProbs, buildTarget(g2p(word).phones, labels), { blank });
```

**The one structural decision worth knowing:** `session.ts` holds all of the
inference and touches neither `Worker` nor the DOM, while `worker.ts` is
nothing but message plumbing. That split is what makes §Phase 3's "run the
fixture through Phases 1+2 and assert the boundaries" test possible at all —
`jsdom` has no `Worker`, so a test can only reach the model by going around
it. The plumbing is covered separately in `model.test.ts` against a fake port
(reply correlation, failures raised as `Error`s per the repo's API convention,
and the caller's audio buffer surviving the transfer).

The blank is still never written down: `model-source.json` names `<pad>` and
the row is looked up in the label list (§7).

### 13.2 Measured, in both runtimes

| | |
| --- | --- |
| q4f16 on the ORT **wasm** EP | works — decodes `p e r r o`, identical to §10.3's CPU-EP result |
| frame rate | 30 frames for 0.608 s = **49.4 fps**, so §4.3's 20 ms is right |
| inference, Node, 1 thread | 1 s audio → 1.05 s; 2 s → 1.79 s; 3 s → 2.55 s |
| inference, headless Chrome | 0.61 s clip in ~0.8 s |
| first load in Chrome | 197 MB, ~200 s on this connection, progress reported |
| **second load in Chrome** | **511 ms**, from the Cache API — the download happens once |
| alignment, Chrome vs Node | identical: `p[3,4) e[6,7) r[18,19) o[21,22)` |
| shortest input the model takes | **400 samples** (25 ms) |

So inference is roughly **0.9× realtime**, which settles two things: it belongs
off the main thread (a 2-second utterance would be ~90 dropped frames), and
Phase 7 needs a visible spinner rather than a snappy answer.

Below 400 samples ORT fails inside a `Conv` node with `Invalid input shape:
{1}`, which tells you nothing — hence the explicit floor and message in
`normalize.ts`.

The browser leg was driven through headless Chrome against the dev server
(Worker + Cache API + wasm, two passes to prove the cache). That harness was a
scratchpad throwaway, like the §10.6 one.

### 13.3 The finding: this model is peakier than §4.4 suggests, and duration is gone

The 30-frame posterior for the native *perro*, top labels per frame:

```
 3  p:-0.05  <pad>:-4.10        12  r:-0.19  <pad>:-2.09   ɾ:-3.66
 6  e:-0.05  i:-4.06            13  <pad>:-0.04  r:-3.41
 4-5, 7-11  <pad>:-0.00         18  r:-0.05  <pad>:-3.77   ɾ:-4.77
21  o:-0.06  <pad>:-3.73        22-29  <pad>:-0.00 … -0.24
```

**The blank is the argmax on 24 of 30 frames, at ~-0.00 on most of them.** A
frame handed to a phone therefore costs 8–10 nats, so max-likelihood Viterbi
gives each phone exactly **one** frame: `p[3,4) e[6,7) r[18,19) o[21,22)`.
Three consequences, and the first two are corrections:

1. **§4.5's "alignment also yields duration for free" does not survive this
   model.** Every span is 20 ms long, whatever was said, so duration is not the
   independent signal §4.5 counts on and Phase 5 must not treat it as one. If
   duration is wanted, it has to come from somewhere other than the best path
   — the obvious candidate is forward–backward *occupancy* (each state's
   posterior per frame) instead of Viterbi, which spreads credit across the
   blank-dominated frames rather than picking one. That is a Phase 5 design
   choice, not done here.
2. **§12.1 is corrected.** The trill's two peaks (frames 12 and 18) are
   separated by frames where the blank is -0.04 against /r/'s -3.41, so the
   aligner takes the sharper peak and leaves the other in the blank state — it
   does *not* hold one span across both. Phase 2's synthetic test asserts the
   fold, which is correct for a dip that keeps probability mass and wrong for
   this clip. Same rule, and the posterior decides which behaviour you see;
   both are now tested, and named accordingly.
3. **Span identities are trustworthy; span boundaries are a peak locator.**
   Which is fine, because identity is all GOP needs (§4.5) — but nothing
   downstream should read a boundary as the edge of a sound.

And the thing the project exists for does work. On the same audio, one phone
apart:

```
perro -> p[3,4) -0.05   e[6,7) -0.04   r[18,19) -0.05   o[21,22) -0.06
pero  -> p[3,4) -0.05   e[6,7) -0.04   ɾ[18,19) -4.77   o[21,22) -0.06
```

**4.7 nats between the trill and the tap on the same frame**, and *perro* beats
*casa* by more than 2 nats mean. The diagnosis §4.5 promises falls straight out.

### 13.4 Gotchas, all of them measured

- **`import "onnxruntime-web"` ships 28 MB of dead wasm.** The default entry
  references both the plain and the JSEP (WebGPU) binaries through
  `new URL`, so Vite emits `ort-wasm-simd-threaded.jsep.wasm` (27.8 MB)
  alongside the 14 MB one, with a 415 KB worker chunk. Importing
  **`onnxruntime-web/wasm`** emits only the 14 MB binary and a 77 KB chunk.
- That specifier has no `node` export condition, so it loads a model by
  `fetch` and a filesystem path fails with `Invalid URL`. Hence
  `SessionSpec.weights` takes **bytes only** — which is what the Cache API
  hands over anyway.
- **`ort.env.wasm.numThreads = 1` is mandatory.** Threaded wasm needs
  `SharedArrayBuffer`, which needs the page cross-origin isolated
  (`COOP`/`COEP`) — headers the Vite dev server does not send.
- **`ort.env.wasm.wasmPaths` must point at a Vite `?url` import**, or ORT looks
  for the binary next to the worker chunk, where there isn't one.
- **`npm run build` does not currently include the worker**, because nothing in
  the app imports `model.ts` yet — so that wiring is not covered by the normal
  build. Verified with a throwaway entry (a temp `vite.config` whose
  `rollupOptions.input` is a one-line file importing `loadAcousticModel`);
  Phase 7 makes it real.
- **Cross-realm `instanceof`**: a Node `Buffer` read under vitest's `jsdom`
  environment fails `bytes instanceof Uint8Array`, because the globals come
  from different realms. `wav.ts` uses `ArrayBuffer.isView`.
- **The Phase 0b spike read `vocab.json` from the *lv-60* repo while running
  xlsr-53 weights.** The two files are byte-identical (both espeak, 392 labels,
  `<pad>` = 0), so §10.2 and §10.3 stand — but that was luck, so `session.ts`
  now asserts the model's output width equals the label count.
- **There is no ASCII `g` label in the vocabulary at all** — only `ɡ` (U+0261).
  Asserted in the integration test, so the §7 trap is now a fact with a test
  behind it rather than a warning.

### 13.5 The fixture, and its licence

`src/app/lib/acoustic/fixtures/es-perro.wav` is Wikimedia Commons'
`Es-perro.wav` by user *UofG Language Modules*, **CC BY-SA 4.0**, downmixed and
resampled to 16 kHz mono and otherwise untouched. `fixtures/NOTICE.md` records
the attribution. Share-alike covers the audio, not this repo's code — worth
remembering if this ever stops being private.

Common Voice is still gated (§10.5), so Commons is the substitute, and its
coverage is as thin as §10.5 feared: of the Phase 1 verify words, only *perro*
exists. `Es-casa.wav`, `Es-cielo.wav`, `Es-jugar.wav`, `Es-guitarra.wav` and
`Es-tierra.wav` are all 404. **Open decision 5 still blocks Phase 5** and this
phase did nothing to unblock it. `say` remains unusable as a fixture (§10.3).

### 13.6 What Phases 4, 5 and 7 inherit

- **Phase 4** hands `model.score(samples)` a 16 kHz mono `Float32Array`. The
  client copies it before transferring, so the UI can keep the audio for
  playback. The session **throws** on any other sample rate rather than
  resampling — resampling is Phase 4's job, and silently scoring 44.1 kHz audio
  as if it were 16 kHz would be three-times-too-fast and wrong everywhere.
- **Phase 5** should use `npm run model:fetch` and drive `openSession`
  directly, exactly as `session.integration.test.ts` does — that is how the
  native stats end up generated with the same build the app runs (§10.3).
  `decodeWav` is there for the corpus clips.
- **Phase 7** needs a load state with a progress bar (first load is a real
  ~200 s wait) and a ~1–2 s scoring spinner. If that is too slow, the escape
  hatch is the WebGPU EP (`onnxruntime-web/webgpu`), not a smaller model.
- **Not done:** WebGPU, a warm-up inference (the first call carries ~0.3 s of
  graph setup), and a second fixture.

---

## 14. Phase 4 results (2026-09-04)

Done, and verified the same way Phase 3 was: driven through a real (headless)
Chrome, not only through `jsdom`. **Audio that goes in through the microphone
path comes out the other end decoding to the same phones as the file it came
from** — the whole point of the phase.

No new dependencies. 39 new tests (`npm test` is 200 green); `npm run
typecheck`, `npm run build` and `npm run lint` clean.

### 14.1 What shipped

```
src/app/lib/audio/recorder-worklet.js   the render-thread processor (plain JS on purpose)
src/app/lib/audio/capture.ts            getUserMedia + AudioContext + worklet, and the readback
src/app/lib/audio/resample.ts           chunk splice, and OfflineAudioContext -> 16 kHz
src/app/lib/audio/trim.ts               energy endpointing — the pure, tested part
src/app/lib/audio/recorder.ts           the state machine, with every browser API injected
src/app/lib/audio/useRecorder.ts        the React seam, and nothing else
```

The path is §Phase 4's, in order: AudioWorklet → batches over `postMessage` →
splice → `OfflineAudioContext` to 16 kHz → energy trim. It hands Phase 3
exactly what §13.6 says it wants:

```ts
const recorder = createRecorder();
await recorder.arm();                       // once, on entering the deck
recorder.start();                           // on press
const { samples } = await recorder.stop();  // 16 kHz mono, trimmed
const { logProbs, labels, blank } = await model.score(samples);
```

**Two structural decisions worth knowing.**

*The mic is opened once and left open*, for the whole time the deck is on
screen, and `recorder.ts` decides which batches belong to an attempt. Opening
it per attempt costs a device start — hundreds of milliseconds during which the
hardware delivers nothing — so the first phoneme of every card would be
clipped. It also gives the level meter something to show *before* the learner
commits, which is how they find out the mic works.

*Every browser API is injected with a real default*, the same trick
`loadAcousticModel`'s `port` uses. That is what makes `recorder.test.ts`
possible at all: 16 of the 39 tests drive the whole state machine — cap,
cancel, flush, the silence path — against a fake microphone in `jsdom`, which
has no `AudioContext` (§5). `capture.ts` and `resampleTo` are the residue that
genuinely cannot be tested here, and they are deliberately the two smallest
files.

### 14.2 Measured, in a real browser

Headless Chrome with `--use-file-for-fake-audio-capture=es-perro.wav`, so the
fixture is played *into* the microphone and comes back out through the real
capture path. Then the captured buffer was run through the real q4f16 weights
in Node, exactly as `session.integration.test.ts` does.

| | |
| --- | --- |
| hardware rate | 48 kHz, 2 channels (see below) |
| captured | 1.952 s → 31 232 samples at 16 kHz |
| trim | kept `[0, 10 240)` — 640 ms, floor -59.3 dB, threshold -47.4 dB, peak -11.7 dB |
| level meter | 40 readings in 2 s, peak 0.59 |
| decode of the captured audio | **`p e r r o`** |
| alignment | `p[3,4) e[5,6) r[18,20) o[21,22)` |
| §13.2, straight from the file | `p[3,4) e[6,7) r[18,19) o[21,22)` |

One frame of drift on /e/ and a trill span one frame wider, from a round trip
through a 48 kHz stereo device, a downmix, a resampler and a trim. **The
capture path is transparent to the aligner**, which is the claim this phase had
to make.

The trim did its job on the same clip: 1.95 s in, 0.64 s out, and the 0.61 s
fixture is 0.61 s of that. The 1.3 s of trailing silence the fake device
produced after the file ended is exactly the 65 frames the aligner would
otherwise have had to spend on *perro*'s four phones.

### 14.3 The findings

1. **`track.getSettings().sampleRate` and `AudioContext.sampleRate` disagreed** —
   44 100 against 48 000, on the same device in the same run. The samples are
   whatever the context says, because that is the graph the worklet runs in, so
   the resampler reads `context.sampleRate` and the track's is diagnostic only.
   Taking the track's would have resampled 48 kHz audio as if it were 44.1 kHz:
   a ~9% speed error, no exception, and every vowel slightly wrong.
2. **The §10.6 constraint readback fired again, on the first run of the new
   code**: `channelCount: 1` requested, two channels delivered. So the downmix
   in the worklet is load-bearing rather than defensive — taking channel 0
   would silently throw away half of a device that ignores the constraint. The
   other three constraints were honoured.
3. **`stop()` dropped the tail of every recording**, until a test caught it.
   Clearing the "recording" flag before asking the worklet to flush means the
   flushed batch arrives with nothing listening, so up to 43 ms — a whole
   consonant — vanished off the end of each attempt. The flag now clears in a
   `finally` after the flush. This is the bug §Phase 4 exists to have found in
   a test rather than in a mispronunciation score.
4. **The "nothing was recorded" path is real, not theoretical.** The first
   headless run failed to read the WAV (Chrome's sandbox) and delivered digital
   silence, and the recorder answered "I didn't hear anything — check the mic
   and try again" rather than scoring a page of failed phonemes. That is the
   §10.6 failure mode, reproduced by accident and handled.

### 14.4 Gotchas, all of them measured

- **A `SharedArrayBuffer` ring is unavailable**, for the same reason ORT runs
  single-threaded (§13.4): no `COOP`/`COEP` from the dev server. The ring lives
  *inside* the processor instead — a fixed buffer that fills, is posted and
  transferred. One message per ~43 ms at 48 kHz.
- **The worklet has to stay plain JavaScript.** `?url` emits the file verbatim,
  with no transpile: a `.ts` file there would ship TypeScript to the browser.
  Verified in a real build — 3.24 kB, its own hashed asset, `node --check`
  clean, referenced by hash from the bundle.
- **`?url&no-inline`, because 3.24 kB is under Vite's 4 kB inline threshold.**
  Chrome's `addModule` *does* accept a `data:` URL (measured, against the
  assumption) — but a real file keeps the processor on the page's origin and
  visible in devtools, which is worth 3 kB.
- **`npm run build` still does not include this code**, for §13.4's reason:
  nothing in the app imports it until Phase 7. Verified the same way, with a
  throwaway entry importing `useRecorder`.
- **`copyToChannel` is typed for a `Float32Array` over a plain `ArrayBuffer`**
  and rejects one that has been through a transfer; `getChannelData().set()` is
  the same operation without the argument.
- **Chrome needs `--no-sandbox` to read the fake-capture WAV.** Harness-only,
  but it costs a confusing run: without it the device delivers silence and the
  failure looks like the app's.
- **The level is a ref, not state** (`FlashCard`'s rule in `CLAUDE.md`). It
  moves 23 times a second; a `setState` per batch re-renders the card
  throughout the recording.

### 14.5 What Phases 5 and 7 inherit

- **Phase 7** gets `useRecorder`: `state` (`idle → arming → ready → recording →
  processing`), an `error` string already phrased for a learner, `level` to
  read in rAF, and `stop()` returning `{ samples, full, durationMs,
  endpoints, truncated }`. `full` is the untrimmed take, kept so the learner
  can hear what the model heard. `arm()` must be called from a press — a
  suspended `AudioContext` yields no samples and looks exactly like a silent
  room.
- **Phase 5** can ignore all of this: `gen-native-stats` reads corpus files
  with `decodeWav` and drives `openSession` directly (§13.6). The trim is worth
  reusing on those clips, though — a corpus clip has leading silence too, and
  the native GOP distribution should be measured on the same shape of input the
  app will hand it.
- **Not done:** no waveform or spectrogram for the UI (the level peak is all
  that is exposed), no "press and hold" versus "click to start" decision — that
  is Phase 7's — and no test of a second device. The trim's constants are
  tuned against one clip and one fake device; they are all named and in one
  place at the top of `trim.ts`.

---

## 15. Phase 5 results (2026-09-06)

Done, and the honest headline is that **it was already written when this
session picked it up, and its own tests were failing.** `gop.ts`,
`gop.test.ts`, `gop.integration.test.ts`, `native-stats.generated.ts` and
`scripts/gen-native-stats.mjs` were all committed and complete; the calibration
in them was built from **2 clips**. The integration test asserts `clips > 100`
and `n >= 30` per phone and was red — but it is `describe.skipIf(!available)`
on `.models/` being present, and `.models/model.onnx` was a symlink into a
previous session's scratchpad, which had been cleaned up. So `npm test`
reported 207 passed, 18 skipped, and the gap was invisible.

**Worth carrying forward as a rule: a suite that skips its only real check when
an artefact is missing will report green on the day the artefact goes away.**
`npm run model:fetch` restores it; the skip is still the right call for a
6-second default run, but the two calibration assertions are what make the file
mean anything.

### 15.1 What Phase 5 actually shipped

The design is §Phase 5's, and two decisions in it are better than the brief:

- **GOP's sign is flipped from Witt & Young.** The textbook takes the max over
  *all* labels including the target, so a correct phone scores exactly 0 and
  every clean phone looks identical. Excluding the target from its own rival
  set makes a confident hit *positive* — +3 to +5 nats on native clips against
  about -3 for a tap heard where a trill was wanted — which is where the
  z-score needs its resolution.
- **The flag line is the measured 5th percentile, not `mean - 1.64σ`.** GOP is
  bounded above and has a long left tail, so the two disagree, and only the
  empirical one means what it says. `z` is still reported because "2.4σ below
  native" is a sentence a person can read.

`summarise` gained a companion this session, `PASS_SCORE = 0.8` — what
`card_reviews.knew` is cut on. Calibrated the same way as the flag line and for
the same reason: a native trips the per-phone flag about once in twenty phones
by construction, so a ten-phone sentence would fail a native two attempts in
five if one flag were disqualifying.

### 15.2 Open decision 5 is resolved: FLEURS, not Common Voice

Recorded in the generator's header and worth repeating here. Common Voice is
gated (§10.5). **Lingua Libre on Wikimedia Commons looked ideal and is not** —
`upload.wikimedia.org` answers a few hundred bulk originals with `429 Too many
requests - please contact noc@wikimedia.org to discuss a less disruptive
approach`, which is a service asking not to be used that way.

**FLEURS `es_419`** is the answer: Latin American read speech at 16 kHz with
normalised transcripts (so no text cleaning), CC BY 4.0, ungated, on a host
that serves bulk data by design. 408 sentences in the dev split, ~100 phone
spans each.

Note `gop.ts`'s header still said "Lingua Libre" this session; corrected.

### 15.3 The generator needed one real fix

`streamClips` inflated the 255 MB archive straight off the socket and abandoned
the connection once the quotas were met — a good idea when a handful of
sentences will do, and the wrong one here. Filling every phone's quota takes
**~170 of the 408 dev sentences**, so most of the archive is transferred
anyway, and a long-lived stream deliberately left half-read gets dropped: a run
died on `UND_ERR_SOCKET: other side closed` after 22 MB and forty sentences,
losing twenty minutes of inference with nothing written.

Now: fetched to `.cache/` with `Range` resume, then read from the file. A
dropped connection resumes instead of restarting, and the *second* run — the
one that happens whenever the model build changes and §10.3 says the stats must
be regenerated against it — touches the network not at all.

`--dry-run` is the cheap way to size a run before committing to it: it reports
what the transcripts alone would cover, without fetching a byte of audio.

### 15.4 The calibration that is now committed

`npm run stats:native -- --clips=250 --quota=70`, against the q4f16 build the
app runs. **165 clips, 20,004 phone spans**, ~45 minutes of inference; 187
sentences were skipped because everything in them had already met its quota,
which is what keeps it to 165 rather than 408.

All 24 units are covered and every one clears the `n >= 30` bar the integration
test asserts. Coverage is as lopsided as Spanish text is: `ɲ:40 tʃ:60 ʝ:101
r:113 x:128` at the thin end against `a:2562 e:2744`.

**And the numbers make §4.6's case better than the argument did.** Native means
per phone, in nats:

```
l 6.37   m 6.17   n 5.83   i 5.32   t 5.24   a 5.17   p 5.17   k 5.11
s 4.80   f 4.96   d 4.51   e 4.52   u 4.51   o 4.67   x 3.57   j 3.02
tʃ 2.79  ɾ 2.77   b 2.58   w 2.25   ɲ 2.01   g 2.02   r 0.41   ʝ -1.76
```

A native's /l/ beats its best rival by 6.4 nats and a native's /r/ by 0.4 — and
a native's /ʝ/ *loses* to something, on average. A single global threshold set
anywhere in that range would nag about /r/ and /ʝ/ forever and never catch a
botched /l/. This is the entire reason verdicts are cut per phone.

`ʝ` being negative is worth a second look by whoever next touches the
inventory: yeísmo /ʝ/ genuinely crowds /i/ and /j/, and it may be that the
`ʎ` merge is pulling it down. It is calibrated either way — a learner is
compared against where natives actually sit — but it is the phone most likely
to be measuring the inventory rather than the mouth.

Clip means ran 3.33 to 5.43 with a median of 4.75, so `CLIP_FLOOR = -4`
discarded nothing: the cut is far below where real clips sit, which is what it
is meant to be.

---

## 16. Phase 6 results (2026-09-06)

Done. `013_pronunciation.sql`, plus `Side` widened and the api boundary
extended. `npm run db:reset` clean.

### 16.1 What shipped

- `'pronounce'` is a legal `prompt_side` on `card_reviews` and `card_state`. A
  third *direction*, not a new keying scheme, exactly as §2 requires — so it
  gets its own streak and its own interval out of machinery that already
  exists.
- `card_reviews.score real` and `card_reviews.phone_scores jsonb`, both
  nullable, both additive; append-only is undisturbed.
- **A guard the brief didn't ask for**:
  `check (prompt_side = 'pronounce' or (score is null and phone_scores is
  null))`. A translation review has no pronunciation in it, and without this a
  client bug could file a mis-sided row that `phone_state` would then silently
  count. `recordReview` drops the payload for a non-pronounce side rather than
  letting the server reject the whole insert for what is a caller mistake.
- `phone_state` — per user, per phoneme: `attempts`, `hits`, `nears`,
  `misses`, and running `gop_sum` / `gop_sq_sum`.
- `apply_phone_scores()`, a **second** `after insert` trigger rather than an
  extension of 009's `apply_review()`. They share nothing but the row that
  fired them, and neither reads the other's table.

### 16.2 Four decisions inside that

1. **The three verdicts are kept apart rather than folded into
   successes/failures.** A near miss (a glide heard as its full vowel) is
   genuinely not the same evidence as a wrong sound, and Phase 8 should get to
   decide what a Beta posterior counts as a success rather than inheriting the
   choice from the schema. Phase 8 duly counts a near miss as half to each side.
2. **Moments, not a stored mean.** `gop_sum` and `gop_sq_sum` stay exactly
   additive under an append-only log; a running mean does not.
3. **One observation per aligned span.** A word with three /a/ in it counts
   three times, because they are three separate goes at the sound. Verified
   against the real trigger.
4. **`card_progress` now excludes `'pronounce'`.** Without this a pronunciation
   session inflates "times seen" on every card it touches, and the card list
   reports 40/40 lifetime on a card whose meaning you cannot recall. Saying a
   word and knowing what it means are different claims. The view's column list
   is unchanged, so `cards_with_progress` and `study_deck` needed no edit.

### 16.3 The §Phase 6 trap, and a second one next to it

The brief's trap — `distinct on (r.id)` in `study_deck` will start dealing
pronunciation prompts in place of translation prompts the moment `'pronounce'`
is eligible — is handled as instructed: `SIDES.pronounce = ['pronounce']`, a
separate deck mode, a fourth option on `DirectionPicker`.

**There is a second one the brief does not mention.** `new_limit` caps unseen
*cards* at 5 per deck. In pronunciation mode every card in the deck is unseen,
because only the direction has never been asked — so the cap deals a deck of
**five**. The cap exists to stop new *material* swamping a session, and in this
mode nothing is new material: the words are ones already being learned. Hence
`newLimitFor(direction)`, and `DECK_SIZE` in pronunciation mode.

### 16.4 On the TypeScript side

`Side` gains `'pronounce'`, and `toDeckEntry` gets `toSide()` instead of
`row.prompt_side === "spanish" ? "spanish" : "english"` — an unrecognised value
now throws rather than silently dealing an English prompt.

`FlashCard.promptSide` is narrowed to `Exclude<Side, "pronounce">`, and
`Study.tsx` branches on `current.promptSide === "pronounce"` rather than on the
picker's `direction`. That is what makes "a pronunciation prompt never reaches
the two-faced card" a compile-time fact rather than a hope: branching on
`direction` would not have narrowed the type, and `FlashCard` would have fallen
through to its ES→EN branch.

`PhoneScoreRow` is a `type`, not an `interface`, and that is load-bearing: only
a type alias gets an implicit index signature, so only a type alias is
assignable to the generated `Json` the jsonb column is typed as.

---

## 17. Phase 7 results (2026-09-06)

Done. `src/app/lib/phonology/feedback.ts`,
`src/app/lib/pronounce/usePronunciation.ts`, `src/components/PronounceCard.tsx`
and the `Study.tsx` wiring. 31 new tests. No new dependencies.

### 17.1 The decisions the brief left open

**Hold to talk**, not click-to-start/click-to-stop (§14.5 deferred this here).
An utterance is one or two seconds; a mode you have to remember to leave is a
worse fit than a button you hold, it makes "I am recording" unambiguous, and a
release is a natural commit in the same way the swipe is on `FlashCard`. Space
does the same, with an `event.repeat` guard — without it a held key restarts
the recording thirty times a second. The endpoint trim absorbs the slack at
both ends, so nobody has to be precise.

**Both faces are shown.** The other two directions hide the answer because
recall is what is being tested; here it is not. An attempt you cannot start
because you have forgotten the word measures recall a second time and
pronunciation not at all — so the target is on screen, syllabified, with the
stress marked, which is information the learner needs anyway and which G2P
already knows.

**The syllables are the meters.** The prompt and the result are the same
component, so the feedback lands on the syllable the learner was already
looking at and the layout does not jump.

### 17.2 Three states the UI has to have, and why

- **A progress bar, not a spinner**: the first load is 197 MB and ~200 s
  (§13.2). It says how many megabytes, and that it happens once.
- **A scoring state of a second or so**: inference is ~0.9x realtime.
- **A blocked state**: G2P throws on a card it cannot pronounce, by design
  (§11), and a deck of 3,479 seeded cards will contain one. `prepare()` runs
  before the record button is offered, so the card says so up front rather than
  after the learner has said it. The scorer is never reached with a bad target
  — asserted in the tests, because a mis-aligned target reads back as the
  learner's mistake.

### 17.3 What `feedback.ts` adds beyond the brief

`groupByWord` folds the scorer's flat list back onto G2P's syllables and
refuses a list that is not this target's. `diagnose` turns one score into a
sentence, in four escalating steps: a **named pair** ("that was a tap, not a
trill"), then a rival that is **not a Spanish sound at all** ("that was an
English *r*" — `ɹ`, which §10.3 found the unrestricted rival set produces and
which is the case where not restricting rivals to Spanish is load-bearing),
then the bare comparison, then a generic miss. Each carries an articulation
hint where there is a specific one.

The advice table is the one part of this project that is a Spanish teacher's
judgement rather than a measurement, and it is in one place, commented as such,
so it can be argued with.

### 17.4 Phase 7 closed the §13.4 / §14.4 build gap

Both phases recorded that `npm run build` did not cover the worker or the
worklet, because nothing in the app imported them, and both verified the wiring
with a throwaway entry point. It is real now: the production build emits
`worker-*.js` (76.6 kB), `recorder-worklet-*.js` (3.24 kB) and **only** the
14 MB wasm binary — the `onnxruntime-web/wasm` specifier is holding, and the
27.8 MB JSEP build §13.4 warned about is not in the bundle.

### 17.5 Testing a hook without a testing library

`usePronunciation` is covered by 11 tests against an injected model and an
injected microphone, driven through a ~15-line `act` harness over
`react-dom/client`. React 18.3 exports `act` itself, so one hook did not need a
new dependency. What is asserted is sequencing — a card G2P refuses never
reaches the model, a silent room says "I didn't hear anything" rather than
scoring a page of failed phonemes, the weights load once however many times
`arm` is called, the worker is closed on unmount, progress is observable
*during* the load and not merely summarised after it.

The fake model enforces the real session's contract (16 kHz only, §13.6), so a
test cannot pass on audio the app would have refused.

---

## 18. Phase 8 results (2026-09-06)

Done. `014_phone_scheduling.sql` (hand-written), `015_seed_phrase_phones.sql`
(generated), `scripts/gen-phrase-phones.mjs`, and the api writes that keep it
current. This is the phase the plan calls the payoff, and it is also the one
whose brief turned out to be missing a piece.

### 18.1 The gap in the brief: SQL cannot see a card's phonemes

§Phase 8 says "predict a new card's pronunciation difficulty from its phonemes
… **stays in SQL** — this is a migration, not client code", and that is right.
But **the database has no idea what phonemes a card contains.** G2P is ~400
lines of TypeScript context rules and is not going to be rewritten in plpgsql.
The plan simply assumes the phones are reachable from a query. They were not.

Resolution: `public.phrase_phones`, keyed on **the Spanish text** rather than on
a card id.

- derived from the text and nothing else, so two cards with the same Spanish
  share a row and an edit simply misses until it is refilled;
- `public.cards` is the shared deck (009), and a derived cache does not belong
  on a row two people are editing;
- it makes this exactly the `word_frequency` / `phrase_zipf` shape — reference
  data, probed by key, never joined in bulk — which §12 explicitly says to
  follow.

Filled for the seed deck by 015 and by `src/api/cards.ts` for anything typed in
afterwards. `rememberPhones` is never allowed to fail a card write: a card the
app cannot pronounce is a perfectly good card in the other two directions.

**The generator reads the deck from the database, not from
`011_seed_cards.sql`.** Parsing a megabyte of generated SQL string literals to
recover the values was tried first and came back with **3,463** of the 3,479
cards, with no indication which sixteen were wrong. The deck is deterministic
given 011, so reading it back after a reset is the same data with none of the
guessing. 3,407 distinct card faces, **0 refused by G2P**, and the script
refuses to write below 95% coverage — the same shape of guard
`gen-seed-cards.py` puts in front of its conjugations.

### 18.2 Thompson sampling, and the one approximation

`phone_ability()` draws once per phoneme per deck build — not once per card,
which would be noise rather than sampling. `alpha = 1 + hits + nears/2`,
`beta = 1 + misses + nears/2`; an unpractised phone has no row, takes Beta(1,1)
and can come back anywhere, which *is* the exploration term §4.7 asks for, with
no separate bonus bolted on.

**The Beta is sampled through its normal approximation**, via Box-Muller.
Postgres has no gamma sampler and writing Marsaglia-Tsang in plpgsql for a term
that only has to rank cards is a lot of machinery. The approximation is worst
exactly where the Beta is most skewed — few observations — so the draw is
clamped to (0,1) and the residual error makes a barely-seen phone explore
slightly *less* eagerly than a true Beta would. That is the safe direction.

`ability` is `as materialized` in `study_deck` on purpose: without it the
planner is free to re-evaluate a volatile function per row, and every card
containing /r/ would be judged against a different belief about /r/.

**And `phone_ability()` returns a draw for every phoneme the deck uses, not
only the ones with a row in `phone_state`.** The cheaper version returns what
`phone_state` has and lets the caller `coalesce(a.ability, random())` for the
rest, which looks equivalent and is not: `random()` in the caller's join is
evaluated once per *occurrence*, so an untried phoneme gets a different draw in
every phrase containing it. That is noise rather than sampling, and it lands on
exactly the phonemes exploration exists for. The universe is a distinct over
the unnested `phrase_phones` — 24 labels, matching `PHONES` in `inventory.ts`
— so it cannot drift out of step with the inventory either.

### 18.3 Three attempts, and the first two silently did nothing

This is the part worth reading. Each attempt typechecked, applied cleanly and
looked reasonable; the first two changed the dealt deck not at all, and only
measurement said so.

| attempt | urgency for an unseen pronounce card | measured |
| --- | --- | --- |
| 1 | `least(0.95, greatest(0.55, 1 - avg(ability)))` | every card floors at 0.55 — inert |
| 2 | `0.55 + 0.40 * (1 - min(ability))`, top-N gate | 3 decks of 20 shared **21 distinct cards** |
| 3 | `greatest(0.05, 1 - min(ability))`, raced gate | **32% of dealt cards carry a weak sound vs a 10.6% base rate; 279 distinct cards over 15 decks** |

**Attempt 1 — the clamp deleted the feature.** A learner who says most sounds
well predicts ~0.95 on nearly every card, so `1 - avg` is ~0.05 for all of them
and every card pinned to the floor. Two separate faults: the clamp, and the
mean.

The mean is the better *predictor* — `summarise` scores an attempt as the share
of phonemes that came back clean, so a mean of per-phoneme success
probabilities predicts the very number the attempt produces — and it is the
wrong thing to *schedule* on. Every Spanish card is mostly vowels and /s/ and
/n/, which a learner got right weeks ago, so one hopeless /r/ in a six-phone
word moves the mean from 0.95 to 0.80 and the card ends up 1.1x more urgent
than a card with no /r/ in it. Measured with /r/ and /x/ at 2 hits in 60: a
40-card deck contained **none** of the 10.6% of faces that use them.

A card is worth saying because of its hardest sound. `min` says that, and the
saturation it is accused of is the correct answer: while /r/ is the weak sound,
every card containing one *is* about equally worth practising.

**Attempt 2 — `min` plus a ranking gate is the failure mode §4.7 names.**
`new_cards` took the top N by weight, which in 010 was equivalent to ranking by
utility because every unseen row had the same urgency. With a *differentiated*
urgency it becomes a sort, and "preserve the sampling; do not replace it with a
sort" is exactly the rule it breaks. Three consecutive 20-card decks contained
21 distinct cards between them: a stable weakness produces a stable ranking, and
the same twenty cards come up until it is fixed. This is the same lesson 008
learned about the deck as a whole, rediscovered one CTE further in.

So the pronunciation gate now draws the same exponential race the deck itself
uses. **Translation decks keep the ranking**, and the asymmetry is real rather
than timid: the top unseen cards by utility is a *curriculum* — the commonest
unseen words first — which is what you want when the thing being learned is the
word. Nothing is a curriculum in pronunciation mode; the words are already
being met in the other two directions and only the sounds are new.

**Attempt 3 — the band had to go.** Racing on attempt 2's weights gave lovely
variety and no targeting: 11.3% of dealt cards carried a weak sound against a
10.6% base rate. The band `[0.55, 0.95]` spans 1.9x where utility already spans
6.7x (Zipf 3 to Zipf 6), so weighted sampling barely noticed it.

The fix is to stop pretending an unseen pronunciation prompt is like an unseen
translation prompt. **010's 0.85 floor deliberately does not carry over**, and
that is the whole difference between the two kinds of "unseen": an unseen
translation prompt is new *material* and has to be high or new cards never get
learned, while an unseen pronunciation prompt is a word the learner already
meets twice — only our recording of them saying it is missing. If every sound
in it is one they reliably produce, it genuinely is not urgent.

### 18.4 Measured

On a plausible profile (most phones 72/80, /r/ 14/40, /x/ 6/25):

| | |
| --- | --- |
| dealt cards carrying /r/ or /x/ | **32%**, against a 10.6% base rate — a 3x lift |
| distinct cards over 15 decks of 20 | 279 of 300 dealt; most-repeated card appeared 3 times |
| `study_deck(20, 20, ['pronounce'])` | **69 ms** |
| `study_deck(20, 5, ['english','spanish'])` | 81 ms, unchanged |
| cold start (no `phone_state` at all) | 9.4 phones per dealt card against a 11.3 deck average — no bias towards long words |

The timing is the §12 constraint met: the prediction is computed once per
distinct phrase and only when `'pronounce'` is among the sides, so it adds
nothing measurable over the 012 baseline.

**A trap for whoever measures this next.** `select ... from
generate_series(1,15) g, lateral study_deck(...)` does **not** give fifteen
decks — it gave 20 distinct cards across 300 rows, because the planner reused
one evaluation. It reads exactly like a catastrophic diversity failure. Drive
the repetitions from a `do $$ ... $$` loop instead.

### 18.5 What is deliberately still not done

- **Pronunciation does not compete for deck slots** (open decision 3). 013's
  reasoning stands: `distinct on (r.id)` means admitting it to the default
  sides lets a pronunciation prompt displace a translation prompt, silently
  changing a working scheduler on the strength of scores nothing has validated.
- **A card that *has* been pronounced schedules on its own history**, not on
  its phonemes. Direct evidence about this card beats a prediction from its
  parts once there is any; the prediction is worth having precisely where there
  is none.
- **The second normalisation of §4.6 — against the learner's own microphone —
  is collected but not spent.** `phone_state.gop_sum` / `gop_sq_sum` are
  accumulating exactly so it can be, and `gop.ts` says where it would go.
- `g2p_version` exists on `phrase_phones` so a G2P rule change can be found and
  refilled; nothing reads it yet.

### 18.6 Where the §8 open decisions were settled

| # | Decision | Settled |
| --- | --- | --- |
| 1 | Plan A or plan B | §10.1 — plan A |
| 2 | Native stats as a TS module or a migration | Phase 5 — TS module, `native-stats.generated.ts` |
| 3 | Does pronunciation compete for deck slots | Still no, and now with 013/014 in place to revisit it from |
| 4 | Score threshold | §15.1 — the measured 5th percentile per phone, plus `PASS_SCORE = 0.8` for the attempt |
| 5 | Where native audio comes from | §15.2 — FLEURS es_419 |
| 6 | Merge `ʎ`→`ʝ` and `θ`→`s` | §11 — merged, as recommended |

---

## 19. The scorer service (2026-09-09)

§3 rejected running inference on a server, and this section is where that
decision gets amended rather than overturned. The four reasons it gave are
still true; one of its *assumptions* is not.

### 19.1 What changed

§3 assumed the device could hold the model. On the machines the feature was
built and measured on it can. On a 3–4 GB Android phone it cannot: 197 MB of
weights are resident for the life of the session, the cold path peaks at
roughly twice that (`weights.ts` accumulates the chunks and then copies them
into a second full-size buffer before ORT sees any of it), and the tab is
killed. On that phone "runs entirely on the device" is not a stricter version
of the feature. It is the absence of one.

So the claim narrows, on purpose, and the wording in `CLAUDE.md` narrows with
it: **pronunciation runs on the device wherever the device can hold it.**
Where it cannot, a scorer service runs the identical model and the identical
code, and the learner gets working feedback instead of a dead card.

What did *not* change, and what §3 still gets right:

- **The laptop still runs it locally.** No API, no key, no per-use cost — this
  is a fallback, not a migration, and `VITE_SCORER_URL` unset restores the
  pre-§19 behaviour exactly.
- **Streaming is still rejected** (§3). The wire carries a whole utterance.
- **Transcribe-and-compare is still rejected** (§3), which is what rules out
  every free hosted speech API: they return words, and this needs a posterior
  matrix. That is why the box is ours rather than someone's endpoint.

### 19.2 The shape

`protocol.ts` was already written as "the one seam between the app and
whatever is actually doing the inference", and that is what made this cheap.

```
                 ┌─ worker.ts ────── session.ts ─┐
samples ─────────┤                               ├──▶ logProbs ──▶ align ──▶ GOP
  backend.ts     └─ remote.ts ──HTTP── scorer.ts ─┘        (client, either way)
```

Both branches satisfy `AcousticModel`, so nothing downstream can tell which
one it got. Three properties are load-bearing:

- **The server returns log-probabilities, not scores.** No alignment, no GOP,
  no phonology on the box. All of that stays in the browser where it is
  already tested and where `native-stats.generated.ts` lives, so there is
  exactly one implementation of the scoring and the box cannot drift from it.
- **The server imports the app's own `session.ts`**, through the same
  `scripts/ts-loader.mjs` the generators use. Not a port, not a copy — the
  same file. A separately-maintained server implementation is precisely the
  drift that would make every verdict quietly wrong.
- **The client checks the build.** `GET /model` returns the source `id` and
  the labels, and `remote.ts` refuses a server whose `id` is not the one the
  app expects. A box on last month's weights would return labels that align
  perfectly well and score against the wrong calibration — a silent failure,
  so it is made loud.

Labels come from the server rather than from HuggingFace for the same reason:
`openSession` throws when a vocabulary and a set of weights disagree, and it
can only throw on the machine holding both (§10.2).

### 19.3 The calibration constraint

**Both sides must run the same execution provider**, not merely the same
weights. §4.6 z-scores against `native-stats.generated.ts`, and a systematic
quantization bias cancels only if the reference and the runtime were produced
the same way. §13.2's "Chrome vs Node: identical" was wasm-vs-wasm and is
*not* evidence that ORT's native EP agrees.

So the scorer runs `onnxruntime-web/wasm` — the same import the browser uses —
and the hybrid is safe to mix per device. Measured end to end, through
`RemoteAcousticModel` against the real service, on the §13 fixture:

```
aligned : p[3,4) e[6,7) r[18,19) o[21,22)
§13.2   : p[3,4) e[6,7) r[18,19) o[21,22)
```

Identical. If the scorer is ever moved to `onnxruntime-node` for speed, that
is a different EP and `npm run stats:native` must be regenerated against it —
and then a device and a box no longer produce comparable numbers, so the
backend would have to be pinned per user rather than chosen per session.

### 19.4 Measured, and the part that did not work

| | |
| --- | --- |
| weights resident, Node, from `.models/` | 568 ms |
| `POST /score`, 0.608 s fixture, end to end | 795 ms |
| inference, 1 s of audio, 1 thread | ~1250 ms |
| frames returned for the fixture | 30 — matches §13.2 |
| alignment vs the on-device result | identical |
| **ORT wasm with `numThreads > 1` under Node** | **does not start** |

The plan was to take the four cores the box has, since Node has
`SharedArrayBuffer` unconditionally and the browser's COOP/COEP obstacle does
not apply. It does not work: ORT's threaded build constructs its workers from
a URL it then fetches, Node's `fetch` does not do `file:`, and every
configuration fails identically with

```
no available backend found. ERR: [wasm] TypeError: fetch failed
```

Supplying `env.wasm.wasmBinary` fixes the *main* module's lookup — which is
required, and is what `scorer.ts` does, mirroring `worker.ts`'s `wasmPaths` —
and does nothing for the workers'. `wasmPaths` as a `file:` URL fails the same
way. So `numThreads` stays 1, `SessionSpec.numThreads` exists as the knob a
native-EP follow-up would turn, and **the box is slower than the laptop**.

That is worth being blunt about, because it inverts the usual reason for a
server: this one is not for speed. It is for the 197 MB. Anyone reaching for
`onnxruntime-node` to fix the speed should read §19.3 first and budget for a
`stats:native` regeneration.

### 19.5 Choosing, and what it costs

`backend.ts` decides in three steps: an explicit per-device preference, then
`navigator.deviceMemory <= 4`, then failure. The heuristic is the weak part
and is known to be — Chrome and the Android WebView report `deviceMemory`,
Safari and Firefox report nothing, so it catches the Samsung and misses an old
iPhone entirely. That is what the third step is for: a device path that throws
falls through to the scorer rather than telling someone their phone cannot do
pronunciation.

Auth is a Supabase access token verified on the box, HS256 or JWKS depending
on how the project signs (`server/auth.ts`), for the same reason `translate`
has `verify_jwt = true`. An open endpoint doing 1.25 s of CPU per request is a
free denial-of-service and, once found, free inference.

### 19.6 Not done

- **`weights.ts` still double-buffers the cold download.** `chunks` plus a
  second full-size `Uint8Array` is a ~394 MB peak before ORT parses anything,
  which is very likely what kills the phone on the download that was supposed
  to be a one-off. Sizing one buffer from `source.bytes` roughly halves it.
  Worth doing regardless of the scorer — it is the difference between a device
  that fails at step one and one that gets a fair try.
- **Nothing prefetches.** `arm()` still fires on the first press-and-hold, so
  the on-device path pays its ~200 s at the worst possible moment even though
  `SIDES.pronounce` makes the need certain the moment the mode is chosen.
- **`navigator.storage.persist()` is still not called**, so the Cache API
  entry is evictable and the "once per device" download is not.
- **No UI for the preference.** `writePreference` exists and nothing calls it.
- **The scorer is one box with no failover**, which is the right amount of
  infrastructure for two people and worth writing down as a choice. §19.7 is
  what that choice cost and what was done about it.

### 19.7 What happens when the box isn't there (2026-09-20)

§19.6 recorded "one box with no failover" as an acceptable choice. It is, for
the box. It was not acceptable for the *client*, because the fallback in
§19.5's rule 3 only ran one way: a device that failed locally fell through to
the scorer, and a device routed to the scorer had nowhere to go. An Always Free
Oracle instance is reclaimed when idle (`infra/README.md` §1) and two people
studying does not clear the utilisation bar, so "the box isn't there" is a
normal state, not an incident.

`loadAcousticBackend` now falls through in both directions, and `routeBackend`
exists to keep the *reason* for a routing decision, because that is what
decides whether the other path is worth trying:

| Routed to the scorer by | Scorer fails | Why |
| --- | --- | --- |
| an explicit preference | try the device | a preference is not a verdict about memory |
| a browser that won't report memory | try the device | Safari and Firefox say nothing; that is not evidence |
| `deviceMemory <= 4` | report it | the one case where the device *was* measured unable |

The last row is the asymmetry worth defending. Falling back there would hand a
3–4 GB phone the ~394 MB cold peak that §19.6 says kills the tab, so it trades
a clear message for a crashed page. Rule 3's original direction is unchanged.

Two things follow from this that are not in the client:

- **The deploy can't be blocked by the box.** The `scorer` job in the deploy
  workflow is `continue-on-error`, because a machine nobody is paid to keep up
  must not hold a release. It runs before the web deploy so the box is never
  the older of the two.
- **`deploy.sh` asserts the build `id`**, not just the health check. A restart
  that comes back serving stale weights passes every other check and fails at
  §19.2's guard, in front of a learner, rather than in CI.

Still not done: §19.6's `weights.ts` double-buffer, which is the thing that
would let some of those phones hold the model in the first place and make this
whole branch rarer.
