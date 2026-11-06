# Demo script (under 3 minutes)

Record in one take with the app open, a note already deposited (deposits take a block or two), and a
second browser window ready. Times are cumulative.

**0:00 – 0:25 · The problem.** "Every privacy pool breaks at the last step: gas. To withdraw to a fresh
address you either fund it first, which links it to you, or you trust a relayer that can censor you and
sees your IP. Halo2 Privacy Frames removes both."

**0:25 – 0:50 · Deposit.** Click *Get devnet ETH*, then *Deposit 0.1 ETH*. Point at the note: "This
string is the only key to the deposit. It never leaves the browser."

**0:50 – 1:50 · Withdraw to an address that has never held ETH.** Paste the note, click *New address*
("zero balance, zero history"), click *Withdraw privately*. Narrate the timeline as it runs:

1. the tree is rebuilt from chain events: no indexer;
2. the Halo2 prover rebuilds its proving key in the tab, and it matches the key in the on-chain verifier;
3. the fee is sized to the transaction's maximum gas cost, and the proof commits to it;
4. the proof is generated in the tab, about 12 seconds;
5. ethrex's dry run: both frames succeed;
6. **the canonical mempool refuses it**: read out "prefix gas budget exceeded: 700000 > 100000";
7. the ERC-8421 alternative mempool admits it, because the pool is staked;
8. it is mined: the fresh address now holds 0.1 ETH minus the fee.

**1:50 – 2:25 · Why it works.** Scroll to *Anatomy of a withdrawal*: "The pool is the sender and the gas
payer. There is no signature: frame 0 checks the Halo2 proof, the frame shape, and that the fee covers
the maximum gas cost, then calls APPROVE. Frame 1 pays out." Scroll to the mempool table: "about
290 thousand gas of validation: only a staked entity in the alternative mempool can carry it."

**2:25 – 2:50 · Network privacy.** Scroll to *Every request this page made*: "100 percent of requests
went through Anon-RPC over the Nox mixnet, one isolation key per withdrawal. No backend, no trackers."

**2:50 – 3:00 · Close.** "Private withdrawals that pay their own gas. Open source, on EF's frame
transaction devnet."

## Before recording

- Check the header: the devnet pill must say a block number, not *stalled*; the network pill must say
  *requests via Nox mixnet*.
- Warm the prover up by pasting the note first: keygen runs while you talk.
- If the devnet was reset, run `npx tsx scripts/deploy.ts`, rebuild, and deposit again.
