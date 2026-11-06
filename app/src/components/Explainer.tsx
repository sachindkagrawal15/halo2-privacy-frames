import type { WithdrawResult } from "../lib/flow";
import { WITHDRAW_GAS } from "../lib/frames";
import { Card } from "./common";

const k = (gas: bigint | number) => `${Math.round(Number(gas) / 1000)}k`;

/** What a withdrawal looks like on the wire. */
export function FrameAnatomy() {
  return (
    <Card title="Anatomy of a withdrawal">
      <div className="frame-tx">
        <div className="frame-tx-head">
          <span>EIP-8141 frame transaction</span>
          <span>
            sender <b>GhostPool</b> · payer <b>GhostPool</b> · signatures <b>none</b>
          </span>
        </div>
        <div className="frame verify">
          <div className="frame-title">
            <span className="frame-mode">frame 0 · VERIFY</span>
            <span className="frame-call">validateWithdrawal(proof, root)</span>
            <span className="frame-gas">{k(WITHDRAW_GAS.verifyExecution)} gas</span>
          </div>
          <ul>
            <li>exactly two frames; frame 1 calls <code>withdraw</code> on the pool with no value</li>
            <li>reads the nullifier hash, recipient and fee out of frame 1 itself</li>
            <li>frame 1 has enough gas to finish, and the transaction's max cost ≤ fee</li>
            <li>root is known, nullifier unspent</li>
            <li>Halo2 proof valid for [root, nullifier hash, recipient, fee]</li>
            <li>
              then <code>APPROVE(execution + payment)</code>: the pool agrees to pay the gas
            </li>
          </ul>
        </div>
        <div className="frame sender">
          <div className="frame-title">
            <span className="frame-mode">frame 1 · SENDER</span>
            <span className="frame-call">withdraw(nullifierHash, recipient, fee)</span>
            <span className="frame-gas">
              {k(WITHDRAW_GAS.withdrawExecution)} + {k(WITHDRAW_GAS.withdrawState)} state gas
            </span>
          </div>
          <ul>
            <li>marks the nullifier spent, sends 0.1 ETH − fee to the recipient</li>
            <li>the pool keeps the fee, which covers every unit of gas it just paid</li>
          </ul>
        </div>
      </div>
      <p className="muted">
        The proof plays the role of the signature. Whoever knows a note can authorize exactly one payout of it, to exactly the recipient and fee the proof names. Anyone who copies the transaction from the mempool can only deliver that same payout.
      </p>
    </Card>
  );
}

/** Why this transaction needs the alternative mempool, with the numbers from the latest withdrawal. */
export function MempoolTiers({ result }: { result?: WithdrawResult }) {
  const used = result?.validationGas;
  return (
    <Card title="Only an alternative mempool can carry it">
      <p className="muted">
        Checking the Halo2 proof costs about 290k gas on this devnet, inside the validation frame. Mempools cap validation gas, because a node simulates it for free before the transaction pays anything.
      </p>
      <table className="tiers">
        <thead>
          <tr>
            <th>Mempool</th>
            <th>Validation cap</th>
            <th>This withdrawal{used ? ` (${k(used)})` : ""}</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Canonical (EIP-8141)</td>
            <td>100k</td>
            <td className="no">refused</td>
          </tr>
          <tr>
            <td>ERC-8421 alternative, unstaked sender</td>
            <td>100k</td>
            <td className="no">refused</td>
          </tr>
          <tr>
            <td>ERC-8421 alternative, staked sender (GhostPool stakes itself)</td>
            <td>raised for staked entities</td>
            <td className="yes">admitted</td>
          </tr>
        </tbody>
      </table>
      {result && (
        <p className="status">
          Canonical mempool, this withdrawal: <i>{result.canonicalVerdict}</i>
        </p>
      )}
      {result?.route === "privileged" && (
        <p className="warning">
          Alternative mempool, this withdrawal: refused (<i>{result.altVerdict}</i>), so it was included through
          ethrex's privileged submission instead.
        </p>
      )}
      {result && result.route !== "privileged" && (
        <p className="status">
          Alternative mempool, this withdrawal: admitted
          {result.route === "alt-mempool+privileged" ? ", then pushed into a block through ethrex's privileged submission because the sidecar did not forward it" : " and included"}.
        </p>
      )}
    </Card>
  );
}
