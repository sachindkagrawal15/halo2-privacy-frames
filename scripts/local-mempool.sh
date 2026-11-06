#!/usr/bin/env bash
# Runs your own ERC-8421 alternative-mempool node (EF's sidecar, built from source) against the public
# EIP-8141 devnet's ethrex. It admits frame transactions under the same rules as the devnet's own node,
# with the core precompiles allowed in validation, and forwards what it admits to ethrex itself
# (ethrex_submitPrivilegedFrameTransaction), so it does not depend on the devnet node's relay.
#
#   scripts/local-mempool.sh      # the first run clones and builds the sidecar (a few minutes)
#
# Then point the scripts or the app at it:
#   H2PF_MEMPOOL_URL=http://localhost:14337/rpc npx tsx scripts/e2e.ts
#   http://localhost:5174/?mempool=http://localhost:14337/rpc
#
# Needs git and bun (brew install bun). Everything it creates lives in .local/ (git-ignored).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SIDECAR="$ROOT/.local/mempool-workshop-sidecar"
COMMIT=2e22ff0a2898e69ea4bf5275bce1be8581a8582a # forshtat/mempool-workshop-sidecar master, 2026-10-25
ETHREX="${ETHREX_URL:-https://altmempool.forshtat.com}"
PORT="${MEMPOOL_PORT:-14337}"
CONFIG="$ROOT/.local/mempool-config.json"

if [ ! -d "$SIDECAR" ]; then
  git clone https://github.com/forshtat/mempool-workshop-sidecar "$SIDECAR"
  git -C "$SIDECAR" checkout --quiet "$COMMIT"
fi
if [ ! -d "$SIDECAR/packages/cli/lib" ]; then
  # Public npm for this checkout only, like this repo's own .npmrc: a global registry override
  # (a company mirror, say) would otherwise apply to bun too.
  printf 'registry=https://registry.npmjs.org/\n' > "$SIDECAR/.npmrc"
  (cd "$SIDECAR" && BUN_CONFIG_REGISTRY=https://registry.npmjs.org/ bun install && bun run build)
fi

if [ ! -f "$CONFIG" ]; then
  # A throwaway relayer key: the privileged relay is unsigned and spends no gas, but the config needs one.
  RELAYER_KEY="0x$(openssl rand -hex 32)"
  PRECOMPILES=""
  for n in 01 02 03 04 05 06 07 08 09 0a 0b 0c 0d 0e 0f 10 11; do
    PRECOMPILES="$PRECOMPILES\"0x00000000000000000000000000000000000000$n\", "
  done
  cat > "$CONFIG" <<EOF
{
  "entryPoints": ["0x00000000000000000000000000000000000000aa"],
  "canonicalEntryPoint": "0x00000000000000000000000000000000000000aa",
  "standardMempoolId": "QmcFZKUX9qoo3StwVycJTAhwdiqbEjcwNvQVK246p3z1rk",
  "supportedMempools": [
    { "mempoolId": "QmcFZKUX9qoo3StwVycJTAhwdiqbEjcwNvQVK246p3z1rk",
      "entryPoint": "0x00000000000000000000000000000000000000aa" }
  ],
  "relayers": ["$RELAYER_KEY"],
  "rpcEndpoint": "$ETHREX",
  "rpcEndpointSubmit": "$ETHREX",
  "stakingRegistryAddress": "0xd51c04d7a0b01124e84de152f4e56d9eecb22d2f",
  "precompiles": [${PRECOMPILES}"0x0000000000000000000000000000000000000100"]
}
EOF
  chmod 600 "$CONFIG"
fi

echo "alt mempool on http://localhost:$PORT/rpc, against $ETHREX"
cd "$SIDECAR"
exec ./skandha standalone \
  --configFile "$CONFIG" --dataDir "$ROOT/.local/mempool-data" \
  --api.address 127.0.0.1 --api.port "$PORT" \
  --executor.bundlingMode auto --redirectRpc --explorer.enable
