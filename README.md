# elizaos-plugin-yieldsignal

Real-time, risk-weighted yield signals — paid per call ($0.01 USDC) via the [x402](https://x402.org) protocol through [YieldSignal](https://yieldsignal.vercel.app):

- **ETH liquid staking** (Ethereum mainnet) across Lido, Rocket Pool, Coinbase Wrapped Staked ETH, Frax Ether and Binance Staked ETH
- **USDC / WETH lending** (Base) across Aave, Compound, Morpho, Moonwell, Euler and Fluid

Per-asset verified accuracy is public and free at [`/accuracy.json`](https://yieldsignal.vercel.app/accuracy.json), computed from an on-chain EAS track record — check it before trusting the signal.

> **Verifiable, not self-declared.** Responses are EIP-712 signed and the seller keeps a public on-chain track record (ERC-8004 identity + EAS attestations on Base). Its machine-readable accuracy is live at [`/accuracy.json`](https://yieldsignal.vercel.app/accuracy.json) — currently **93.75% within-tolerance** (the flagged protocol was the leader or within 25bps), average regret **8bps**. A paying agent can check who to trust by the proven record, not the promise.

## Five products, not one

The signal answers *what pays best right now* — which is a commodity anyone gives away. The four risk reports answer questions nothing else sells, and each one **names what it could not establish** instead of filling the gap with a guess.

| Action | Question it answers |
|---|---|
| `GET_YIELD_SIGNAL` | What pays best right now (Base lending or ETH staking) |
| `GET_YIELD_DURABILITY` | Is this yield real, or a promotion about to end? |
| `GET_EXIT_CAPACITY` | Can I actually withdraw my size from that market? |
| `GET_RATE_SENSITIVITY` | How close is this market to the kink where borrow rates explode? |
| `GET_SHARED_EXPOSURE` | I'm in N venues — but behind how many distinct risks? |

Measured on live readings:

- **Durability** — WETH on Base led with `euler` at 299bps, but **57.9% of that was incentive** (floor 126bps), while `aave`'s 153bps was entirely base interest. Without incentives the ranking flips.
- **Sensitivity** — Compound's USDC market sat **0.17 percentage points** from its kink, where borrowing goes from 4% to 16%. Hours later it crossed, and the cost of borrowing rose 1.7x.
- **Exposure** — a portfolio across three venues had **81% of its traceable capital behind one collateral**, reaching it through two of them. The apparent diversification was not real.

The four reports are **Base lending only** (`USDC` / `WETH`): liquid staking has no utilisation, no interest-rate curve and no itemised incentive to decompose, so the plugin refuses those assets rather than letting the agent pay for a 404.

**Quick start:** see [`examples/`](examples/README.md) for a copy-paste plugin setup and a standalone fetch-and-verify snippet.

## Purpose / role

Adds a single buyer-side action, `GET_YIELD_SIGNAL`, that lets an elizaOS agent proactively call and pay for an external x402-protected API. This is distinct from `@elizaos/plugin-x402` (seller-side middleware for protecting this agent's *own* HTTP routes) — there's currently no overlap, since that package registers no actions/providers/services of its own.

Every response from YieldSignal is signed (EIP-712 typed data) by the payment-receiving address, which also holds an on-chain [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) agent identity ([`/agent-card.json`](https://yieldsignal.vercel.app/agent-card.json)) and periodically publishes [EAS](https://base.easscan.org) attestations of past readings on Base mainnet ([`/track-record`](https://yieldsignal.vercel.app/track-record)).

## Plugin surface

| Kind | Name | What it does |
|------|------|--------------|
| Action | `GET_YIELD_SIGNAL` | Fetches the current best protocol and risk-weighted APY (bps). Parses `ETH_STAKING`/`USDC`/`WETH` from the triggering message text — staking wins on "stake"/"staking"/bare "ETH", `WETH` and `USDC` on an explicit mention, defaulting to `USDC`. |

## Layout

```
src/
  index.ts                     Plugin entry; exports yieldSignalPlugin
  client.ts                    x402 payment + fetch (CdpX402Client + @x402/fetch)
  actions/
    get-yield-signal.ts        GET_YIELD_SIGNAL action handler
  get-yield-signal.test.ts     Unit tests (no network — validates registration/shape)
```

## Config / env vars

| Env var | Required | Purpose |
|---------|----------|---------|
| `CDP_API_KEY_ID` | Required | Coinbase CDP API key ID — provisions the plugin's own payment wallet |
| `CDP_API_KEY_SECRET` | Required | Coinbase CDP API key secret |
| `CDP_WALLET_SECRET` | Required | Coinbase CDP wallet secret |

The plugin's wallet needs a small amount of USDC on Base ($0.01 per call).

## Usage

```typescript
import { yieldSignalPlugin } from "elizaos-plugin-yieldsignal";

const character = {
  // ...
  plugins: [yieldSignalPlugin],
};
```

## Security posture

This plugin holds a spending wallet, so it enforces — client-side — the guarantees the service advertises, rather than trusting the server:

- **Hard spend policy** (via the CDP SDK's spend controls, `buildSpendControls`): a per-call cap ($0.10 USDC, well above the advertised $0.01/$0.05), a rolling 24h cumulative cap ($2.00), and fixed allowlists for **network** (Base / `eip155:8453`), **asset** (USDC) and **payee** (`0x5611…472a`). A tampered or swapped 402 challenge cannot make the wallet pay more, a different asset/chain, or a different recipient.
- **EIP-712 verification** (`verifyYieldSignalSignature`): every response's `X-Signal-*` headers are verified with `viem.verifyTypedData`, the embedded `contentHash` is checked against `keccak256(rawBody)`, and the signer is pinned to the advertised payee. An unsigned or tampered response is **rejected**, not trusted.
- **Runtime schema validation** (`parseYieldSignalResponse`): the body is validated against the expected shape, never blindly cast.
- **Bounded I/O**: the paid fetch aborts after a timeout (default 15s), so a hung server can't block the agent.
- **Explicit-intent gate**: `validate` only returns true when the message actually expresses a yield/rate intent (`hasYieldIntent`) — the wallet is never touched on unrelated messages.

Adversarial unit tests cover signature rejection (wrong signer, tampered body, bad signature, malformed payload), schema rejection, the spend-policy values, and the intent gate. See `src/security.test.ts`.

## Why a dedicated wallet instead of the agent's own signer?

x402 payment signing (`@x402/fetch` + `@coinbase/cdp-sdk/x402`) is independent of whatever wallet/signing setup the agent otherwise uses — this plugin pays for the call the same way it's already proven against production (see [`scripts/testPaidCall.mts`](https://github.com/Stakemate369/yieldsignal/blob/main/scripts/testPaidCall.mts) in the service's own repo), rather than adapting a second signing path into the agent's primary wallet integration.
