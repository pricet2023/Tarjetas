# Tarjetas — Spanish flash cards

A local-first flash card app for learning Spanish. Two-sided cards (English /
Español), a shuffled study deck you swipe through, and translation suggestions
while you type a new card.

Runs entirely against the **local Supabase stack** — there is no remote project
and no CI/CD wiring yet.

## Stack

| Layer      | Choice                                                  |
| ---------- | ------------------------------------------------------- |
| Front end  | Vite + React 18 + TypeScript + Tailwind                 |
| Data       | Supabase Postgres, RLS-scoped per user                   |
| Auth       | Supabase Auth (email + password)                         |
| Server     | Supabase Edge Functions (Deno) — `translate`             |
| Translation| MyMemory free API, behind a swappable provider interface |

## Getting started

Docker Desktop must be running.

```bash
npm install
npm run db:start          # boots Postgres, Auth, Studio, Edge Runtime
cp .env.example .env      # then paste the anon key from the db:start output
npm run db:types          # generate src/types/database.types.ts
npm run dev               # Vite on :3000 + edge functions on :54321
```

Open http://localhost:3000, create an account (email confirmation is disabled
locally, so you're signed straight in), and add a card.

Useful local URLs:

- App — http://localhost:3000
- Supabase Studio — http://127.0.0.1:54323
- Mailpit (auth emails) — http://127.0.0.1:54324

## Scripts

| Command            | Does                                                    |
| ------------------ | ------------------------------------------------------- |
| `npm run dev`      | Vite + `supabase functions serve` together              |
| `npm run db:start` | Start the local stack                                   |
| `npm run db:stop`  | Stop it                                                 |
| `npm run db:reset` | Drop, re-run every migration, regenerate types          |
| `npm run db:types` | Regenerate `src/types/database.types.ts`                |
| `npm run typecheck`| `tsc --noEmit`                                          |
| `npm run build`    | Production bundle into `dist/`                          |

## Schema

`supabase/migrations/`, applied in numeric order:

- **001_cards** — `public.cards`: `english`, `spanish`, optional `notes`, and
  denormalised review counters (`times_seen`, `times_known`, `last_seen_at`).
  Unique on `(user_id, english)`.
- **002_reviews** — `public.card_reviews`: append-only log, one row per swipe,
  recording `knew` and which side was the prompt. A trigger rolls each review
  up onto its card.
- **003_rls** — every row is private to its owner (`user_id = auth.uid()`).
  Reviews are insert-and-read only, and a review's `card_id` must belong to the
  caller.
- **004_study_deck** — `study_deck(deck_size)`, the deck builder.

## Studying

`/study` deals a deck from the `study_deck` SQL function. Tap a card (or press
Space) to reveal the other side; swipe right for "knew it", left for "didn't" —
arrow keys do the same on a desktop. The direction toggle switches between
EN→ES, ES→EN and mixed.

Every swipe writes a `card_reviews` row.

### Replacing the shuffle

The ordering is deliberately in the database, in `study_deck`, not in the app.
It is currently a uniform `order by random()`. To fit a real spaced-repetition
schedule, add a migration that redefines the function — the counters and the
full review history it needs are already being recorded, and the app's return
shape doesn't change.

## Translation suggestions

Typing in either side of the card form debounces for ~650ms, then asks the
`translate` edge function for the other side and offers it as a chip you tap to
accept. Failures are silent by design: a suggestion is a convenience and the
form stays usable without it.

The function requires a valid user JWT (`verify_jwt = true`), so it isn't an
open translation proxy.

**Swapping provider.** `supabase/functions/translate/provider.ts` defines a
`Provider` interface and exports `activeProvider`. MyMemory is free and
key-less but its quality on bare words is mixed — it sometimes returns a
phrase-match ("the house" → "con la casa"). To move to DeepL or an LLM, add a
provider in that file, point `activeProvider` at it, and add its key to `.env`;
nothing else changes.

## Not done yet

- No remote Supabase project and no GitHub CI/CD — local only, by choice.
- No spaced repetition; the deck is a plain shuffle.
- No tests beyond typecheck/build.
