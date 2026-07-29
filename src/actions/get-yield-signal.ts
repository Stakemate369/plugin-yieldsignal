import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { fetchYieldSignal } from "../client.js";
import { hasYieldIntent, type YieldSignalAsset } from "../security.js";

/**
 * Escolhe o asset a partir do texto do pedido. A ordem das checagens importa:
 * staking é testado ANTES de WETH porque a regra antiga (`/weth|eth\b/`)
 * classificava "best ETH staking yield" como WETH — lending de WETH na Base,
 * produto errado, cobrado do agente sem ele perceber a troca.
 */
export function parseAsset(text: string): YieldSignalAsset {
  if (/\bstak(e|ing)\b|\beth[\s-]*stak/i.test(text)) return "ETH_STAKING";
  if (/\bweth\b/i.test(text)) return "WETH";
  if (/\busdc\b/i.test(text)) return "USDC";
  // "melhor rendimento de ETH" sem dizer staking nem WETH: staking é a leitura
  // mais provável do pedido, e é o produto com melhor histórico verificado.
  if (/\beth\b/i.test(text)) return "ETH_STAKING";
  return "USDC";
}

export const getYieldSignalAction: Action = {
  name: "GET_YIELD_SIGNAL",
  similes: ["CHECK_YIELD_SIGNAL", "BEST_LENDING_RATE", "BEST_STAKING_YIELD", "USDC_WETH_APY"],
  description:
    "Real-time risk-weighted yield: ETH liquid staking APY (Lido, Rocket Pool, Coinbase Wrapped Staked ETH, Frax Ether, Binance Staked ETH on Ethereum mainnet) or USDC/WETH lending APY (Aave, Compound, Morpho, Moonwell, Euler, Fluid on Base). Costs $0.01 USDC per call via x402. Per-asset verified accuracy is free at https://yieldsignal.vercel.app/accuracy.json.",
  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
  ): Promise<boolean> => {
    const text =
      typeof message.content?.text === "string" ? message.content.text : "";
    return hasYieldIntent(text);
  },
  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options: Record<string, unknown> | undefined,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const asset = parseAsset(
      typeof message.content?.text === "string" ? message.content.text : "",
    );
    try {
      const signal = await fetchYieldSignal(asset);
      // Staking não é "lending on Base" — dizer isso na resposta ao agente
      // descrevia o produto errado, com a chamada já paga.
      const what =
        asset === "ETH_STAKING" ? "ETH liquid staking rate" : `${asset} lending rate on Base`;
      const text = `Best ${what} right now: ${signal.bestProtocol} (${signal.gapBps}bps ahead of the runner-up).`;
      await callback?.({ text });
      // `ActionResult.data` is `ProviderDataRecord`; the concrete response
      // object satisfies it structurally (all fields are JSON-serialisable),
      // but TS needs the cast because the interface has no index signature.
      return {
        success: true,
        text,
        data: signal as unknown as ActionResult["data"],
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await callback?.({
        text: `Failed to fetch the ${asset} yield signal: ${error}`,
      });
      return { success: false, error };
    }
  },
  examples: [
    [
      {
        name: "{{user}}",
        content: {
          text: "What's the best USDC lending rate on Base right now?",
        },
      },
      {
        name: "{{agent}}",
        content: { text: "Checking...", action: "GET_YIELD_SIGNAL" },
      },
    ],
  ],
};
