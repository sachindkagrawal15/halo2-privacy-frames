import { useState } from "react";
import { DepositCard } from "./components/DepositCard";
import { FrameAnatomy, MempoolTiers } from "./components/Explainer";
import { NetworkLog } from "./components/NetworkLog";
import { PrivacyBanner, PrivacyControl } from "./components/PrivacyControl";
import { formatAge, useChainStatus } from "./components/useChainStatus";
import { WithdrawCard } from "./components/WithdrawCard";
import { CHAIN_ID, GATEWAY_URL, MEMPOOL_URL } from "./lib/constants";
import { deployment } from "./lib/deployment";
import type { WithdrawResult } from "./lib/flow";
import { Mono, shortHex } from "./components/common";

const REPO_URL = "https://github.com/";

/** docs/logo.svg without its tile: the ghost under a halo, between the VERIFY and SENDER frames. */
function Logo() {
  return (
    <svg className="logo" viewBox="40 40 432 432" aria-hidden>
      <path className="verify" d="M64 152V96a32 32 0 0 1 32-32h56M360 64h56a32 32 0 0 1 32 32v56" />
      <path className="sender" d="M64 360v56a32 32 0 0 0 32 32h56M360 448h56a32 32 0 0 0 32-32v-56" />
      <ellipse className="halo" cx="256" cy="135.5" rx="64" ry="18" />
      <g transform="translate(112 149.5) scale(9)">
        <path d="M16 3c-6 0-10 4.5-10 10.5V28l3.3-2.4L12.7 28 16 25.6 19.3 28l3.4-2.4L26 28V13.5C26 7.5 22 3 16 3z" />
        <circle cx="12.5" cy="13.5" r="2" className="eye" />
        <circle cx="19.5" cy="13.5" r="2" className="eye" />
      </g>
    </svg>
  );
}

function ChainPill() {
  const { block, age, error } = useChainStatus();
  if (block === undefined) return <span className="pill">{error ? "devnet unreachable" : "connecting…"}</span>;
  const stalled = (age ?? 0) > 60;
  return (
    <span className={`pill ${stalled ? "warn" : "live"}`} title={stalled ? "The devnet has not produced a block recently" : undefined}>
      devnet {CHAIN_ID} · block {block.toString()}
      {stalled ? ` · stalled ${formatAge(age!)}` : ""}
    </span>
  );
}

export function App() {
  const [note, setNote] = useState("");
  const [result, setResult] = useState<WithdrawResult>();
  return (
    <div className="page">
      <header className="top">
        <div className="brand">
          <Logo />
          <span>Halo2 Privacy Frames</span>
        </div>
        <div className="pills">
          <PrivacyControl />
          <ChainPill />
          {deployment.pool && (
            <span className="pill" title={deployment.pool}>
              pool <Mono>{shortHex(deployment.pool)}</Mono>
            </span>
          )}
          {MEMPOOL_URL !== GATEWAY_URL && (
            <span className="pill" title={MEMPOOL_URL}>
              mempool <Mono>{new URL(MEMPOOL_URL).host}</Mono>
            </span>
          )}
        </div>
      </header>
      <PrivacyBanner />

      <section className="hero">
        <h1>Private withdrawals that pay their own gas.</h1>
        <p>
          Deposit 0.1 ETH, then withdraw it to a brand-new address that has never held ETH. There is no relayer and no gas top-up to link the two. A Halo2 proof, checked inside an EIP-8141 VERIFY frame, lets the pool pay for its own withdrawal.
        </p>
        <div className="facts">
          <div>
            <b>Halo2</b>
            <span>KZG on BN254, proven in your tab</span>
          </div>
          <div>
            <b>~290k gas</b>
            <span>to verify the proof, inside the VERIFY frame</span>
          </div>
          <div>
            <b>0 relayers</b>
            <span>the pool is sender and payer</span>
          </div>
        </div>
      </section>

      <main className="grid">
        <DepositCard onNote={setNote} />
        <WithdrawCard note={note} onNoteChange={setNote} onResult={setResult} />
        <FrameAnatomy />
        <MempoolTiers result={result} />
        <div className="span-2">
          <NetworkLog />
        </div>
      </main>

      <footer className="foot">
        <p>
          Devnet only, unaudited, built at ETHGlobal Mumbai 2026. Open source (MIT): <a href={REPO_URL}>source</a>. Built on EIP-8141 frame transactions, the ERC-8421 alternative mempool and Anon-RPC, from the Ethereum Foundation.
        </p>
      </footer>
    </div>
  );
}
