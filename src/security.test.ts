import { describe, expect, it } from "vitest";
import { keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  buildSpendControls,
  hasYieldIntent,
  parseYieldSignalResponse,
  verifyYieldSignalSignature,
  YIELDSIGNAL_PAYEE,
  YIELD_SIGNAL_PATHS,
} from "./security.js";

// Mirror of the server's EIP-712 struct (src/attestation/schema.ts +
// signResponse.ts): the schema fields plus the body-binding contentHash.
const TYPES = {
  YieldSignal: [
    { name: "asset", type: "string" },
    { name: "bestProtocol", type: "string" },
    { name: "weightedApyBps", type: "uint256" },
    { name: "gapBps", type: "uint256" },
    { name: "asOf", type: "uint64" },
    { name: "contentHash", type: "bytes32" },
  ],
} as const;
const DOMAIN = { name: "YieldSignal", version: "1", chainId: 8453 } as const;

const VALID_BODY = JSON.stringify({
  asset: "USDC",
  bestProtocol: "aave",
  gapBps: 42,
  rates: [
    {
      protocol: "aave",
      apyBps: 520,
      weightedApyBps: 500,
      source: "onchain",
      asOf: "2026-07-23T00:00:00.000Z",
    },
  ],
  asOf: "2026-07-23T00:00:00.000Z",
});

// Deterministic test key — NOT a real wallet. Acts as the "server" signer.
const TEST_PK =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const account = privateKeyToAccount(TEST_PK);

async function signBody(raw: string, signerAccount = account) {
  const message = {
    asset: "USDC",
    bestProtocol: "aave",
    weightedApyBps: 500n,
    gapBps: 42n,
    asOf: 1753228800n,
    contentHash: keccak256(toBytes(raw)),
  };
  const signature = await signerAccount.signTypedData({
    domain: DOMAIN,
    types: TYPES,
    primaryType: "YieldSignal",
    message,
  });
  const eip712Json = JSON.stringify({
    domain: DOMAIN,
    types: TYPES,
    primaryType: "YieldSignal",
    message: {
      ...message,
      weightedApyBps: "500",
      gapBps: "42",
      asOf: "1753228800",
    },
  });
  return { signature, eip712Json, signer: signerAccount.address as `0x${string}` };
}

describe("verifyYieldSignalSignature (adversarial)", () => {
  it("accepts a correctly signed body when the signer matches the expected address", async () => {
    const { signature, eip712Json, signer } = await signBody(VALID_BODY);
    const ok = await verifyYieldSignalSignature({
      raw: VALID_BODY,
      signature,
      signer,
      eip712Json,
      expectedSigner: account.address,
    });
    expect(ok).toBe(true);
  });

  it("rejects a valid signature whose signer is not the advertised payee", async () => {
    const { signature, eip712Json, signer } = await signBody(VALID_BODY);
    // Default expectedSigner is the real YIELDSIGNAL_PAYEE, which the test key is not.
    const ok = await verifyYieldSignalSignature({
      raw: VALID_BODY,
      signature,
      signer,
      eip712Json,
    });
    expect(ok).toBe(false);
    expect(signer.toLowerCase()).not.toBe(YIELDSIGNAL_PAYEE.toLowerCase());
  });

  it("rejects a tampered body (contentHash no longer matches the bytes)", async () => {
    const { signature, eip712Json, signer } = await signBody(VALID_BODY);
    const tampered = VALID_BODY.replace('"gapBps":42', '"gapBps":9999');
    const ok = await verifyYieldSignalSignature({
      raw: tampered,
      signature,
      signer,
      eip712Json,
      expectedSigner: account.address,
    });
    expect(ok).toBe(false);
  });

  it("rejects a garbage signature", async () => {
    const { eip712Json, signer } = await signBody(VALID_BODY);
    const ok = await verifyYieldSignalSignature({
      raw: VALID_BODY,
      signature: `0x${"00".repeat(65)}`,
      signer,
      eip712Json,
      expectedSigner: account.address,
    });
    expect(ok).toBe(false);
  });

  it("rejects a malformed eip712 payload without throwing", async () => {
    const { signature, signer } = await signBody(VALID_BODY);
    const ok = await verifyYieldSignalSignature({
      raw: VALID_BODY,
      signature,
      signer,
      eip712Json: "{not json",
      expectedSigner: account.address,
    });
    expect(ok).toBe(false);
  });
});

