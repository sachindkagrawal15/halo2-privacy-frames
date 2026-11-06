import { useEffect, useState } from "react";
import { currentTransport, onRequest, type RequestLogEntry } from "../lib/rpc";
import { Card } from "./common";

/** Every request this page has made, and which network path it took. */
export function NetworkLog() {
  const [entries, setEntries] = useState<(RequestLogEntry & { at: number })[]>([]);
  useEffect(
    () =>
      onRequest((entry) => setEntries((list) => [{ ...entry, at: Date.now() }, ...list].slice(0, 200))),
    [],
  );
  // A local mempool node never leaves this machine, so it neither counts for nor against the share.
  const remote = entries.filter((e) => e.via !== "this machine");
  const anonymized = remote.filter((e) => e.via !== "direct").length;
  const share = remote.length ? Math.round((100 * anonymized) / remote.length) : 0;
  return (
    <Card
      title="Every request this page made"
      aside={
        <span className="pill">
          {entries.length} requests · {share}% via {currentTransport()}
        </span>
      }
    >
      <p className="muted">
        The prover runs in this tab and the page has no backend, so the only things that leave your machine are JSON-RPC calls, listed here as they happen. No analytics, no trackers.
      </p>
      <div className="log">
        {entries.length === 0 && <div className="muted">Nothing yet.</div>}
        {entries.slice(0, 40).map((e, i) => (
          <div key={i} className={`log-row ${e.ok ? "" : "failed"}`}>
            <span className="log-method">{e.method}</span>
            <span className="log-host">{new URL(e.url).host}</span>
            <span className="log-via">{e.via}</span>
            <span className="log-ms">{Math.round(e.ms)} ms</span>
          </div>
        ))}
      </div>
    </Card>
  );
}
