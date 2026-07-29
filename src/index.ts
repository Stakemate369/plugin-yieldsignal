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
    "Paid (x402) real-time yield signal: ETH liquid staking on Ethereum mainnet plus USDC/WETH lending on Base, EIP-712 signed by the seller and EAS-attested on-chain.",
  actions: [getYieldSignalAction],
};

export default yieldSignalPlugin;
