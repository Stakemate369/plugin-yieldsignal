import { describe, expect, it } from "vitest";
import {
  parseLendingAsset,
  parsePositions,
  parseUsdAmount,
  reportActions,
} from "./actions/reports.js";
import { buildPositionsParam, REPORT_PATHS, KNOWN_PROTOCOLS } from "./security.js";
import { yieldSignalPlugin } from "./index.js";

describe("plugin registra os cinco produtos", () => {
  it("expõe o sinal mais os quatro relatórios", () => {
    expect((yieldSignalPlugin.actions ?? []).map((a) => a.name).sort()).toEqual([
      "GET_EXIT_CAPACITY",
      "GET_RATE_SENSITIVITY",
      "GET_SHARED_EXPOSURE",
      "GET_YIELD_DURABILITY",
      "GET_YIELD_SIGNAL",
    ]);
  });

  it("toda ação de relatório declara preço e o que NÃO consegue medir", () => {
    for (const a of reportActions) {
      expect(a.description).toContain("$0.01");
      expect(a.examples?.length).toBeGreaterThan(0);
      expect(a.similes?.length).toBeGreaterThan(0);
    }
  });
});

/**
 * NÃO reaproveita o `parseAsset` do sinal de propósito: aquele devolve
 * ETH_STAKING para "ETH", e as rotas analíticas não existem para staking —
 * cair lá faria o agente pagar por um 404.
 */
describe("parseLendingAsset", () => {
  it.each([
    ["how close is USDC to a spike?", "USDC"],
    ["weth lending on base", "WETH"],
    ["what about ETH?", "WETH"],
    ["is the yield real?", "USDC"],
  ])("%s -> %s", (texto, esperado) => {
    expect(parseLendingAsset(texto)).toBe(esperado);
  });

  it("nunca devolve ETH_STAKING, que não tem estas rotas", () => {
    for (const t of ["eth staking yield", "lido vs rocket pool", "stake ETH"]) {
      expect(["USDC", "WETH"]).toContain(parseLendingAsset(t));
    }
  });
});

describe("parseUsdAmount", () => {
  it.each([
    ["can I pull $200k out?", 200_000],
    ["withdraw 1.5m", 1_500_000],
    ["exit 250000 usdc", 250_000],
  ])("%s -> %s", (texto, esperado) => {
    expect(parseUsdAmount(texto)).toBe(esperado);
  });

  it("sem valor no texto, devolve null em vez de chutar", () => {
    expect(parseUsdAmount("can I withdraw from aave?")).toBeNull();
  });
});

describe("parsePositions", () => {
  it("lê 'protocolo valor' e 'valor in protocolo'", () => {
    expect(parsePositions("200k in aave and morpho 150000")).toEqual({ aave: 200_000, morpho: 150_000 });
  });

  // Relatório de risco montado sobre carteira inventada é pior que nenhum — e o
  // agente já teria pago por ele.
  it("sem posição reconhecível, devolve null para a ação PEDIR o dado", () => {
    expect(parsePositions("am I diversified?")).toBeNull();
  });

  it("ignora protocolo desconhecido em vez de inventá-lo", () => {
    expect(parsePositions("100k in aavee")).toBeNull();
  });
});

/**
 * Validar do lado do CLIENTE, antes de pagar, é o ponto: um protocolo escrito
 * errado passaria pelo servidor como "não atribuído" e o agente pagaria por uma
 * análise que ignorou parte da carteira sem dizer que ignorou.
 */
describe("buildPositionsParam", () => {
  it("monta o parâmetro no formato do servidor", () => {
    expect(buildPositionsParam({ aave: 200_000, morpho: 150_000 })).toBe("aave:200000,morpho:150000");
  });

  it("recusa protocolo desconhecido ANTES de gastar", () => {
    expect(() => buildPositionsParam({ aavee: 100 })).toThrow(/unknown protocol/);
  });

  it.each([[0], [-5], [Number.NaN]])("recusa valor inválido %s", (v) => {
    expect(() => buildPositionsParam({ aave: v })).toThrow(/positive number/);
  });

  it("recusa carteira vazia", () => {
    expect(() => buildPositionsParam({})).toThrow(/at least one/);
  });
});

describe("REPORT_PATHS", () => {
  // Caminho explícito, nunca derivado de string: a derivação já produziu rota
  // inexistente numa versão anterior deste plugin.
  it("cobre os 4 produtos x 2 assets, todos com caminho absoluto", () => {
    const todos = Object.values(REPORT_PATHS).flatMap((m) => Object.values(m));
    expect(todos).toHaveLength(8);
    expect(new Set(todos).size).toBe(8);
    for (const p of todos) expect(p.startsWith("/")).toBe(true);
  });

  it("nenhum caminho de relatório aponta para staking", () => {
    for (const p of Object.values(REPORT_PATHS).flatMap((m) => Object.values(m))) {
      expect(p).not.toContain("eth-staking");
    }
  });
});

describe("KNOWN_PROTOCOLS", () => {
  it("é a mesma lista que o servidor aceita", () => {
    expect([...KNOWN_PROTOCOLS].sort()).toEqual(["aave", "compound", "euler", "fluid", "moonwell", "morpho"]);
  });
});
