import { useEffect, useState } from "react";
import { publicClient } from "../lib/chain";

export interface ChainStatus {
  block?: bigint;
  /** Seconds since the latest block. */
  age?: number;
  error?: string;
}

/** Polls the devnet head. The devnet can stall or be reset, and the page says so instead of hanging. */
export function useChainStatus(intervalMs = 6_000): ChainStatus {
  const [status, setStatus] = useState<ChainStatus>({});
  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      try {
        const block = await publicClient.getBlock({ blockTag: "latest" });
        if (!stopped) setStatus({ block: block.number, age: Math.max(0, Date.now() / 1000 - Number(block.timestamp)) });
      } catch (e) {
        if (!stopped) setStatus((s) => ({ ...s, error: e instanceof Error ? e.message : String(e) }));
      }
    };
    poll();
    const timer = setInterval(poll, intervalMs);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [intervalMs]);
  return status;
}

export function formatAge(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)} s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
  return `${(seconds / 3600).toFixed(1)} h`;
}
