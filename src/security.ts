import type { SpendControls } from "@coinbase/cdp-sdk/x402";
import { getAddress, keccak256, toBytes, verifyTypedData } from "viem";

// Pure security/validation logic for the plugin — deliberately free of any
// runtime dependency on the CDP SDK (only a type-only import), so it can be
// unit-tested and reasoned about in isolation from wallet/network code.

/**
 * Assets vendidos pelo serviço. `ETH_STAKING` (staking líquido de ETH na
 * Ethereum mainnet) estava FALTANDO até a 0.2.1 — o parser rejeitava a resposta
 * com "unexpected asset" e o client montava uma URL inexistente, então o plugin
 * simplesmente não conseguia consumir esse produto. É justamente o asset com o
 * melhor histórico verificado de acurácia no serviço.
 */
export type YieldSignalAsset = "USDC" | "WETH" | "ETH_STAKING";

export const YIELD_SIGNAL_ASSETS: readonly YieldSignalAsset[] = ["ETH_STAKING", "USDC", "WETH"];

/**
 * Caminho canônico por asset. Mapa EXPLÍCITO em vez de montar a URL a partir do
 * nome do asset: a versão anterior fazia `/signal/${asset.toLowerCase()}-base-yield`,
 * que para `ETH_STAKING` gerava `/signal/eth_staking-base-yield` — underscore em
 * vez de hífen E o sufixo errado, dois erros de uma vez. Rota de recurso pago
 * não é lugar pra derivação de string.
 */
export const YIELD_SIGNAL_PATHS: Record<YieldSignalAsset, string> = {
  ETH_STAKING: "/signal/eth-staking-yield",
  USDC: "/signal/usdc-base-yield",
  WETH: "/signal/weth-base-yield",
};

// --- Fixed facts about the service being paid --------------------------------
// WHO gets paid, on WHICH chain, in WHICH asset. Pinned here so the wallet can
// never be redirected to a different payee/asset/network by a tampered or
// swapped server: the CDP SDK enforces these as hard allowlists (spend
// controls), and the EIP-712 verification independently re-checks the signer
// against the same payee.
export const YIELDSIGNAL_PAYEE = getAddress(
  "0x561143BFE9E2D975D92e915B8EfFEAa54119472a",
);
/** USDC (6 decimals) on Base mainnet — the only asset this plugin will pay in. */
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
/** Base mainnet in CAIP-2 form (the x402 `network` field is CAIP-2). */
const ALLOWED_NETWORK = "eip155:8453";

// Advertised prices are $0.01 (signal) and $0.05 (decision) in USDC (6
// decimals → atomic units). The per-call cap is $0.10 = 100_000 atomic:
// comfortably above the premium price, but a server that suddenly demands $5
// is rejected before the wallet ever signs. The rolling 24h ceiling ($2.00)
// stops a runaway loop from draining the wallet even if each call is in-bounds.
const MAX_PER_CALL_ATOMIC = 100_000n;
const MAX_CUMULATIVE_ATOMIC = 2_000_000n;

/**
 * The hard spend policy handed to the CDP SDK. The SDK only enforces controls
 * when explicitly provided — so this is what turns the advertised "$0.01/call"
 * into an actual client-side guarantee: per-payment cap, rolling cumulative
 * cap, and fixed allowlists for network, asset and payee. Exported so tests and
 * callers can inspect exactly what the wallet is constrained to.
 */
export function buildSpendControls(): SpendControls {
  return {
    maxAmountPerPayment: { atomic: MAX_PER_CALL_ATOMIC, asset: BASE_USDC },
    maxCumulativeSpend: { atomic: MAX_CUMULATIVE_ATOMIC, asset: BASE_USDC },
    maxCumulativeSpendWindow: "24h",
    allowedNetworks: [ALLOWED_NETWORK],
    allowedAssets: [BASE_USDC],
    allowedPayees: [YIELDSIGNAL_PAYEE],
  };
}

/** One protocol's reading inside a signal response. */
export interface YieldSignalRate {
  protocol: string;
  apyBps: number;
  weightedApyBps: number;
  source: string;
  asOf: string;
}

/** Validated shape of a YieldSignal response body. */
export interface YieldSignalResponse {
  asset: YieldSignalAsset;
  bestProtocol: string;
  gapBps: number;
  rates: YieldSignalRate[];
  asOf: string;
  /**
   * Protocols the service tries to read for this asset but that are NOT in this
   * response (source failed, or the pool went mute). Optional because older
   * deployments don't send it — but when present it matters a lot: without it
   * "best protocol" silently means "best of whatever answered". An agent
   * allocating real capital should treat a partial reading as a weaker claim.
   */
  omittedProtocols?: string[];
  coverage?: { read: number; expected: number };
  /**
   * Protocols whose incentive (reward-token) component could not be
   * established — their APY is a floor, so the ranking could be inverted by an
   * unmeasured campaign.
   */
  incompleteRewardData?: string[];
  /** How the APYs are defined (e.g. "supply-apy-total-incl-rewards"). */
  apyBasis?: string;
}

function isRate(v: unknown): v is YieldSignalRate {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.protocol === "string" &&
    typeof r.apyBps === "number" &&
    typeof r.weightedApyBps === "number" &&
    typeof r.source === "string" &&
    typeof r.asOf === "string"
  );
}

