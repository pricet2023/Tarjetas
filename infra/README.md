# The pronunciation scorer's box

The runbook for the machine described in plan §19. It exists for one reason:
the acoustic model is 197 MB resident, and a 3–4 GB Android phone cannot hold
it — the tab is killed and pronunciation is not a worse feature there, it is
an absent one. The box holds the weights so the phone does not have to.

**It is not a performance win.** Single-threaded ORT on an A1 core is slower
than the same model on your laptop (§19.4). The laptop keeps the on-device
path; this is for the devices that have no path at all.

Everything here is free: Oracle's Always Free ARM allowance and Tailscale's
free tier. Nothing in this directory should ever need a card — and that is why
it is Tailscale rather than a Cloudflare Tunnel, which needs a domain you have
paid for. The scorer reaches the public internet through Tailscale **Funnel**,
and CI reaches the box through **Tailscale SSH**.

---

## 1. The instance

Oracle Cloud → Compute → Instances → Create.

| | |
| --- | --- |
| Image | Canonical Ubuntu 24.04 (**aarch64**) |
| Shape | `VM.Standard.A1.Flex`, **4 OCPU / 24 GB** |
| Networking | default VCN, **assign a public IPv4** (for SSH only) |
| SSH | add your public key |
| Advanced → cloud-init | paste `infra/cloud-init.yaml` |

Two Oracle-specific traps, both of which will waste an afternoon if you meet
them without warning:

- **A1 capacity is genuinely scarce.** "Out of host capacity" in a popular
  region is the normal experience, not a fault. Try another availability
  domain, or another region, or retry — it frees up.
- **Always Free instances get reclaimed when idle.** Two people studying does
  not clear Oracle's utilisation bar. Upgrading the tenancy to Pay As You Go
  stops the reclamation and *keeps the Always Free resources free* — you are
  not agreeing to pay for this box, only becoming eligible to. Do it before
  you rely on the thing.

No ingress rules are needed, and you should add none — not even 22. The
scorer binds `127.0.0.1`, Tailscale reaches it from inside the box, and SSH
arrives over the tailnet rather than the public interface. The public IPv4 is
there for the console's benefit and as a way back in if you break the tailnet.

## 2. Check the base image came up

```bash
ssh ubuntu@<public-ip>
node --version          # must be v24.x — native TS stripping, loadEnvFile
tailscale version
```

That is the last time you need the public IP. From §6 on, the box is reachable
by name over the tailnet.

## 3. The checkout

```bash
sudo -u scorer git clone https://github.com/<you>/flash-cards /opt/flash-cards
cd /opt/flash-cards
sudo -u scorer npm ci --omit=dev --no-audit --no-fund

# 197 MB, once. Same script and same .models/ layout the tests use.
sudo -u scorer node scripts/fetch-acoustic-model.mjs
```

A private repo needs a deploy key: generate one as `scorer`, add the public
half to the repo's Deploy Keys (read-only), and clone over SSH instead.

## 4. Secrets

Edit `/etc/flash-cards/scorer.env` (cloud-init created it, root:scorer 0640):

```sh
SCORER_HOST=127.0.0.1
SCORER_PORT=8787
SUPABASE_URL=https://<project>.supabase.co
SCORER_ALLOWED_ORIGINS=https://<your-app>.vercel.app
```

`SUPABASE_URL` alone is enough for a project using **asymmetric JWT signing
keys** — the scorer discovers the public keys from
`/auth/v1/.well-known/jwks.json` and verifies against those. If your project
still signs **HS256**, add `SUPABASE_JWT_SECRET` (Settings → API → JWT Secret)
as well.

> Treat the JWT secret exactly like the service role key. It does not read
> data, it *mints sessions* — anything holding it can be any user.

The scorer refuses to start with neither. That is deliberate: an
unauthenticated scorer is a free denial-of-service and, once someone finds it,
free inference. `SCORER_ALLOW_ANONYMOUS=1` exists for local development and
must never appear on this box.

## 5. The service

```bash
sudo cp /opt/flash-cards/infra/scorer.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now scorer
curl -s localhost:8787/health     # {"ok":true,"id":"wav2vec2-...-q4f16"}
```

`journalctl -u scorer -f` prints a line per attempt: user prefix, audio
length, frame count, milliseconds.

## 6. The tailnet

