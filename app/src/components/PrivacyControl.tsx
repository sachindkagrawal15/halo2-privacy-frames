import { useEffect, useState } from "react";
import { ANON_NETWORKS, DEFAULT_NETWORK, onPrivacyChange, privacyState, routeThrough, type PrivacyState } from "../lib/anon";

const CHOICE_KEY = "ghostframe:network";

function savedChoice(): string {
  try {
    return localStorage.getItem(CHOICE_KEY) ?? DEFAULT_NETWORK;
  } catch {
    return DEFAULT_NETWORK;
  }
}

function choose(id: string) {
  try {
    localStorage.setItem(CHOICE_KEY, id);
  } catch {
    // a per-viewer convenience only
  }
  routeThrough(ANON_NETWORKS.find((n) => n.id === id) ?? null);
}

let started = false;

/** Picks the network path for every request. Anon-RPC unless the viewer chose otherwise. */
export function PrivacyControl() {
  const [state, setState] = useState<PrivacyState>(privacyState());
  const [choice, setChoice] = useState(savedChoice);

  useEffect(() => {
    const off = onPrivacyChange(setState);
    if (!started) {
      started = true;
      choose(choice);
    }
    return off;
  }, [choice]);

  const label =
    state.status === "ready"
      ? `requests via ${state.network.label}`
      : state.status === "connecting"
        ? `connecting to ${state.network.label}…`
        : state.status === "failed"
          ? `${state.network.label} unavailable`
          : "direct connection";
  const tone = state.status === "ready" ? "live" : state.status === "direct" || state.status === "failed" ? "warn" : "";

  return (
    <span className={`pill ${tone}`} title={state.status === "failed" ? state.reason : "Anon-RPC hides your IP from the RPC endpoints"}>
      {label}
      <select
        aria-label="Network path"
        value={choice}
        onChange={(e) => {
          setChoice(e.target.value);
          choose(e.target.value);
        }}
      >
        {ANON_NETWORKS.map((n) => (
          <option key={n.id} value={n.id}>
            Anon-RPC: {n.label}
          </option>
        ))}
        <option value="direct">Direct (no anonymity)</option>
      </select>
    </span>
  );
}

export function PrivacyBanner() {
  const [state, setState] = useState<PrivacyState>(privacyState());
  useEffect(() => onPrivacyChange(setState), []);
  if (state.status !== "failed") return null;
  return (
    <div className="banner">
      <b>{state.network.label} is unavailable</b> ({state.reason}). Requests are paused rather than sent without
      anonymity. Pick another network, or a direct connection, in the menu at the top.
    </div>
  );
}
