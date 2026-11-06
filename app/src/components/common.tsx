import { useState, type ReactNode } from "react";

export const shortHex = (h: string, head = 6, tail = 4) => (h.length > head + tail + 2 ? `${h.slice(0, head + 2)}…${h.slice(-tail)}` : h);

export function Copy({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="ghost-button small"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // clipboard blocked: the text is selectable anyway
        }
      }}
    >
      {copied ? "Copied" : label}
    </button>
  );
}

export function Mono({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <code className="mono" title={title}>
      {children}
    </code>
  );
}

export function Card({ step, title, children, aside }: { step?: string; title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="card">
      <header className="card-header">
        <h2>
          {step && <span className="step-number">{step}</span>}
          {title}
        </h2>
        {aside}
      </header>
      {children}
    </section>
  );
}