Join the box first. `tailscale up` needs an auth key, which is why cloud-init
installed the package and stopped there — anything in a cloud-init script is
readable in the Oracle console for the life of the instance.

```bash
sudo tailscale up --ssh --advertise-tags=tag:scorer
```

It prints a URL. Open it, approve the machine, and give it a name you will
recognise — `flash-cards-scorer` below. `--ssh` is what hands SSH to
tailscaled, which is what §8 relies on; `--advertise-tags` is what the policy
file matches on, and the tag will not stick until that policy exists.

So paste **`infra/tailscale-acl.json`** into Tailscale admin → Access Controls
now. It is short, and the comments in it are the explanation: two tags, CI
reaching port 22 as `deploy` and nothing else, and the `funnel` attribute
without which the next command refuses to run.

Then put the scorer on the public internet:

```bash
sudo tailscale funnel --bg 8787
sudo tailscale funnel status
```

Funnel is the part that has to be public, and it is worth being clear why:
your partner's phone is not on this tailnet and never will be, so the scorer
cannot live behind tailnet-only access. Funnel terminates TLS at the box and
proxies to `127.0.0.1:8787`. Nothing else on the box is exposed by it.

Your hostname is then:

```
https://flash-cards-scorer.<your-tailnet>.ts.net
```

`tailscale status` prints the tailnet name, or read it off the admin console
(it looks like `tail1234.ts.net`, or your domain if you set one).

Check it from a machine that is **not** on the tailnet — tether to your phone,
or use a browser with the VPN off. This matters: from inside the tailnet you
would be testing tailnet routing, not Funnel.

```bash
curl -s https://flash-cards-scorer.<tailnet>.ts.net/health
curl -s -o /dev/null -w '%{http_code}\n' \
  https://flash-cards-scorer.<tailnet>.ts.net/model   # 401
```

A 401 on `/model` without a token is the correct answer and is the check that
matters — it means auth is on. Funnel does not authenticate anything; every
control on who may score is `server/auth.ts` and the `SUPABASE_*` variables
from step 4.

## 7. Point the app at it

In **Vercel** → project → Settings → Environment Variables:

```
VITE_SCORER_URL = https://flash-cards-scorer.<your-tailnet>.ts.net
```

Redeploy. The variable is read at build time, so an existing deployment will
not pick it up.

Leaving it unset is the supported way to turn the whole thing off: every
device goes back to running the model itself, which is the pre-§19 behaviour.
That is also the rollback — unset it and redeploy, no box involved.

## 8. Deploys

`infra/deploy.sh` pulls `prod`, reinstalls, restarts, and then fails loudly on
two things: a unit that does not come back healthy, and a unit that comes back
serving a different build `id` than the commit it just checked out. The second
is the one worth having. A deploy where the weights quietly did not update
passes every other check and surfaces as *"running X but this app expects Y"*
on someone's card, because `remote.ts` refuses a mismatched server by design.

The `scorer` job in `.github/workflows/deploy.yml` runs it on every push to
`prod`. Three properties of that job are deliberate:

- **It runs before the web deploy**, so the box is never the older of the two.
  A skew in either direction is the same hard failure for the learner.
- **It cannot block the release.** `continue-on-error: true` — a reclaimed
  instance or a tunnel that is down gives you a red check and a degraded
  feature, not a stuck deploy. The app falls back on its own (§19.6).
- **It opens no ports.** CI reaches the box the same way the app does: out
  through Tailscale and back down the tailnet.

### 8.1 The deploy account

`cloud-init.yaml` creates a `deploy` user for this and nothing else. It is not
root and it is not `ubuntu`; `infra/deploy-sudoers` grants it exactly two
things — acting as `scorer` (which owns the checkout and has no login shell of
its own), and `systemctl restart scorer`. On a box that already exists:

```bash
sudo useradd -m -s /bin/bash deploy
sudo install -m 0440 -o root -g root \
  /opt/flash-cards/infra/deploy-sudoers /etc/sudoers.d/flash-cards-deploy
sudo visudo -c                      # a malformed drop-in locks sudo out entirely
sudo chmod 0755 /opt/flash-cards    # `deploy` has to be able to cd into it
```

