import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { fetchYieldReport, type YieldReport } from "../client.js";
import { buildPositionsParam, KNOWN_PROTOCOLS, type LendingAsset, type ReportKind } from "../security.js";

/**
 * Asset para os quatro produtos analíticos.
 *
 * NÃO reaproveita `parseAsset` de propósito: aquele devolve `ETH_STAKING` para
 * "ETH", e as rotas analíticas não existem para staking. Cair lá faria o agente
 * pagar por um 404. Aqui, "ETH" sem qualificação é WETH — o único mercado de
 * empréstimo de ETH que estas rotas cobrem.
 */
export function parseLendingAsset(text: string): LendingAsset {
  if (/\busdc\b/i.test(text)) return "USDC";
  if (/\bweth\b|\beth\b/i.test(text)) return "WETH";
  return "USDC";
}

/** "200k", "$1.5m", "250000" → número em USD. `null` quando não há valor no texto. */
export function parseUsdAmount(text: string): number | null {
  const m = /\$?\s*([0-9][0-9_.,]*)\s*(k|m)?\b/i.exec(text.replace(/\b(usdc|weth|eth|aave|morpho|compound|moonwell|euler|fluid)\b/gi, ""));
  if (!m) return null;
  const base = Number(m[1]!.replace(/[_,]/g, ""));
  if (!Number.isFinite(base) || base <= 0) return null;
  const mult = m[2]?.toLowerCase() === "m" ? 1_000_000 : m[2]?.toLowerCase() === "k" ? 1_000 : 1;
  return Math.round(base * mult);
}

/**
 * Posições a partir de texto livre: "200k in aave and 150k in morpho".
 *
 * Devolve `null` quando não reconhece nada — e aí a ação PEDE o dado em vez de
 * chutar uma carteira. Um relatório de risco montado sobre posição inventada é
 * pior que nenhum relatório, e o agente já teria pago por ele.
 */
export function parsePositions(text: string): Record<string, number> | null {
  const found: Record<string, number> = {};
  for (const protocolo of KNOWN_PROTOCOLS) {
    // Aceita "aave 200k", "aave: 200000", "200k in aave" e "200k aave".
    //
    // `\b` nos DOIS lados não é detalhe: sem eles "aavee" casa com "aave" por
    // substring, e um protocolo digitado errado viraria uma posição que o
    // usuário não tem — relatório de risco sobre carteira inventada, com a
    // chamada já paga. Bug real, pego em teste.
    const depois = new RegExp(`\\b${protocolo}\\b\\s*[:=]?\\s*\\$?([0-9][0-9_.,]*)\\s*(k|m)?`, "i").exec(text);
    const antes = new RegExp(`\\$?([0-9][0-9_.,]*)\\s*(k|m)?\\s*(?:in|on|at|em|no|na)?\\s*\\b${protocolo}\\b`, "i").exec(text);
    const m = depois ?? antes;
    if (!m) continue;
    const base = Number(m[1]!.replace(/[_,]/g, ""));
    if (!Number.isFinite(base) || base <= 0) continue;
    const mult = m[2]?.toLowerCase() === "m" ? 1_000_000 : m[2]?.toLowerCase() === "k" ? 1_000 : 1;
    found[protocolo] = Math.round(base * mult);
  }
  return Object.keys(found).length > 0 ? found : null;
}

/**
 * Fábrica das quatro ações analíticas. O esqueleto é idêntico (ler o texto,
 * comprar o relatório, resumir para humano, nunca lançar), então vive aqui uma
 * vez só. O `data` devolvido carrega o relatório ÍNTEGRO — o resumo é para
 * leitura, não substitui o dado.
 */
function reportAction(params: {
  name: string;
  kind: ReportKind;
  similes: string[];
  description: string;
  example: string;
  intent: RegExp;
  query?: (text: string) => Record<string, string | number | undefined> | null;
  missingInput?: string;
  summarize: (r: YieldReport, asset: LendingAsset) => string;
}): Action {
  return {
    name: params.name,
    similes: params.similes,
    description: params.description,
    validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
      const text = typeof message.content?.text === "string" ? message.content.text : "";
      return params.intent.test(text);
    },
    handler: async (
      _runtime: IAgentRuntime,
      message: Memory,
      _state: State | undefined,
      _options: Record<string, unknown> | undefined,
      callback?: HandlerCallback,
    ): Promise<ActionResult> => {
      const text = typeof message.content?.text === "string" ? message.content.text : "";
      const asset = parseLendingAsset(text);
      let query: Record<string, string | number | undefined> = {};
      if (params.query) {
        const q = params.query(text);
        if (q === null) {
          const falta = params.missingInput ?? "I need more information to answer that.";
          await callback?.({ text: falta });
          return { success: false, error: falta };
        }
        query = q;
      }
      try {
        const report = await fetchYieldReport(params.kind, asset, { query });
        const resumo = params.summarize(report, asset);
        await callback?.({ text: resumo, content: report as unknown as Record<string, unknown> });
        return { success: true, text: resumo, data: report as unknown as Record<string, unknown> };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        await callback?.({ text: `Failed to fetch the ${asset} ${params.kind} report: ${error}` });
        return { success: false, error };
      }
    },
    examples: [
      [
        { name: "{{user}}", content: { text: params.example } },
        { name: "{{agent}}", content: { text: "Checking...", action: params.name } },
      ],
    ],
  };
}

