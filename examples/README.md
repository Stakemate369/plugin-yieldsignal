# Usage examples

Two ways to use `elizaos-plugin-yieldsignal`.

## 1. As an elizaOS plugin (the normal case)

Add the plugin to your character. The agent gains a `GET_YIELD_SIGNAL` action that
fires only on yield/rate questions (see the intent gate) and pays for the answer
through its own CDP wallet.

```ts
import { yieldSignalPlugin } from "elizaos-plugin-yieldsignal";

export const character = {
  name: "MyAgent",
  // ...
  plugins: [yieldSignalPlugin],
};
```

Set the paying wallet's credentials in the environment:

```bash
CDP_API_KEY_ID=...        # Coinbase CDP API key id
CDP_API_KEY_SECRET=...    # Coinbase CDP API key secret
CDP_WALLET_SECRET=...     # CDP wallet secret (Base mainnet, needs a little USDC)
```

Then just talk to the agent:

> **User:** what's the best USDC lending rate on Base right now?
> **Agent:** *(GET_YIELD_SIGNAL)* Best USDC lending rate on Base right now: fluid (18bps ahead of the runner-up).

The wallet is protected by hard spend controls ($0.10/call cap, $2/24h rolling
cap, Base+USDC+payee allowlists), so even a compromised endpoint can't overspend.

## 2. Standalone: fetch + verify without the agent runtime

`fetchYieldSignal` pays, validates the schema, and verifies the EIP-712 signature
before returning — throwing if anything is off. You can also verify a response
yourself with the exported helper.

```ts
import { fetchYieldSignal, verifyYieldSignalSignature } from "elizaos-plugin-yieldsignal";

// One call: paid, schema-validated, signature-verified, or it throws.
const signal = await fetchYieldSignal("USDC");
console.log(signal.bestProtocol, signal.gapBps);

// Verify a raw (raw body, X-Signal-* headers) pair yourself:
const ok = await verifyYieldSignalSignature({
  raw,                 // exact response body bytes
  signature,           // X-Signal-Signature
  signer,              // X-Signal-Signer
  eip712Json,          // X-Signal-Eip712-Payload
});
```

## Why trust the numbers?

Every response is EIP-712 signed by the payment-receiving address, which also
holds an on-chain [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) identity and
publishes periodic [EAS](https://base.easscan.org) attestations of past readings on
Base mainnet. That means the signal has a **public, verifiable track record** — not
a self-declared one:

- Machine-readable accuracy: [`/accuracy.json`](https://yieldsignal.vercel.app/accuracy.json) (free)
- Human dashboard: [`/track-record`](https://yieldsignal.vercel.app/track-record)
- Agent identity card: [`/agent-card.json`](https://yieldsignal.vercel.app/agent-card.json)
