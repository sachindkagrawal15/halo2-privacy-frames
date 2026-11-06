# Run your own alternative mempool

Withdrawals go to an ERC-8421 alternative-mempool node, the "sidecar" EF built for the
EIP-8141 devnet. You can run your own instead of the devnet's: it applies the same admission rules,
and forwards what it admits straight to the devnet's ethrex. Useful when the devnet's node is not
relaying, and for checking what a node of your own would admit.

[`scripts/local-mempool.sh`](../scripts/local-mempool.sh) does all of it:

1. clones `forshtat/mempool-workshop-sidecar` at a pinned commit into `.local/` (git-ignored) and
   builds it with `bun install && bun run build` (first run only, a few minutes);
2. writes `.local/mempool-config.json`, the devnet miner's config from EF's runbook with three changes:
   - both RPC endpoints point at the devnet's ethrex (`https://altmempool.forshtat.com`), which is
     what lets `--redirectRpc` and the privileged relay work;
   - `precompiles` lists 0x01 to 0x11 and 0x100, the precompiles ERC-7562 allows in validation (a
     proof verifier needs MODEXP, ecAdd, ecMul and the pairing);
   - a freshly generated, unfunded relayer key: the privileged relay is unsigned and spends no gas;
3. starts it in `standalone` mode (no p2p) on `http://localhost:14337/rpc`, with
   `--executor.bundlingMode auto` (the mode that relays admitted transactions) and the explorer API.

## Steps

```sh
brew install bun                      # once
scripts/local-mempool.sh              # leave it running
```

In another terminal, a full withdrawal through it:

```sh
H2PF_MEMPOOL_URL=http://localhost:14337/rpc npx tsx scripts/e2e.ts
```

Or the web app: `npm run dev`, then open `http://localhost:5174/?mempool=http://localhost:14337/rpc`.
Requests to your own machine skip the Anon-RPC mixnet (an exit node could not reach them anyway);
everything else still goes through it.

## What to expect

- The admission report (`skandha_explorer_getTransaction` on the local node) passes every rule:
  prefix, structure, gas limit, simulation, execution, OP-011, COD-010, storage. The pool must be
  staked: `npx tsx scripts/stake.ts`.
- `skandha_frameTransactionStatus` goes `New`, then `Submitted`, then `OnChain`; the never-funded
  recipient holds 0.1 ETH minus the fee.
- The canonical mempool still refuses the same transaction: validation is capped at 100k gas there.
