import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

// This used to import a Cloudflare Worker build (`dist/server/index.js`) produced by a
// "vinext build" step that nothing in package.json's scripts runs anymore — the app is built
// and deployed as plain Next.js (next build / next start on Vercel). That worker output, and
// the "Fio & Lâmina" placeholder copy this test used to check for, both predate the app being
// customized into "Knife Auctions" and no longer exist anywhere in the source.
//
// The real homepage (app/page.tsx) is a "use client" component that gates all of its actual
// content — the staff dashboard, "Rascunhos"/"Importar listings", etc. — behind two
// password screens resolved entirely in the browser (a mount-time fetch to check for an
// existing access cookie, then user-submitted forms). Its very first server-rendered HTML,
// before any client JS runs, is only ever the loading shell (`checkingAccess` starts `true`).
// A plain HTTP fetch — no browser, no JS execution — can only ever observe that shell, so
// that's what this test honestly verifies: the real production build boots and serves it
// correctly, with no leftover template placeholders.

const PORT = 4319;
const BASE_URL = `http://127.0.0.1:${PORT}`;

async function waitForServer(deadline) {
  while (Date.now() < deadline) {
    try {
      const response = await fetch(BASE_URL);
      if (response.ok || response.status < 500) return response;
    } catch { /* server not accepting connections yet */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`next start did not become ready on ${BASE_URL} in time.`);
}

const projectRoot = new URL("../", import.meta.url);
const nextBin = new URL("node_modules/.bin/next", projectRoot).pathname;

// Runs `next start` in its own process group (rather than via npx, which adds a wrapper
// process that doesn't reliably forward signals to the actual next-server it launches) so
// teardown can kill the whole group in one shot instead of leaving an orphaned server behind.
async function stopServer(server) {
  if (server.exitCode !== null || server.signalCode !== null) return;
  const exited = new Promise((resolve) => server.once("exit", resolve));
  process.kill(-server.pid, "SIGTERM");
  const timeout = setTimeout(() => { try { process.kill(-server.pid, "SIGKILL"); } catch { /* already gone */ } }, 3_000);
  await exited;
  clearTimeout(timeout);
}

test("serves the real Knife Auctions app shell from a production build", async () => {
  const server = spawn(nextBin, ["start", "-p", String(PORT)], {
    cwd: projectRoot,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let serverOutput = "";
  server.stdout.on("data", (chunk) => { serverOutput += chunk; });
  server.stderr.on("data", (chunk) => { serverOutput += chunk; });

  try {
    const response = await waitForServer(Date.now() + 30_000);
    assert.equal(response.status, 200, `expected 200, got ${response.status}. Server output:\n${serverOutput}`);
    const html = await response.text();
    assert.match(html, /Knife Auctions/);
    assert.match(html, /Loading/);
    assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton|Fio & Lâmina/);
  } finally {
    await stopServer(server);
  }
});
