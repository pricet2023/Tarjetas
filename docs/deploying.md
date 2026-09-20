# Deploying

Production is a **free-tier Supabase project** for the database, auth and the
`translate` edge function, and **Vercel** for the built SPA. GitHub Actions
runs the whole thing on a push to `prod`.

This file is the runbook and the record of what the free tier will and won't
do. `docs/pronunciation-plan.md` covers the feature; this covers getting it
onto the internet.

---

## 1. The shape of it

```
push to prod
     │
     ├─ verify    typecheck, lint, the full test suite *including* the
     │            model-backed integration tests (weights cached in Actions)
     │
     ├─ database  supabase link → db push → functions deploy
     │            then asserts public signup is still disabled
     │
     ├─ scorer    tailscale ssh → infra/deploy.sh
     │            allowed to fail; see below
     │
     └─ web       vercel pull → build → deploy --prod
```

`scorer` is the one job that **cannot fail the deploy**. It updates the
pronunciation box (`infra/README.md`), which is an Always Free Oracle instance
behind a tunnel, and the whole point of `backend.ts`'s fallback is that the app
does not need it. A dead box is a red check and a degraded feature, never a
release stuck behind a machine nobody is paid to keep up.

It runs *before* `web` so the box is never the older of the two. `remote.ts`
refuses a server whose build `id` is not the one the bundle expects, and a skew
in either direction is the same hard failure on the card.

`main` is where work happens; nothing deploys from it. Promote with:

```bash
git push origin main:prod
```

Migrations run **before** the web deploy, because the bundle that follows
expects the schema they create.

---

## 2. One-time setup

### 2.1 Supabase project

1. Create a project on the free tier. Keep the **database password** — the
   workflow needs it and it is not recoverable.
2. Note the **project ref** (the subdomain in the project URL).
3. **Disable public signup.** Dashboard → Authentication → Sign In / Providers
   → turn off *Allow new users to sign up*.

   This is not tidiness. `009_shared_deck.sql` makes the deck genuinely
   shared: `shared_delete` is `USING (true)`, so **any signed-in user can
   delete any card**. That is the correct policy for two people learning
   together and a liability the moment anyone can sign up. The deploy workflow
   re-checks it against the Management API on every run and fails the deploy if
   it has been turned back on.

4. Add the two of you: Authentication → Users → Add user.
5. Authentication → URL Configuration → set **Site URL** to the Vercel domain
   and add it to **Redirect URLs**, or the email links point at localhost.

### 2.2 Vercel project

1. Import the repo. Framework preset **Vite**; `vercel.json` pins the build
   command and output directory anyway.
2. **Turn off Vercel's own Git integration** (Project → Settings → Git →
   disconnect, or set *Ignored Build Step* to always skip). Otherwise every
   push deploys twice: once from Vercel, ungated, and once from the workflow
   after the tests pass. The ungated one is the problem — it can ship a bundle
   whose migration has not run.
3. Set the production environment variables:
   - `VITE_SUPABASE_URL` — `https://<ref>.supabase.co`
   - `VITE_SUPABASE_ANON_KEY` — the project's anon/publishable key

   These live here rather than in GitHub secrets so there is one copy. The anon
   key is public by design; it ships in the bundle. The **service role** key
   must never appear in either place — it bypasses RLS.
4. `vercel link` locally once, then read `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID`
   out of `.vercel/project.json` (gitignored).

### 2.3 GitHub secrets

Repo → Settings → Secrets and variables → Actions:

| Secret | Where from |
| --- | --- |
| `SUPABASE_ACCESS_TOKEN` | supabase.com/dashboard/account/tokens |
| `SUPABASE_PROJECT_REF` | the project URL |
| `SUPABASE_DB_PASSWORD` | set at project creation |
| `VERCEL_TOKEN` | vercel.com/account/tokens |
| `VERCEL_ORG_ID` | `.vercel/project.json` |
| `VERCEL_PROJECT_ID` | `.vercel/project.json` |

And, for the pronunciation scorer's box. These are optional in the sense that
everything else deploys without them — the `scorer` job fails, loudly, and the
release continues. `infra/README.md` §8 is the setup.

| Secret | Where from |
| --- | --- |
| `TS_OAUTH_CLIENT_ID` | Tailscale → Settings → OAuth clients, scope `auth_keys:write`, tag `tag:ci` |
| `TS_OAUTH_SECRET` | likewise |
| `SCORER_SSH_HOST` | the box's MagicDNS name, e.g. `flash-cards-scorer` |

None of these is key material. Tailscale SSH authorizes against the tailnet
ACL in `infra/tailscale-acl.json`, so there is no private key in a GitHub
secret — which is the main reason this is Tailscale and not an SSH tunnel.

