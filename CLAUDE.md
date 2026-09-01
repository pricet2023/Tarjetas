# Flash cards — working notes

Personal Spanish flash-card app. Local Supabase only: **no remote project, no
CI/CD**. Don't add `supabase link`, deploy steps, or GitHub workflows unless
asked.

## Layout

```
src/api/        data access — thin functions over supabase-js, one per concern
src/app/        supabase client, AuthProvider, utils
src/components/ FlashCard (flip + swipe), CardForm (translation suggestions)
src/pages/      SignIn, Cards, Study
src/types/      database.types.ts is GENERATED — never hand-edit
supabase/migrations/  numbered, forward-only
supabase/functions/   Deno edge functions
```

## Conventions

- Migrations are numbered `NNN_name.sql` and forward-only. After changing one,
  run `npm run db:reset` (which also regenerates types).
- `src/types/database.types.ts` is produced by `npm run db:types`. Any schema
  change needs a regeneration or the app won't typecheck.
- Every table is RLS'd to `user_id = auth.uid()`. New tables get their policies
  in the same migration that creates them.
- DB rows are snake_case; the app is camelCase. Convert at the `src/api`
  boundary (see `toCard` in `src/types/cards.ts`), never deeper.
- API functions throw `Error` with a human-readable message; pages catch and
  render it. Don't return `{ data, error }` tuples upward.

## Things that are load-bearing

- **The deck weighting lives in SQL** (`study_deck` in 008): `weight = urgency
  x utility`, sampled with an exponential race rather than ranked. Keep it
  there rather than sorting in the client — the client's only ordering role is
  the in-session requeue of failed cards (`src/app/lib/session-queue.ts`).
- **`card_state` is keyed on (card_id, prompt_side)**, not card_id. The two
  directions are separate skills and are scheduled separately.
- **`streak`, not the times_known/times_seen ratio**, drives the interval. The
  ratio on `public.cards` is for display only; the two are not the same number.
- **Migration 005 is generated.** Rerun `scripts/gen-word-frequency.py` rather
  than editing the 0.5 MB of INSERTs by hand.
- **`card_reviews` is append-only.** No update/delete policy exists. It's the
  training data for the scheduling algorithm.
- The `cards_set_updated_at` trigger is scoped to the content columns so the
  review roll-up doesn't look like a user edit.
- `translate` has `verify_jwt = true`; the client must be signed in.

## Verify a change

```bash
npm run typecheck && npm run build
```