/**
 * Runtime schema validation of the response body — the paid call must not be
 * trusted just because it returned 200. Throws on anything that doesn't match
 * the expected shape rather than casting `unknown` and hoping.
 */
export function parseYieldSignalResponse(raw: string): YieldSignalResponse {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("YieldSignal response was not valid JSON");
  }
  if (typeof data !== "object" || data === null) {
    throw new Error("YieldSignal response was not a JSON object");
  }
  const d = data as Record<string, unknown>;
  if (!YIELD_SIGNAL_ASSETS.includes(d.asset as YieldSignalAsset)) {
    throw new Error(`YieldSignal response has an unexpected asset: ${String(d.asset)}`);
  }
  if (
    typeof d.bestProtocol !== "string" ||
    typeof d.gapBps !== "number" ||
    typeof d.asOf !== "string"
  ) {
    throw new Error(
      "YieldSignal response is missing required fields (bestProtocol/gapBps/asOf)",
    );
  }
  if (!Array.isArray(d.rates) || !d.rates.every(isRate)) {
    throw new Error("YieldSignal response has a malformed rates array");
  }
  return {
    asset: d.asset as YieldSignalAsset,
    bestProtocol: d.bestProtocol,
    gapBps: d.gapBps,
    rates: d.rates as YieldSignalRate[],
    asOf: d.asOf,
    // Passados adiante SÓ quando bem-formados. Campo ausente ou malformado
    // nunca derruba a resposta: uma versão mais nova do servidor não pode
    // quebrar um plugin já instalado, e uma mais velha simplesmente não manda.
    ...(isStringArray(d.omittedProtocols) ? { omittedProtocols: d.omittedProtocols } : {}),
    ...(isCoverage(d.coverage) ? { coverage: d.coverage } : {}),
    ...(isStringArray(d.incompleteRewardData) ? { incompleteRewardData: d.incompleteRewardData } : {}),
    ...(typeof d.apyBasis === "string" ? { apyBasis: d.apyBasis } : {}),
  };
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((item) => typeof item === "string");
}

function isCoverage(v: unknown): v is { read: number; expected: number } {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Record<string, unknown>;
  return typeof c.read === "number" && typeof c.expected === "number";
}

/**
 * Verifies the EIP-712 signature the service attaches to every response, so the
 * advertised "signed responses" claim is actually enforced client-side. Two
 * independent checks, both must pass:
 *   1. The embedded `contentHash` equals `keccak256(raw)` — proves the signed
 *      struct refers to THESE exact bytes, not some other payload.
 *   2. `viem.verifyTypedData` confirms the signature is valid for the signer,
 *      and the signer is pinned to the advertised payee (`expectedSigner`).
 * Verification runs over the raw bytes (never a re-serialized copy, which could
 * differ byte-for-byte). Returns false — never throws — on any failure.
 */
export async function verifyYieldSignalSignature(params: {
  raw: string;
  signature: `0x${string}`;
  signer: `0x${string}`;
  eip712Json: string;
  /** Address the signer must match. Defaults to the advertised payee. */
  expectedSigner?: `0x${string}`;
}): Promise<boolean> {
  const { raw, signature, signer, eip712Json } = params;
  const expected = params.expectedSigner ?? YIELDSIGNAL_PAYEE;

  // Pin the signer to the advertised payment-receiving address: a validly
  // signed payload is still rejected if it wasn't signed by who we're paying.
  let normalizedSigner: `0x${string}`;
  let normalizedExpected: `0x${string}`;
  try {
    normalizedSigner = getAddress(signer);
    normalizedExpected = getAddress(expected);
  } catch {
    return false;
  }
  if (normalizedSigner !== normalizedExpected) return false;

  let parsed: {
    domain: { name: string; version: string; chainId: number };
    types: { YieldSignal: { name: string; type: string }[] };
    primaryType: "YieldSignal";
    message: {
      asset: string;
      bestProtocol: string;
      weightedApyBps: string;
      gapBps: string;
      asOf: string;
      contentHash: `0x${string}`;
    };
  };
  try {
    parsed = JSON.parse(eip712Json);
  } catch {
    return false;
  }
  const { domain, types, primaryType, message } = parsed;

  if (message.contentHash !== keccak256(toBytes(raw))) return false;

  try {
    return await verifyTypedData({
      address: normalizedSigner,
      domain,
      types,
      primaryType,
      message: {
        ...message,
        weightedApyBps: BigInt(message.weightedApyBps),
        gapBps: BigInt(message.gapBps),
        asOf: BigInt(message.asOf),
      },
      signature,
    });
  } catch {
    return false;
  }
}

// Explicit-intent gate: the GET_YIELD_SIGNAL action spends money (a paid x402
// call), so it must only be eligible when the message is actually about lending
// yield — not on every message. A bare asset mention ("I hold some USDC") is not
// enough; the text must express a yield/rate intent.
// `stake|staking` entrou na 0.2.1 junto com o suporte a ETH_STAKING: sem isso,
// "best ETH staking yield?" só passava pelo termo genérico "yield" e um pedido
// como "where should I stake my ETH?" não acionava a action de jeito nenhum.
const YIELD_INTENT =
  /\b(yield|apy|apr|lending|lend|interest|stake|staking|supply\s+rate|borrow\s+rate|best\s+rate|best\s+.*\brate)\b/i;

export function hasYieldIntent(text: string): boolean {
  return YIELD_INTENT.test(text);
}