---

## 3. What the free tier actually gives you

Worth knowing before it surprises you.

- **The project pauses after 7 days of inactivity.** A flash-card app used in
  bursts will hit this. Unpausing is a dashboard click, but the first request
  after a pause fails rather than waits, so the app will look broken.
- **500 MB database.** The seeded deck is nowhere near it: 3,479 cards, 29,854
  word-frequency rows and 3,407 `phrase_phones` rows come to a few tens of MB.
- **5 GB egress a month.** This is the one to keep an eye on, and it is the
  reason the acoustic model is **not** served from Supabase Storage.

  The weights are 197 MB. Serving them from Supabase would be ~25 first-time
  visitors a month before the whole project is throttled — and it would spend
  the budget on the one file that is already hosted for free, with a CDN, by
  HuggingFace. `model-source.json` points at HuggingFace and should stay there.
  (An earlier version of this repo's advice suggested moving it to Storage to
  speed up the local first load. That is fine for a laptop-only setup and
  wrong the moment there is a real deployment.)
- **Auth emails go through Supabase's shared SMTP**, which is rate-limited to a
  handful an hour and explicitly not for production. Fine for two invited
  users; wire up a real SMTP provider before that changes.

---

## 3a. The seed data runs exactly once

All of it — 29,854 word frequencies (005), 3,479 cards (011) and 3,407
`phrase_phones` rows (015) — lives in **migrations**, not in
`supabase/seed.sql`. There is no `seed.sql` in this repo, which matters:
that file re-runs on every `db reset`, whereas a migration is applied once,
recorded in `supabase_migrations.schema_migrations`, and skipped forever after.

Measured against a throwaway database, rather than assumed:

| | |
| --- | --- |
| first `db push` | applies all 15; cards 3,479, word_frequency 29,854, phrase_phones 3,407 |
| second `db push` | `{"upToDate":true,"migrations":[],"seeds":[]}` — nothing runs |

The three-digit version prefixes (`001_`, not a 14-digit timestamp) are
accepted and ordered correctly by the CLI, which was the one thing worth
checking before the first deploy.

`011` and `015` also carry `on conflict … do nothing`, so even a re-run would
not duplicate. That is belt-and-braces; the migration history is the actual
guarantee.

### The consequence, which is the part that bites

**Editing an already-applied migration is silently ignored.** `db push`
compares *versions*, not contents, so a changed file whose number production
has already seen is never re-read — no error, no warning, `upToDate: true`.
Measured: a row appended to `015` after it had been applied simply never
arrived.

This matters here more than in most repos, because **005, 011 and 015 are all
generated files**. Re-running `npm run db:phones` or `gen-seed-cards.py`
rewrites a migration production has already applied, and the change will reach
your local database (via `db reset`) and never reach production. The two then
disagree, quietly, and the next person to compare them has a bad afternoon.

So: once a migration has shipped, **changing the deck means a new migration**,
not an edit to an old one. That is what forward-only costs, and it is the same
reason there is no `db reset` in the workflow.

## 4. Things that will bite

- **`supabase db push`, never `db reset`.** Reset drops everything — the deck
  and every review either of you has recorded. The workflow only ever pushes.
  Migrations are forward-only for this reason.
- **`015_seed_phrase_phones.sql` is generated from the local database** (`npm
  run db:phones`), so regenerate it locally and commit the result. Never run
  the generator against production — and once it has shipped, see §3a: editing
  it changes nothing in production.
- **The 197 MB model is per browser, not per user.** Cached by the Cache API
  after the first pronunciation attempt, but that cache is *best-effort*
  storage: the browser may evict it under disk pressure, and Safari wipes
  script-writable storage for sites unused for 7 days. A visitor who comes back
  to an evicted cache re-downloads it. Nothing is broken by this; it is just
  slow, and it is worth knowing before someone reports the app "re-downloading
  itself".
- **HTTPS is required** and Vercel gives it — `getUserMedia` and the Cache API
  are both secure-context only, so pronunciation silently does nothing over
  plain HTTP.
- **Cross-origin isolation is not needed.** ORT runs single-threaded on
  purpose (`numThreads = 1`), so no COOP/COEP headers are required. If someone
  ever turns threading on, that changes and `vercel.json` needs the headers.

---

## 5. Rolling back

There is no down-migration story, by design. To roll back the **app**, redeploy
a previous Vercel deployment from the dashboard — the bundle is static and any
older one still talks to the same schema, provided the schema only ever moved
forward additively.

Rolling back a **migration** means writing a new one that undoes it. That is
the cost of forward-only, and it is the right trade for a database with
irreplaceable review history in it.