export const getYieldDurabilityAction = reportAction({
  name: "GET_YIELD_DURABILITY",
  kind: "durability",
  similes: ["IS_THE_YIELD_REAL", "INCENTIVE_DEPENDENCE", "POST_INCENTIVE_FLOOR"],
  description:
    "How much of the current APY survives if incentives stop: base-vs-reward split per protocol, the post-incentive floor, and whether the leader changes without incentives. Sources that do not itemise the reward are named as undecomposable, never assumed incentive-free. Base lending only. Costs $0.01 USDC per call via x402.",
  example: "Is the USDC yield on Base real or just incentives?",
  intent: /durabilit|incentive|promotion|reward|sustain|real yield|rendimento real/i,
  summarize: (r, asset) => {
    const muda = r.rankingChangesWithoutIncentives;
    const piso = r.bestVerifiableFloor as { protocol: string; apyBps: number } | null;
    const cabeca =
      muda === true
        ? `Without incentives the ${asset} leader changes: ${r.bestProtocolNow} → ${r.bestProtocolPostIncentive}.`
        : muda === false
          ? `The ${asset} leader (${r.bestProtocolNow}) holds up without incentives.`
          : `Cannot say whether the ${asset} ranking changes — the current leader (${r.bestProtocolNow}) does not itemise its reward component.`;
    return piso
      ? `${cabeca} Highest yield provably independent of incentives: ${piso.protocol} at ${piso.apyBps}bps.`
      : cabeca;
  },
});

export const getExitCapacityAction = reportAction({
  name: "GET_EXIT_CAPACITY",
  kind: "capacity",
  similes: ["CAN_I_WITHDRAW", "EXIT_LIQUIDITY", "MARKET_UTILIZATION"],
  description:
    "Whether you can actually withdraw: per-protocol utilisation and free liquidity read from the protocol's own books, plus whether your size can exit right now. A market at 99% utilisation pays well and will not let you out. Unmeasured protocols are never reported as executable. Costs $0.01 USDC per call via x402.",
  example: "Can I pull $200k out of USDC lending on Base right now?",
  intent: /withdraw|exit|liquidit|utilis|utiliz|get out|sacar|resgat/i,
  query: (text) => {
    const amountUsd = parseUsdAmount(text);
    return amountUsd === null ? {} : { amountUsd };
  },
  summarize: (r, asset) => {
    const exec = r.bestProtocolExecutable as string | null;
    const cov = r.coverage as { measured: number; total: number };
    return exec
      ? `For ${asset} on Base, the best market that can absorb your exit right now is ${exec} (${cov.measured} of ${cov.total} protocols measured).`
      : `No ${asset} market was confirmed able to absorb that size right now (${cov.measured} of ${cov.total} measured — unmeasured is not the same as liquid).`;
  },
});

export const getRateSensitivityAction = reportAction({
  name: "GET_RATE_SENSITIVITY",
  kind: "sensitivity",
  similes: ["DISTANCE_TO_KINK", "WILL_RATES_SPIKE", "UTILIZATION_HEADROOM", "BORROW_COST_RISK"],
  description:
    "How close the market is to the kink where borrow rates explode: current utilisation, the kink read from the protocol's own interest rate curve, headroom in bps, and how many times the borrow cost multiplies just past it. Aave and Compound only; protocols without a readable curve are marked unmeasured, never assumed stable. Costs $0.01 USDC per call via x402.",
  example: "How close is Base USDC lending to a rate spike?",
  intent: /kink|rate spike|borrow (cost|rate)|repric|sensitiv|headroom|dispar/i,
  summarize: (r, asset) => {
    const t = r.tightestToKink as { protocol: string; headroomBps: number } | null;
    const past = (r.pastKink as string[] | undefined) ?? [];
    if (past.length > 0) {
      return `${past.join(", ")} already crossed the kink on ${asset} — borrow costs are on the steep leg of the curve now.`;
    }
    if (!t) return `No ${asset} market with a readable rate curve is currently below its kink.`;
    return `Tightest ${asset} market: ${t.protocol}, ${(t.headroomBps / 100).toFixed(2)} percentage points of utilisation from the kink where borrow rates jump.`;
  },
});

export const getSharedExposureAction = reportAction({
  name: "GET_SHARED_EXPOSURE",
  kind: "exposure",
  similes: ["AM_I_DIVERSIFIED", "CONCENTRATION_RISK", "SHARED_COLLATERAL", "CONTAGION_PATH"],
  description:
    "How much of a portfolio sits behind the same collateral, price oracle or vault curator, and through which venues it gets there. Answers what depeg and hack alerts do not: am I exposed, and by what path. Costs $0.01 USDC per call via x402.",
  example: "I have 200k in aave and 150k in morpho — am I actually diversified?",
  intent: /diversif|exposure|concentrat|correlat|contagio|contagion|same risk|risco/i,
  missingInput:
    "I need your positions to answer that — tell me the protocol and size, e.g. 'aave 200000, morpho 150000'. Known protocols: aave, morpho, compound, moonwell, euler, fluid.",
  query: (text) => {
    const positions = parsePositions(text);
    if (!positions) return null;
    // buildPositionsParam valida do lado do cliente ANTES de pagar.
    return { positions: buildPositionsParam(positions) };
  },
  summarize: (r) => {
    const top = r.topFactor as { kind: string; key: string; pctOfAttributed: number; via: string[] } | null;
    const cov = r.coverage as { attributedUsd: number; totalUsd: number };
    if (!top) return `Nothing could be attributed across those positions (0 of $${cov.totalUsd} traceable).`;
    const chave = top.key.startsWith("0x") ? `${top.key.slice(0, 10)}…` : top.key;
    return `${r.nominalVenues} venues, but ${top.pctOfAttributed}% of the $${cov.attributedUsd} that can be traced sits behind one ${top.kind} (${chave}), reaching it via ${top.via.join(" and ")}.`;
  },
});

export const reportActions: Action[] = [
  getYieldDurabilityAction,
  getExitCapacityAction,
  getRateSensitivityAction,
  getSharedExposureAction,
];
