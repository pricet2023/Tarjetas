# Flash cards — working notes

Personal Spanish flash-card app. Development is against a **local Supabase
stack**; production is a **free-tier Supabase project plus Vercel**, deployed
by GitHub Actions on a push to `prod`. See `docs/deploying.md`.

- Work on `main`. `prod` is the deploy trigger — `git push origin main:prod`.
- **`supabase db push`, never `db reset`, against production.** Reset drops the
  deck and every review with it. Migrations are forward-only for this reason.
- **Editing an applied migration is a silent no-op against production.**
  `db push` compares versions, not contents — measured. The seeded deck (005,
  011, 015) is generated, so regenerating one after it has shipped changes the
  local database and never the remote. Changing shipped data needs a *new*
  migration. See `docs/deploying.md` §3a.
- **Public signup must stay disabled on the production project.** The deck is
  genuinely shared — `shared_delete` is `USING (true)`, so any signed-in user
  can delete any card (009). That is right for two trusted people and a
  liability if anyone can sign up. The deploy workflow re-checks it every run.
- **Git identity here is repo-local**, set to the personal address. Don't set
  it globally — this machine's global identity is a work one.

## Layout

```
src/api/        data access — thin functions over supabase-js, one per concern
src/app/        supabase client, AuthProvider, utils
src/app/lib/phonology/  G2P, syllables, stress, GOP, feedback wording
src/app/lib/align/      CTC forced alignment
src/app/lib/acoustic/   the ONNX model, its Worker, the weights cache
src/app/lib/audio/      mic capture, resample, endpoint trim, useRecorder
src/app/lib/pronounce/  usePronunciation — the one place the above meet
src/components/ FlashCard (flip + swipe), PronounceCard, CardForm
src/pages/      SignIn, Cards, Study
src/types/      database.types.ts is GENERATED — never hand-edit
supabase/migrations/  numbered, forward-only
supabase/functions/   Deno edge functions
server/         the scorer service — same session.ts, on a box (§19)
infra/          provisioning for the box it runs on; start at infra/README.md
docs/pronunciation-plan.md  the design, the measurements, and what was rejected
```

## Conventions

- Migrations are numbered `NNN_name.sql` and forward-only. After changing one,
  run `npm run db:reset` (which also regenerates types).
- `src/types/database.types.ts` is produced by `npm run db:types`. Any schema
  change needs a regeneration or the app won't typecheck.
- **The deck is shared; progress is not.** `public.cards` is readable and
  writable by any signed-in user — two people learning from one portfolio —
  and `created_by` is authorship, nothing more. Everything that records how
  someone is doing (`card_reviews`, `card_state`, and the views over them) is
  RLS'd to `user_id = auth.uid()`. A new table gets its policies in the
  migration that creates it, and the choice of which side of that line it
  falls on is the first thing to decide.
- DB rows are snake_case; the app is camelCase. Convert at the `src/api`
  boundary (see `toCard` in `src/types/cards.ts`), never deeper.
- API functions throw `Error` with a human-readable message; pages catch and
  render it. Don't return `{ data, error }` tuples upward.

## Things that are load-bearing

- **The deck weighting lives in SQL** (`study_deck`, now 016): `weight =
  urgency`, sampled with an exponential race rather than ranked. Keep it there
  rather than sorting in the client — the client now does *no* ordering at all
  (`src/app/lib/session-queue.ts` only drops the answered card).
