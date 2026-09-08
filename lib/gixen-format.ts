// Split out of gixen-client.ts so callers that only need this classification
// (e.g. finder-service.ts) don't drag playwright-core/@sparticuz/chromium
// into their deployed function bundle — gixen-client.ts imports the browser
// automation dynamically, but Next's function-bundle tracing still follows
// those import() calls just from the file being in the module graph.

// Gixen only snipes eBay auctions — a fixed-price (Buy It Now) listing has no
// bid to time, so Gixen silently rejects it. The finder itself still
// surfaces fixed-price deals for manual purchase; only auction-format items
// should ever reach addSnipe.
export function isAuctionFormat(buyingOptions: string[] | null | undefined) {
  return Array.isArray(buyingOptions) && buyingOptions.includes("AUCTION");
}