Note what is *not* here: no keypair, and no `authorized_keys`. Tailscale SSH
authenticates the caller's tailnet identity against the `ssh` block of
`infra/tailscale-acl.json`, so there is no private key sitting in a GitHub
secret waiting to be leaked or rotated. The ACL is the authorization.

### 8.2 An OAuth client for CI

The runner needs to join the tailnet, and it is a different machine every run,
so it needs a credential rather than a key. Tailscale admin → Settings → OAuth
clients → Generate:

| | |
| --- | --- |
| Scopes | `auth_keys` — **write** |
| Tags | `tag:ci` |

Keep both halves. The client can mint auth keys for `tag:ci` and nothing else,
and the ACL gives `tag:ci` port 22 on the box as `deploy` and nothing else, so
a leak of this credential is a credential to run `infra/deploy.sh`.

The action brings the runner up as an **ephemeral** node, which removes itself
from the tailnet when the job ends. Without that you accumulate a dead machine
per deploy until you hit the free tier's device limit.

### 8.3 The secrets

Repo → Settings → Secrets and variables → Actions:

| Secret | Where from |
| --- | --- |
| `TS_OAUTH_CLIENT_ID` | §8.2 |
| `TS_OAUTH_SECRET` | §8.2 |
| `SCORER_SSH_HOST` | the machine name in Tailscale admin, e.g. `flash-cards-scorer` |

Three, where an SSH-over-tunnel route needs five and two of them are key
material. `SCORER_SSH_HOST` is the short MagicDNS name, not a URL and not the
Funnel hostname.

Running it by hand is still a defensible answer for one box and two users. The
same ACL rule covers you, with a reauth every 12h:

```bash
tailscale ssh deploy@flash-cards-scorer /opt/flash-cards/infra/deploy.sh
```

---

## What this costs

Nothing, if you stay inside the lines: 4 OCPU / 24 GB is the entire Always
Free ARM allowance, so this box uses all of it and there is none left for a
second one. Tailscale's free tier covers three users and a hundred devices,
which two people and one box are comfortably inside — and Funnel is included.
The only bill you can accidentally create is by launching a *second* Oracle
instance or a non-A1 shape.

This is also the reason the ingress is Tailscale and not a Cloudflare Tunnel.
The tunnel itself is free; the domain it needs to have a stable hostname is
not, and a `*.ts.net` name costs nothing. The trade is an uglier hostname you
do not own, which for a `VITE_SCORER_URL` nobody ever reads is no trade at all.

## When it breaks

| Symptom | Cause |
| --- | --- |
| `no weights in /opt/flash-cards/.models/...` and the unit exits 0 | step 3's `fetch-acoustic-model.mjs` never ran |
| Refuses to start, complains about `SUPABASE_JWT_SECRET` | step 4 — neither auth variable is set |
| Client says "running X but this app expects Y" | box is on an older commit than the app; run `infra/deploy.sh` |
| Client says "couldn't reach the pronunciation scorer" | `tailscale funnel status`, then `systemctl status scorer` |
| `/health` works on the box but not from your phone | Funnel is down or was never backgrounded. `sudo tailscale funnel --bg 8787`. Testing from inside the tailnet hides this. |
| `tailscale funnel` refuses: "not permitted" | The `funnel` nodeAttr is missing, or the box did not pick up `tag:scorer`. Check Access Controls, then `tailscale status`. |
| Everything 401s | project moved to asymmetric keys; drop `SUPABASE_JWT_SECRET`, set `SUPABASE_URL` |
| Instance vanished | Oracle reclaimed an idle Always Free box — see §1 |
| The `scorer` job is red but the deploy went out | Working as designed (§8). The box is stale or gone; the app fell back to the on-device path. Fix the box and re-run the job. |
| `deploy.sh` says "running X but this commit expects Y" | The restart worked and the weights did not update. `sudo -u scorer node scripts/fetch-acoustic-model.mjs` and look at what it says. |
| CI can't SSH, but you can | The ACL, not a key — the `ssh` block must allow `tag:ci` → `tag:scorer` as `deploy`. Your own access comes from a different rule, so it working proves nothing about CI's. |
| CI: "tailscale: not logged in" | The OAuth client's scope or tag is wrong (§8.2). It needs `auth_keys` **write** and `tag:ci`. |
| Tailscale says the device limit is reached | Ephemeral nodes were not ephemeral — check the action sets them so, and delete the accumulated runners in the admin console. |