- **Word frequency no longer scores cards.** 010's `weight = urgency x
  utility` looked like two terms and behaved as one: urgency saturated at
  ~1.0 for anything not just-answered, while utility spanned 6.7x, so the deck
  was in practice ranked by how common the Spanish word is — which is to say,
  by how easy it is. Measured over ten decks, dropping it moved the mean Zipf
  of dealt cards 4.36 -> 3.69. `phrase_zipf` still exists and is still an
  index probe; `study_deck` simply doesn't call it.
- **`new_limit` is a reservation of deck slots, not a candidate cap** (016).
  As a cap it did nothing: the unseen cards passed the gate and then lost
  every slot to overdue ones, because an unseen card is 0.85 against ~1.0 and
  there are two hundred of the latter. Ten consecutive decks contained one new
  card each. The deck is stratified into a review lane and a new lane, each
  raced separately, and neither can crowd the other out — 0.54 -> 0.86
  distinct cards per dealt card. Whichever lane is short, the other tops up.
- **A card may not be dealt twice in an hour, or more than twice in six**
  (016), per card rather than per (card, direction) — being asked "ya" in
  either direction is still being asked "ya". Enforced in `candidates` before
  anything is weighted, off `card_reviews_user_reviewed_idx`. This is why
  there is no in-session retry any more: an immediate requeue is by definition
  inside the hour, and the old unlimited one could show a card you kept
  failing every fifth card for a whole session.
- **The halflife base is one hour, and the streak cap is 7** (016, was ten
  minutes and 8). With utility gone the whole ordering rests on urgency, and
  at a ten-minute base urgency did not discriminate — the ladder reached a
  one-day interval only at streak 6, so everything unmastered sat pinned at
  ~1.0. The relearning branch deliberately keeps the ten-minute halflife: it
  is not part of the ladder, and on the one-hour base a failed card would come
  back at 0.63, below an unseen card's 0.85.
- **`study_deck` joins `card_state` on `user_id` as well as card and side.**
  It draws from every card in the shared deck but weights them by the caller's
  own history; that predicate is the whole shared-deck/private-progress split.
  Drop it and my partner's answers retire cards out of my deck.
- **`card_state` is keyed on (user_id, card_id, prompt_side)**. Per user
  because progress is personal, and per side because the two directions are
  separate skills, scheduled separately.
- **`streak`, not the times_known/times_seen ratio**, drives the interval. The
  ratio is for display only; the two are not the same number. It lives in
  `card_state` (`reps` / `times_known`) and reaches the app through the
  `card_progress` view — deliberately *not* denormalised onto `public.cards`
  any more, where on a shared row it would have been both of us added together.
- **Migrations 005 and 011 are generated.** Rerun
  `scripts/gen-word-frequency.py` / `scripts/gen-seed-cards.py` rather than
  editing their megabyte of INSERTs by hand. Both want
  `.venv/bin/pip install wordfreq verbecc`.
- **Conjugation prompts don't name the verb** (017). "they will eat", not
  "they will eat (comer)" — recalling which verb is half the card. 017
  rewrote 011's prompts in place (ids, and so progress, kept); English-only
  collisions carry a sense, not a name: `(permanent)`/`(temporary)`,
  `(auxiliary)`/`(possession)`, `(a fact)`/`(a person or place)`, and
  comprender says "comprehend". Cards added by a later migration get their
  phones in a further one: `npm run db:phones -- --missing=NNN_name` (018).
- **The seed deck's conjugations are looked up, not derived** (011). Spanish
  forms come from `verbecc`'s tables, and `gen-seed-cards.py` asserts 99
  hand-verified irregulars before it writes anything — if a library upgrade
  moves one, the generator stops rather than emitting a deck of plausible
  nonsense. Add to `CHECKS` when you add verbs; don't hand-write forms.
- **`phrase_zipf` must stay an index probe** (012) *if anything starts calling
  it per row again*. It used to be called once per (card, direction) on every
  deck build — 6,958 times on the seeded deck — and the 005 version joined
  `word_frequency` and hash-joined 30,000 rows per call: 14 seconds a deck.
  Same values, different plan, 133x. 016 dropped the utility term, so
  `study_deck` no longer calls it at all and a deck builds in 11ms rather than
  60ms. The lesson outlives the caller.
- **`card_reviews` is append-only.** No update/delete policy exists. It's the
  training data for the scheduling algorithm, and the source `card_state` is
  rebuilt from when its shape changes (see the replay in 009).
- The `cards_set_updated_at` trigger is scoped to the content columns, so
  `updated_at` means "someone edited the card" and nothing else.
- `translate` has `verify_jwt = true`; the client must be signed in.
- **Pronunciation runs on the device wherever the device can hold it** — a
  197 MB ONNX wav2vec2 in a Worker, cached by the Cache API. No API, no key,
  no per-use cost, and that claim is still the point of the feature on any
  machine with the memory for it, so don't move inference to an edge function.
  `docs/pronunciation-plan.md` §3 lists what else was rejected and why
  (transcribe-and-compare in particular, which is what rules out every free
  hosted speech API — they return words, and this needs a posterior matrix).
- **The exception is the scorer service**, `server/`, added by §19. §3 assumed
  every device could hold 197 MB resident; a 3–4 GB Android phone cannot, and
  gets its tab killed. So `backend.ts` picks per device and `remote.ts` is a
  drop-in `AcousticModel` over HTTP. Three things about it are load-bearing:
  the box returns **log-probabilities, not scores** (all phonology stays in
  the client, so there is one implementation of the scoring); it imports the
  app's **own `session.ts`** through `scripts/ts-loader.mjs` rather than a
  port of it; and the client **refuses a server whose build `id` differs**,
  because mismatched weights align fine and score against the wrong
  calibration. It is *not* a speed win — ORT's wasm EP is single-threaded
  under Node (§19.4 has the error), so the box is slower than a laptop. It is
  for the megabytes. `VITE_SCORER_URL` unset turns the whole thing off.
- **The box is expected to be absent, and nothing may depend on it** (§19.7).
  It is an Always Free Oracle instance that gets reclaimed when idle, so
  `loadAcousticBackend` falls through in *both* directions and the `scorer`
  deploy job is `continue-on-error`. The one routing that does not fall back is
  `deviceMemory <= 4`: that device was measured unable to hold the model, and
  retrying it there trades a clear message for a killed tab. `routeBackend`
  exists only to keep that distinction — don't collapse it back into
  `chooseBackend`. The job also runs *before* the web deploy, because
  `remote.ts` refuses a build-`id` skew in either direction.
- **The scorer must run the same execution provider as the browser**, not just
  the same weights, or `native-stats.generated.ts` stops cancelling the
  quantization bias. That is why it is `onnxruntime-web/wasm` on the server
  too. Moving it to `onnxruntime-node` for speed needs a `stats:native`
  regeneration *and* a per-user backend pin — see §19.3 before trying.
- **Import `onnxruntime-web/wasm`, not `onnxruntime-web`.** The default entry
  emits a second 27.8 MB JSEP binary the app never uses. `numThreads = 1` is
  mandatory too: threaded wasm needs `SharedArrayBuffer`, which needs COOP/COEP
  headers the dev server doesn't send.
- **The CTC blank must be excluded from GOP's rival set** (`gop.ts`). It is the
  argmax on 24 of 30 frames of *native* speech; left in, the score measures
  peakiness rather than pronunciation.
- **GOP is not comparable across phonemes**, so verdicts are cut on a z-score
  against native speech — `native-stats.generated.ts`, from
  `npm run stats:native`. **Regenerate it whenever the model build changes**,
  or the quantization bias stops cancelling. It needs `npm run model:fetch`
  first, and `gop.integration.test.ts` skips silently without `.models/`.
- **Allophones are one scored unit, not several.** `MODEL_LABELS` in
  `inventory.ts` folds `β ð ɣ`, the long vowels, and `θ`/`ʎ` back in. Score
  them apart and correct native Spanish tanks. `ɡ` there is U+0261, not ASCII.
- **`phrase_phones` is how SQL knows what sounds a card contains**, because
  G2P is TypeScript and the weighting is SQL. Keyed on the Spanish text, an
  index probe like `phrase_zipf`. Seeded by 015 (`npm run db:phones`, run after
  a `db:reset`), kept current by `rememberPhones` in `src/api/cards.ts`.
- **An unseen *pronunciation* prompt does not take the 0.85 urgency floor.**
  It is not new material — the word is already being learned in the other two
  directions — so its urgency is `1 - min(phone ability)` over the full range.
  And its new lane races rather than ranks: a stable weak sound produced a
  stable ranking and dealt the same twenty cards every session. Both were
  measured; see the plan §18.3 before changing either back. Since 016 the
  translation lane races too, for the same reason.
- **Pronunciation is its own deck mode**, `sides => ['pronounce']`. Adding it
  to the default sides lets `distinct on (r.id)` deal a pronunciation prompt in
  place of a translation one.
- **The card gesture is ref + rAF driven, not React state** (`FlashCard`).
  Offset, tilt and highlight live in refs and are written to the DOM once per
  frame; state is only for the flip, the reveal counter and the leave. Moving
  the offset back into state re-renders the card on every pointermove *and*
  makes the release handler read a stale offset, so fast flicks silently spring
  back instead of answering. A release also commits on velocity
  (`releaseSpeed`, unit-tested), not distance alone.
- **Hover transforms never go on the element that takes the pointer.** The
  card's lean is on `.card-tilt` — inside the drag layer, `pointer-events:
  none` — because a 3D lean on the interactive box rotates it out from under
  the cursor and the hover oscillates. The card sets its own `cursor: grab`
  for the same reason: Tailwind's preflight gives `[role="button"]`
  `cursor: pointer`, so any hit that slips through to an ancestor flips the
  pointer shape.
- **The metal look is a CSS vocabulary, not utility soup.** `.plate`, `.well`,
  `.chrome`, `.sheen`, `.ring-sweep` and the `.btn-*` / `.input-metal` controls
  are defined in `src/index.css`; keyframes are in `tailwind.config.ts`. Reach
  for those before writing a new multi-layer gradient inline. See "Look and
  feel" in the README for the two gotchas (`background-clip: text` doesn't
  reach transformed descendants; off-scale opacity steps like `bg-white/8`
  emit nothing).

## Verify a change

```bash
npm run typecheck && npm run lint && npm test && npm run build
```

`npm test` skips the two model-backed integration suites unless `.models/` is
populated (`npm run model:fetch`, 197 MB). Run them before trusting anything in
`phonology/` or `acoustic/` — the calibration assertions live there, and a
missing `.models/` makes them report green.
