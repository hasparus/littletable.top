#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../../.."
experiment=experiments/opennext
generated="$experiment/generated"
port="${OPENNEXT_PORT:-18620}"
workos_port="${OPENNEXT_WORKOS_PORT:-18621}"
export WRANGLER_SEND_METRICS=false NEXT_TELEMETRY_DISABLED=1

TABLETOP_MODE=standalone   node_modules/.bin/vite build --logLevel warn --outDir "$PWD/$generated/site"
node "$experiment/scripts/prepare.mjs" "$workos_port"
(
  cd "$experiment"
  bun run build:worker
)
wrangler="$experiment/node_modules/.bin/wrangler"
"$wrangler" d1 migrations apply DB --local --config "$generated/tabletop.json"   --persist-to "$generated/state"

FAKE_WORKOS_PORT="$workos_port" node e2e/fake-workos.ts &
workos_pid=$!
worker_pid=
stop() {
  if [[ -n "$worker_pid" ]]; then kill "$worker_pid" 2>/dev/null || true; fi
  kill "$workos_pid" 2>/dev/null || true
  wait "$worker_pid" "$workos_pid" 2>/dev/null || true
}
trap stop EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

"$wrangler" dev --port "$port" --ip 127.0.0.1 --local --show-interactive-dev-session=false   --config "$experiment/wrangler.jsonc" --config "$generated/tabletop.json"   --persist-to "$generated/state" &
worker_pid=$!
wait -n "$worker_pid" "$workos_pid"
