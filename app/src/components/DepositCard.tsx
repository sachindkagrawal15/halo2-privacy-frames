import { useCallback, useEffect, useState } from "react";
import { formatEther, parseEther } from "viem";
import { publicClient, requestFaucet } from "../lib/chain";
import { denomination, deployment } from "../lib/deployment";
import { deposit } from "../lib/flow";
import { loadBurner } from "../lib/wallet";
import { Card, Copy, Mono, shortHex } from "./common";

const burner = loadBurner();
const GAS_RESERVE = parseEther("0.02");

export function DepositCard({ onNote }: { onNote: (note: string) => void }) {
  const [balance, setBalance] = useState<bigint>();
  const [busy, setBusy] = useState<"faucet" | "deposit">();
  const [note, setNote] = useState<string>();
  const [status, setStatus] = useState<string>();
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    try {
      setBalance(await publicClient.getBalance({ address: burner.address }));
    } catch {
      // the header already reports an unreachable devnet
    }
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 6_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const fund = async () => {
    setBusy("faucet");
    setError(undefined);
    try {
      await requestFaucet(burner.address);
      setStatus("Faucet request sent: 1 devnet ETH arrives in the next block or two.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(undefined);
    }
  };

  const run = async () => {
    setBusy("deposit");
    setError(undefined);
    setStatus("Sending the deposit…");
    try {
      const { blockNumber } = await deposit(burner, (text) => {
        setNote(text);
        onNote(text);
      });
      setStatus(`Deposited in block ${blockNumber}. Your 0.1 ETH is now one of the pool's anonymity set.`);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus(undefined);
    } finally {
      setBusy(undefined);
    }
  };

  const canDeposit = deployment.pool && balance !== undefined && balance >= denomination + GAS_RESERVE && !busy;

  return (
    <Card step="1" title={`Deposit ${formatEther(denomination)} ETH`}>
      <p className="muted">
        Deposits are ordinary public transactions. Use this tab's throwaway devnet wallet; devnet ETH is free and worthless.
      </p>
      <div className="row">
        <div>
          <div className="label">Devnet wallet (this browser only)</div>
          <Mono title={burner.address}>{shortHex(burner.address)}</Mono>{" "}
          <span className="muted">{balance === undefined ? "…" : `${Number(formatEther(balance)).toFixed(4)} ETH`}</span>
        </div>
        <button type="button" className="ghost-button" onClick={fund} disabled={!!busy}>
          {busy === "faucet" ? "Asking the faucet…" : "Get devnet ETH"}
        </button>
      </div>
      <button type="button" className="primary" onClick={run} disabled={!canDeposit}>
        {busy === "deposit" ? "Depositing…" : `Deposit ${formatEther(denomination)} ETH`}
      </button>
      {!deployment.pool && <p className="warning">The pool is not deployed on this devnet yet.</p>}
      {note && (
        <div className="note">
          <div className="label">Your note: the only key to this deposit</div>
          <textarea readOnly value={note} rows={3} onFocus={(e) => e.currentTarget.select()} />
          <div className="row">
            <Copy text={note} label="Copy note" />
            <a
              className="ghost-button small"
              download="halo2-privacy-frames-note.txt"
              href={`data:text/plain;charset=utf-8,${encodeURIComponent(note)}`}
            >
              Download
            </a>
            <span className="warning-inline">Anyone holding it can withdraw. Nobody can recover it.</span>
          </div>
        </div>
      )}
      {status && <p className="status">{status}</p>}
      {error && <p className="error">{error}</p>}
    </Card>
  );
}
