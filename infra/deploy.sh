#!/usr/bin/env bash
# Update the scorer box to the current `prod` and restart it.
#
#   tailscale ssh deploy@flash-cards-scorer /opt/flash-cards/infra/deploy.sh
#
# Run from CI (the `scorer` job in .github/workflows/deploy.yml) or by hand.
# Deliberately dumb: this is a two-person app on one box, and anything cleverer
# would be more moving parts than the thing it deploys.
#
# Runs as `deploy`, which is unprivileged. It borrows exactly two powers, both
# granted by infra/deploy-sudoers:
#
#   - `sudo -u scorer` for anything touching the checkout, because the service
#     account owns it and has no login shell of its own.
#   - `sudo systemctl restart scorer` for the restart, and nothing else.
#
# The script is never itself run as root. It lives in the checkout, so a
# sudoers rule naming *it* would make every push to `prod` a root escalation.
set -euo pipefail

readonly ROOT=/opt/flash-cards
readonly HEALTH=http://127.0.0.1:8787/health

as_scorer() { sudo -u scorer "$@"; }

cd "$ROOT"

echo "==> fetching"
as_scorer git fetch --quiet origin prod
as_scorer git reset --hard --quiet origin/prod
echo "    now at $(git rev-parse --short HEAD) $(git log -1 --pretty=%s)"

# `--omit=dev` still installs onnxruntime-web, which is the only runtime
# dependency the scorer's import graph actually reaches: session.ts, the
# aligner and protocol.ts pull in nothing else.
echo "==> installing"
as_scorer npm ci --omit=dev --no-audit --no-fund

# The weights are not in git and not in npm. They are fetched once, and
# `model:fetch` is a no-op when the file is already there — but it lives in
# devDependencies-free territory, so call the script directly.
echo "==> weights"
as_scorer node scripts/fetch-acoustic-model.mjs

echo "==> restarting"
sudo systemctl restart scorer

# Prove it came back, rather than reporting success and leaving a dead unit.
health=""
for _ in $(seq 1 30); do
  if health=$(curl -fsS --max-time 2 "$HEALTH" 2>/dev/null); then
    break
  fi
  health=""
  sleep 2
done

if [ -z "$health" ]; then
  echo "!! the scorer did not become healthy within 60s" >&2
  systemctl --no-pager status scorer >&2 || true
  exit 1
fi

echo "==> healthy: $health"

# The check that actually matters, and the reason this is not just a restart.
#
# `remote.ts` refuses a server whose build `id` is not the one the bundle
# expects, because mismatched weights align perfectly well and then score
# against the wrong `native-stats.generated.ts` (§19.2) — a silent failure, so
# it is made loud. A deploy where the weights did not actually get refetched
# passes every check above and surfaces as "running X but this app expects Y"
# on a learner's card. Compare here instead.
#
# The checkout is the reference: it was just reset to the commit being
# deployed, and the bundle is built from that same commit.
expected=$(node -p "require('$ROOT/src/app/lib/acoustic/model-source.json').id")
actual=$(printf '%s' "$health" | node -e 'process.stdin.on("data", d => console.log(JSON.parse(d).id))')

if [ "$expected" != "$actual" ]; then
  echo "!! the scorer is running '$actual' but this commit expects '$expected'" >&2
  echo "!! clients routed here will refuse to score; the weights did not update" >&2
  exit 1
fi

echo "==> build id matches: $expected"
