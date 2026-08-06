import { CdpX402Client } from "@coinbase/cdp-sdk/x402";
import { wrapFetchWithPayment } from "@x402/fetch";
import {
  buildSpendControls,
  parseYieldSignalResponse,
  verifyYieldSignalSignature,
  YIELD_SIGNAL_PATHS,
  REPORT_PATHS,
  type LendingAsset,
  type ReportKind,
  type YieldSignalAsset,
  type YieldSignalResponse,
} from "./security.js";

// Re-exported so consumers keep importing these from the client entry point.
export {
  buildSpendControls,
  parseYieldSignalResponse,
  verifyYieldSignalSignature,
  YIELDSIGNAL_PAYEE,
  YIELD_SIGNAL_ASSETS,
  YIELD_SIGNAL_PATHS,
  LENDING_ASSETS,
  REPORT_KINDS,
  REPORT_PATHS,
  KNOWN_PROTOCOLS,
  buildPositionsParam,
} from "./security.js";
export type {
  LendingAsset,
  ReportKind,
  YieldSignalAsset,
  YieldSignalRate,
  YieldSignalResponse,
} from "./security.js";

const YIELDSIGNAL_BASE_URL = "https://yieldsignal.vercel.app";
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Real-time, risk-weighted USDC/WETH lending APY across Aave, Compound, Morpho,
 * Moonwell, Euler and Fluid on Base — bought per call via x402 ($0.01), paid
 * through the agent's own CDP wallet (CDP_API_KEY_ID/CDP_API_KEY_SECRET/
 * CDP_WALLET_SECRET env vars). Enforces four things the SDK does not do on its
 * own: (1) a hard spend policy (per-call + cumulative caps, network/asset/payee
 * allowlists) via {@link buildSpendControls}; (2) a bounded fetch that aborts if
 * the server hangs; (3) runtime schema validation of the body; (4) EIP-712
 * signature verification against the advertised payee, refusing any unsigned or
 * tampered response. See https://yieldsignal.vercel.app.
 */
export async function fetchYieldSignal(
  asset: YieldSignalAsset,
  opts: { timeoutMs?: number } = {},
): Promise<YieldSignalResponse> {
  const client = new CdpX402Client({ spendControls: buildSpendControls() });
  const fetchWithPayment = wrapFetchWithPayment(
    fetch,
    // `CdpX402Client` fulfils the payment contract at runtime; the narrow is
    // only needed because a workspace install can resolve two copies of
    // `@x402/core`, making the two `x402Client` types structurally diverge.
    client as unknown as Parameters<typeof wrapFetchWithPayment>[1],
  );

  // Bounded I/O: abort the paid fetch if the server hangs so a single call can
  // never block the agent indefinitely.
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  let res: Response;
  try {
    res = await fetchWithPayment(`${YIELDSIGNAL_BASE_URL}${YIELD_SIGNAL_PATHS[asset]}`, {
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new Error(
      `YieldSignal request failed: ${res.status} ${await res.text()}`,
    );
  }

  // Read raw bytes first (not res.json()) so signature verification runs over
  // exactly the bytes that were signed.
  const raw = await res.text();
  const parsed = parseYieldSignalResponse(raw);

  const signature = res.headers.get("x-signal-signature") as `0x${string}` | null;
  const signer = res.headers.get("x-signal-signer") as `0x${string}` | null;
  const eip712Json = res.headers.get("x-signal-eip712-payload");
  if (!signature || !signer || !eip712Json) {
    throw new Error(
      "YieldSignal response was not signed (missing X-Signal-* headers) — refusing to trust an unauthenticated paid response",
    );
  }
  const ok = await verifyYieldSignalSignature({ raw, signature, signer, eip712Json });
  if (!ok) {
    throw new Error(
      "YieldSignal response failed EIP-712 verification (signer/contentHash mismatch) — refusing to trust a tampered response",
    );
  }

  return parsed;
}

/** Corpo de um relatório analítico: o relatório + o sinal assinado + o texto verbatim. */
export interface YieldReport {
  signal: YieldSignalResponse;
  /** Texto EXATO que foi assinado — permite conferir o contentHash sem re-serializar. */
  signedSignalText: string;
  [field: string]: unknown;
}

/**
 * Compra um dos quatro relatórios analíticos, com as MESMAS quatro proteções do
 * `fetchYieldSignal`: política de gasto, fetch com timeout, validação de schema
 * e verificação EIP-712 obrigatória.
 *
 * A verificação aqui tem uma diferença que importa: nas rotas analíticas a
 * assinatura cobre o SINAL EMBUTIDO, não o corpo inteiro (o relatório é função
 * determinística das mesmas leituras). Então além de conferir a assinatura
 * sobre `signedSignalText`, este código confere que esse texto assinado
 * DESCREVE o `signal` que veio no corpo — senão um servidor poderia assinar um
 * sinal e embutir outro, e a verificação passaria enganada.
 */
export async function fetchYieldReport(
  kind: ReportKind,
  asset: LendingAsset,
  opts: { query?: Record<string, string | number | undefined>; timeoutMs?: number } = {},
): Promise<YieldReport> {
  const client = new CdpX402Client({ spendControls: buildSpendControls() });
  const fetchWithPayment = wrapFetchWithPayment(
    fetch,
    client as unknown as Parameters<typeof wrapFetchWithPayment>[1],
  );

  const qs = Object.entries(opts.query ?? {})
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
  const url = `${YIELDSIGNAL_BASE_URL}${REPORT_PATHS[kind][asset]}${qs ? `?${qs}` : ""}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchWithPayment(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new Error(`YieldSignal ${kind} request failed: ${res.status} ${await res.text()}`);
  }

  const raw = await res.text();
  let body: YieldReport;
  try {
    body = JSON.parse(raw) as YieldReport;
  } catch {
    throw new Error(`YieldSignal ${kind} returned a body that is not valid JSON`);
  }
  if (typeof body.signedSignalText !== "string" || body.signal === undefined) {
    throw new Error(
      `YieldSignal ${kind} response is missing the embedded signed signal — refusing to trust an unverifiable paid response`,
    );
  }

  // O texto assinado tem que descrever o sinal que veio no corpo.
  const assinado = parseYieldSignalResponse(body.signedSignalText);
  if (JSON.stringify(assinado) !== JSON.stringify(body.signal)) {
    throw new Error(
      `YieldSignal ${kind} signed a different signal than the one embedded in the body — refusing a mismatched response`,
    );
  }

  const signature = res.headers.get("x-signal-signature") as `0x${string}` | null;
  const signer = res.headers.get("x-signal-signer") as `0x${string}` | null;
  const eip712Json = res.headers.get("x-signal-eip712-payload");
  if (!signature || !signer || !eip712Json) {
    throw new Error(
      `YieldSignal ${kind} response was not signed (missing X-Signal-* headers) — refusing to trust an unauthenticated paid response`,
    );
  }
  const ok = await verifyYieldSignalSignature({
    raw: body.signedSignalText,
    signature,
    signer,
    eip712Json,
  });
  if (!ok) {
    throw new Error(
      `YieldSignal ${kind} response failed EIP-712 verification (signer/contentHash mismatch) — refusing to trust a tampered response`,
    );
  }

  return body;
}
