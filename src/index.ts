import type { Plugin } from "@elizaos/core";
import { getYieldSignalAction } from "./actions/get-yield-signal.js";
import { reportActions } from "./actions/reports.js";

export { getYieldSignalAction } from "./actions/get-yield-signal.js";
export {
  getYieldDurabilityAction,
  getExitCapacityAction,
  getRateSensitivityAction,
  getSharedExposureAction,
  reportActions,
  parseLendingAsset,
  parsePositions,
  parseUsdAmount,
} from "./actions/reports.js";
export { fetchYieldSignal, fetchYieldReport, type YieldReport } from "./client.js";
export {
  buildSpendControls,
  hasYieldIntent,
  parseYieldSignalResponse,
  verifyYieldSignalSignature,
  YIELDSIGNAL_PAYEE,
  LENDING_ASSETS,
  REPORT_KINDS,
  REPORT_PATHS,
  KNOWN_PROTOCOLS,
  buildPositionsParam,
  type LendingAsset,
  type ReportKind,
  type YieldSignalAsset,
  type YieldSignalRate,
  type YieldSignalResponse,
} from "./security.js";

export const yieldSignalPlugin: Plugin = {
  name: "yieldsignal",
  description:
    "Paid (x402) yield and risk intelligence. The signal: ETH liquid staking on Ethereum mainnet plus USDC/WETH lending on Base. Four risk reports for Base lending: durability (how much of the APY survives if incentives stop), exit capacity (can you actually withdraw), rate sensitivity (how close the market is to the kink where borrow rates explode) and shared exposure (how much of a portfolio sits behind the same risk). Every response is EIP-712 signed by the seller and refused if unsigned; readings are EAS-attested on-chain.",
  actions: [getYieldSignalAction, ...reportActions],
};

export default yieldSignalPlugin;
