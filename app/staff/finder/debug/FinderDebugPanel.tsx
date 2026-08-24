"use client";

import { useState } from "react";
import Link from "next/link";

type Result = {
  itemId: string;
  found: boolean;
  keyword?: string | null;
  matchedTitle?: string | null;
  failedKeywords: string[];
  foundVia?: "keyword" | "image_search";
  imageSearchConfigured: boolean;
  imageSearchesRun: number;
  failedImageSearches: number;
};

export default function FinderDebugPanel() {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Result | null>(null);

  const check = async () => {
    if (!input.trim()) return;
    setBusy(true); setError(""); setResult(null);
    try {
      const response = await fetch("/api/finder/debug", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ itemId: input }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Request failed.");
      setResult(payload);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Request failed."); }
    finally { setBusy(false); }
  };

  return <main className="finder-page">
    <header className="finder-header"><div><Link className="back" href="/staff/finder">← Back to deal finder</Link><p className="eyebrow">EBAY DISCOVERY</p><h1>Finder debugger</h1><p className="muted">Check whether a specific eBay listing shows up in a live search for any enabled keyword, or (for gaucho knives) the reference-photo image search — useful when a listing you expected the finder to catch never appeared.</p></div></header>
    <section className="panel">
      <form className="keyword-add" onSubmit={(event) => { event.preventDefault(); void check(); }}>
        <input aria-label="eBay item id or listing URL" placeholder="eBay item id or listing URL (e.g. 287535686773)" value={input} onChange={(event) => setInput(event.target.value)} />
        <button className="primary" disabled={busy}>{busy ? "Checking…" : "Check"}</button>
      </form>
      {error && <div className="notice finder-error" role="status" aria-live="polite" aria-atomic="true">{error}</div>}
      {result && <p className="muted">
        Item <strong>{result.itemId}</strong>{" "}
        {result.found
          ? result.foundVia === "image_search"
            ? <>was found via gaucho-knife image search — “{result.matchedTitle}”.</>
            : <>was found under keyword “{result.keyword}” — “{result.matchedTitle}”.</>
          : <>was not in results for any enabled keyword{result.imageSearchConfigured ? " or the gaucho-knife image search" : ""}.</>}
        {result.failedKeywords.length > 0 && <> ({result.failedKeywords.length} keyword search{result.failedKeywords.length === 1 ? "" : "es"} failed and couldn&apos;t be checked: {result.failedKeywords.join(", ")})</>}
        {result.failedImageSearches > 0 && <> ({result.failedImageSearches} of {result.imageSearchesRun} gaucho-knife image search{result.imageSearchesRun === 1 ? "" : "es"} failed and couldn&apos;t be checked)</>}
        {!result.imageSearchConfigured && <> No gaucho-knife reference photos are configured, so image search wasn&apos;t checked — <Link href="/staff/finder/gaucho-knives/settings">add one</Link> if this listing should be caught that way.</>}
      </p>}
    </section>
  </main>;
}
