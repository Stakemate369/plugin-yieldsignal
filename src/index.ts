import type { Plugin } from "@elizaos/core";
import { getYieldSignalAction } from "./actions/get-yield-signal.js";

export { getYieldSignalAction } from "./actions/get-yield-signal.js";
export { fetchYieldSignal } from "./client.js";
export {
  buildSpendControls,
  hasYieldIntent,
  parseYieldSignalResponse,
  verifyYieldSignalSignature,
  YIELDSIGNAL_PAYEE,
  type YieldSignalAsset,
  type YieldSignalRate,
  type YieldSignalResponse,
} from "./security.js";

export const yieldSignalPlugin: Plugin = {
  name: "yieldsignal",
  description:
    "Paid (x402) real-time USDC/WETH lending yield signal on Base, signed and EAS-attested on-chain.",
  actions: [getYieldSignalAction],
};

export default yieldSignalPlugin;
