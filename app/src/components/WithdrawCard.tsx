import { useEffect, useState } from "react";
import { formatEther, isAddress, type Address } from "viem";
import { publicClient } from "../lib/chain";
import { EXPLORER_URL } from "../lib/constants";
import { STEPS, withdraw, type StepEvent, type StepId, type WithdrawResult } from "../lib/flow";
import { freshAccount } from "../lib/wallet";
import { prepareProver } from "../prover/client";
import { Card, Copy, Mono, shortHex } from "./common";

type StepState = Partial<Record<StepId, StepEvent>>;

export function WithdrawCard({ note, onNoteChange, onResult }: {
  note: string;
  onNoteChange: (note: string) => void;
  onResult: (result: WithdrawResult) => void;
}) {
  const [recipient, setRecipient] = useState<string>("");
  const [fresh, setFresh] = useState(false);
  const [steps, setSteps] = useState<StepState>({});
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<WithdrawResult>();
  const [received, setReceived] = useState<bigint>();
  const [error, setError] = useState<string>();
  const [prover, setProver] = useState<string>("idle");

  // Warm the prover up while the user is still reading: keygen takes a few seconds.
  useEffect(() => {
    if (!note) return;
    setProver((p) => (p === "idle" ? "loading" : p));
    prepareProver()
      .then((vk) => setProver(`ready · verifying key ${shortHex(vk)}`))
      .catch((e) => setProver(`failed to load: ${e instanceof Error ? e.message : String(e)}`));
  }, [note]);

  const newAddress = () => {
    setRecipient(freshAccount().address);
    setFresh(true);
  };

  const run = async () => {
    setRunning(true);
    setSteps({});
    setResult(undefined);
    setReceived(undefined);
    setError(undefined);
    try {
      const before = await publicClient.getBalance({ address: recipient as Address });
      const r = await withdraw(note, recipient as Address, (e) => setSteps((s) => ({ ...s, [e.id]: e })));
      setResult(r);
      onResult(r);
      const after = await publicClient.getBalance({ address: recipient as Address });
      setReceived(after - before);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  const valid = note.trim().length > 0 && isAddress(recipient);

  return (
    <Card step="2" title="Withdraw to an address with no ETH">
      <p className="muted">
        Paste a note, pick any recipient, even one that has never held ETH. Your browser proves the withdrawal and hands it straight to the mempool. No relayer, no gas top-up, nothing linking the two addresses.
      </p>
      <label className="label" htmlFor="note">Note</label>
      <textarea
        id="note"
        rows={3}
        value={note}
        placeholder="h2pf-v1-1337-0x…"
        onChange={(e) => onNoteChange(e.target.value)}
        spellCheck={false}
      />
      <label className="label" htmlFor="recipient">Recipient</label>
      <div className="row">
        <input
          id="recipient"
          value={recipient}
          placeholder="0x…"
          onChange={(e) => {
            setRecipient(e.target.value.trim());
            setFresh(false);
          }}
          spellCheck={false}
        />
        <button type="button" className="ghost-button" onClick={newAddress}>
          New address
        </button>
      </div>
      {fresh && <p className="hint">A freshly generated address: zero balance, zero history.</p>}
      {prover !== "idle" && (
        <p className="hint">
          Halo2 prover (WASM, in this tab): {prover === "loading" ? "loading parameters and rebuilding the proving key…" : prover}
        </p>
      )}
      <button type="button" className="primary" onClick={run} disabled={!valid || running}>
        {running ? "Withdrawing…" : "Withdraw privately"}
      </button>

      {Object.keys(steps).length > 0 && (
        <ol className="timeline">
          {STEPS.filter(({ id, optional }) => !optional || steps[id]).map(({ id, label }) => {
            const s = steps[id];
            return (
              <li key={id} className={`timeline-step ${s?.status ?? "pending"}`}>
                <span className="dot" aria-hidden />
                <div>
                  <div className="timeline-label">{label}</div>
                  {s?.detail && <div className="timeline-detail">{s.detail}</div>}
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {error && <p className="error">{error}</p>}

      {result && (
        <div className="result">
          <div className="result-amount">
            +{formatEther(received ?? result.amount)} ETH
            <span className="muted"> to {shortHex(result.recipient)}</span>
          </div>
          <dl>
            <dt>Paid for gas, from the note</dt>
            <dd>{formatEther(result.fee)} ETH</dd>
            <dt>Transaction</dt>
            <dd>
              <Mono title={result.hash}>{shortHex(result.hash, 10, 8)}</Mono> <Copy text={result.hash} />{" "}
              <a href={EXPLORER_URL} target="_blank" rel="noreferrer">explorer</a>
            </dd>
            <dt>Sender and gas payer</dt>
            <dd>the pool contract itself</dd>
            <dt>Reached the chain through</dt>
            <dd>
              {result.route === "alt-mempool"
                ? "the ERC-8421 alternative mempool"
                : result.route === "alt-mempool+privileged"
                  ? "admitted by the ERC-8421 alternative mempool; pushed into a block through ethrex's privileged submission (devnet shortcut) because the sidecar did not forward it"
                  : "ethrex's privileged submission (devnet shortcut): the alternative mempool refused it, see the timeline"}
            </dd>
            <dt>Proof generated in this tab</dt>
            <dd>{(result.proofMs / 1000).toFixed(1)} s</dd>
          </dl>
        </div>
      )}
    </Card>
  );
}
