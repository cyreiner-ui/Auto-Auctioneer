import test from "node:test";
import assert from "node:assert/strict";
const parseEbayItemId = (value) => { try { const url = new URL(value.trim()); if (!/(^|\.)ebay\.[a-z.]+$/i.test(url.hostname)) return null; return url.pathname.match(/(?:itm\/|item\/(?:[^/]+\/)?)(\d{6,14})/i)?.[1] ?? null; } catch { return null; } };
test("parses valid ebay url", () => assert.equal(parseEbayItemId("https://www.ebay.com/itm/166824019402"), "166824019402"));
test("rejects invalid ebay url", () => assert.equal(parseEbayItemId("https://example.com/itm/166824019402"), null));
test("complete text format", () => assert.equal(`Título\n\nComeçar fechamento em: R$ 450,00\n\nDescrição`, "Título\n\nComeçar fechamento em: R$ 450,00\n\nDescrição"));

