/**
 * Every request the app makes goes through `transport`. It is plain `fetch` until the app swaps in
 * Anon-RPC's anonymized fetch (see anon.ts), so there is exactly one network path to audit.
 */
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

let transport: Fetch = (input, init) => fetch(input, init);
const listeners = new Set<(entry: RequestLogEntry) => void>();

export interface RequestLogEntry {
  url: string;
  method: string;
  via: string;
  ok: boolean;
  ms: number;
}

let transportName = "direct";

export function setTransport(fetchFn: Fetch, name: string) {
  transport = fetchFn;
  transportName = name;
}

export const currentTransport = () => transportName;

export function onRequest(listener: (entry: RequestLogEntry) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Your own machine (a local mempool node): nothing to hide, and a mixnet's exit could not reach it anyway. */
const isLocal = (url: string) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(url);

/** The app's fetch: what viem gets as `fetchFn`, logged like every other call. */
export const appFetch: Fetch = async (input, init) => {
  const started = performance.now();
  const method = typeof init?.body === "string" ? (safeMethod(init.body) ?? "?") : "?";
  const local = isLocal(input);
  const via = local ? "this machine" : transportName;
  try {
    const response = await (local ? fetch(input, init) : transport(input, init));
    emit({ url: input, method, via, ok: response.ok, ms: performance.now() - started });
    return response;
  } catch (e) {
    emit({ url: input, method, via, ok: false, ms: performance.now() - started });
    throw e;
  }
};

function safeMethod(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body);
    return Array.isArray(parsed) ? parsed.map((p) => p.method).join(",") : parsed.method;
  } catch {
    return undefined;
  }
}

function emit(entry: RequestLogEntry) {
  for (const listener of listeners) listener(entry);
}

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

export async function rpc<T = unknown>(url: string, method: string, params: unknown[] = []): Promise<T> {
  const response = await appFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await response.json().catch(() => {
    throw new RpcError(`${url} answered HTTP ${response.status} without JSON`);
  });
  if (body.error) throw new RpcError(body.error.message, body.error.code, body.error.data);
  return body.result as T;
}