describe("parseYieldSignalResponse (schema validation)", () => {
  it("returns the typed object for a well-formed body", () => {
    const parsed = parseYieldSignalResponse(VALID_BODY);
    expect(parsed.asset).toBe("USDC");
    expect(parsed.bestProtocol).toBe("aave");
    expect(parsed.rates).toHaveLength(1);
  });

  it("throws on non-JSON", () => {
    expect(() => parseYieldSignalResponse("<html>nope</html>")).toThrow();
  });

  it("throws when required fields are missing", () => {
    expect(() =>
      parseYieldSignalResponse(JSON.stringify({ asset: "USDC" })),
    ).toThrow();
  });

  it("throws on an unexpected asset", () => {
    expect(() =>
      parseYieldSignalResponse(
        JSON.stringify({
          asset: "DAI",
          bestProtocol: "aave",
          gapBps: 1,
          rates: [],
          asOf: "x",
        }),
      ),
    ).toThrow();
  });

  it("throws on a malformed rates array", () => {
    expect(() =>
      parseYieldSignalResponse(
        JSON.stringify({
          asset: "USDC",
          bestProtocol: "aave",
          gapBps: 1,
          rates: [{ protocol: "aave" }],
          asOf: "x",
        }),
      ),
    ).toThrow();
  });
});

describe("buildSpendControls (hard spend policy)", () => {
  it("caps per-payment and cumulative spend, and pins asset/network/payee", () => {
    const sc = buildSpendControls();
    expect(sc.maxAmountPerPayment).toEqual({
      atomic: 100_000n,
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    });
    expect(sc.maxCumulativeSpend?.atomic).toBe(2_000_000n);
    expect(sc.maxCumulativeSpendWindow).toBe("24h");
    expect(sc.allowedNetworks).toEqual(["eip155:8453"]);
    expect(sc.allowedAssets).toEqual([
      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    ]);
    expect(sc.allowedPayees).toEqual([YIELDSIGNAL_PAYEE]);
  });
});

describe("hasYieldIntent (explicit-intent gate)", () => {
  it("is true for a yield/rate question", () => {
    expect(hasYieldIntent("what's the best USDC lending rate on Base?")).toBe(
      true,
    );
    expect(hasYieldIntent("show me the current WETH APY")).toBe(true);
  });

  it("is false for unrelated messages, even ones that mention the asset", () => {
    expect(hasYieldIntent("hey, how are you?")).toBe(false);
    expect(hasYieldIntent("I just sent you some USDC")).toBe(false);
    expect(hasYieldIntent("")).toBe(false);
  });
});

describe("suporte a ETH_STAKING (corrigido na 0.2.1)", () => {
  it("aceita uma resposta com asset ETH_STAKING — antes o parser lançava 'unexpected asset'", () => {
    const body = JSON.stringify({
      asset: "ETH_STAKING",
      bestProtocol: "lido",
      gapBps: 8,
      rates: [
        { protocol: "lido", apyBps: 296, weightedApyBps: 293, source: "defillama", asOf: "2026-07-29T12:00:00.000Z" },
      ],
      asOf: "2026-07-29T12:00:05.000Z",
    });
    const parsed = parseYieldSignalResponse(body);
    expect(parsed.asset).toBe("ETH_STAKING");
    expect(parsed.bestProtocol).toBe("lido");
  });

  it("continua rejeitando asset desconhecido", () => {
    expect(() =>
      parseYieldSignalResponse(
        JSON.stringify({ asset: "DOGE", bestProtocol: "x", gapBps: 1, rates: [], asOf: "z" }),
      ),
    ).toThrow(/unexpected asset/);
  });

  it("ignora campos extras da resposta (cobertura/omittedProtocols) sem quebrar", () => {
    const parsed = parseYieldSignalResponse(
      JSON.stringify({
        asset: "USDC",
        bestProtocol: "compound",
        gapBps: 12,
        rates: [],
        omittedProtocols: ["aave", "morpho"],
        coverage: { read: 4, expected: 6 },
        asOf: "2026-07-29T12:00:05.000Z",
      }),
    );
    expect(parsed.asset).toBe("USDC");
  });

  it("o caminho de cada asset é o canônico do serviço — sem derivar URL de string", () => {
    expect(YIELD_SIGNAL_PATHS.ETH_STAKING).toBe("/signal/eth-staking-yield");
    expect(YIELD_SIGNAL_PATHS.USDC).toBe("/signal/usdc-base-yield");
    expect(YIELD_SIGNAL_PATHS.WETH).toBe("/signal/weth-base-yield");
    // A regra antiga (`asset.toLowerCase() + "-base-yield"`) produzia isto:
    expect(YIELD_SIGNAL_PATHS.ETH_STAKING).not.toContain("_");
    expect(YIELD_SIGNAL_PATHS.ETH_STAKING).not.toContain("-base-");
  });

  it("intenção de staking aciona a action (termo 'stake'/'staking')", () => {
    expect(hasYieldIntent("where should I stake my ETH?")).toBe(true);
    expect(hasYieldIntent("best ETH staking yield right now")).toBe(true);
    // Não é sobre rendimento: continua fora.
    expect(hasYieldIntent("I just sent you some ETH")).toBe(false);
  });
});
