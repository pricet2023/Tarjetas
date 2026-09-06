# Flash cards — working notes

Personal Spanish flash-card app. Development is against a **local Supabase
stack**; production is a **free-tier Supabase project plus Vercel**, deployed
by GitHub Actions on a push to `prod`. See `docs/deploying.md`.

- Work on `master`. `prod` is the deploy trigger — `git push origin master:prod`.
- **`supabase db push`, never `db reset`, against production.** Reset drops the
  deck and every review with it. Migrations are forward-only for this reason.
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

- **The deck weighting lives in SQL** (`study_deck` in 010): `weight = urgency
  x utility`, sampled with an exponential race rather than ranked. Keep it
  there rather than sorting in the client — the client's only ordering role is
  the in-session requeue of failed cards (`src/app/lib/session-queue.ts`).
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
- **The seed deck's conjugations are looked up, not derived** (011). Spanish
  forms come from `verbecc`'s tables, and `gen-seed-cards.py` asserts 99
  hand-verified irregulars before it writes anything — if a library upgrade
  moves one, the generator stops rather than emitting a deck of plausible
  nonsense. Add to `CHECKS` when you add verbs; don't hand-write forms.
- **`phrase_zipf` must stay an index probe** (012). It is called once per
  (card, direction) on every deck build — 6,958 times on the seeded deck — so
  the per-call plan is the whole cost of a session. The 005 version joined
  `word_frequency` and hash-joined 30,000 rows per call: 14 seconds a deck.
  Same values, different plan, 133x.
- **`card_reviews` is append-only.** No update/delete policy exists. It's the
  training data for the scheduling algorithm, and the source `card_state` is
  rebuilt from when its shape changes (see the replay in 009).
- The `cards_set_updated_at` trigger is scoped to the content columns, so
  `updated_at` means "someone edited the card" and nothing else.
- `translate` has `verify_jwt = true`; the client must be signed in.
- **Pronunciation runs entirely on the device** — a 197 MB ONNX wav2vec2 in a
  Worker, cached by the Cache API. No API, no key, no per-use cost, and that
  claim is the point of the feature, so don't move inference to an edge
  function. `docs/pronunciation-plan.md` §3 lists what else was rejected and
  why (transcribe-and-compare in particular).
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
- **An unseen *pronunciation* prompt does not take 010's 0.85 urgency floor.**
  It is not new material — the word is already being learned in the other two
  directions — so its urgency is `1 - min(phone ability)` over the full range.
  And its new-card gate races rather than ranks: a stable weak sound produced a
  stable ranking and dealt the same twenty cards every session. Both were
  measured; see the plan §18.3 before changing either back.
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
