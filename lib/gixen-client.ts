import type { Browser, BrowserContext, Page } from "playwright-core";

const GIXEN_API_URL = "https://www.gixen.com/api.php";
const GIXEN_LOGIN_URL = "https://www.gixen.com/main/index.php";
const DASHBOARD_PATTERN = /home_2\.php\?sessionid=/;

export type GixenResult = { ok: boolean; message: string };

function credentials() {
  const username = process.env.GIXEN_USERNAME?.trim();
  const password = process.env.GIXEN_PASSWORD?.trim();
  if (!username || !password) return null;
  return { username, password };
}

function automationMode() {
  return process.env.GIXEN_AUTOMATION_MODE === "browser" ? "browser" : "api";
}

// eBay's modern REST-style ids look like "v1|227034212964|0"; Gixen's own
// site (and its old API) expect the bare classic numeric id in the middle.
function gixenItemId(ebayItemId: string) {
  const match = ebayItemId.match(/\|(\d+)\|/);
  return match ? match[1] : ebayItemId;
}

// Gixen only snipes eBay auctions — a fixed-price (Buy It Now) listing has no
// bid to time, so Gixen silently rejects it. The finder itself still
// surfaces fixed-price deals for manual purchase; only auction-format items
// should ever reach addSnipe.
export function isAuctionFormat(buyingOptions: string[] | null | undefined) {
  return Array.isArray(buyingOptions) && buyingOptions.includes("AUCTION");
}

// --- Dead HTTP API path (Gixen returns "ERROR (501): API DISABLED" for this
// account and offers no way to re-enable it) — kept only as a documented,
// always-fails-cleanly fallback state for GIXEN_AUTOMATION_MODE=api, and
// removed entirely once the browser path below is trusted in production.
async function callApi(params: Record<string, string>): Promise<GixenResult> {
  const creds = credentials();
  if (!creds) return { ok: false, message: "Gixen credentials are not configured." };
  const url = new URL(GIXEN_API_URL);
  url.searchParams.set("username", creds.username);
  url.searchParams.set("password", creds.password);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetch(url);
  const text = (await response.text()).trim();
  if (!response.ok) return { ok: false, message: `Gixen request failed (${response.status}): ${text}` };
  return { ok: /^OK\b/i.test(text), message: text };
}

// --- Browser automation path: Gixen's API is dead for this account with no
// self-service way to re-enable it, so this drives gixen.com's own web forms
// (the same ones a staff member would use by hand) with a headless browser.

type GixenSession = { browser: Browser; context: BrowserContext; page: Page };

export type GixenDriver = {
  launch(): Promise<GixenSession>;
  login(page: Page, creds: { username: string; password: string }): Promise<void>;
  submitAddSnipe(page: Page, params: { itemId: string; maxBid: string }): Promise<GixenResult>;
  submitDeleteSnipe(page: Page, params: { itemId: string }): Promise<GixenResult>;
};

function realDriver(): GixenDriver {
  return {
    async launch() {
      const [{ default: chromium }, { chromium: playwright }] = await Promise.all([
        import("@sparticuz/chromium"),
        import("playwright-core"),
      ]);
      const browser = await playwright.launch({ args: chromium.args, executablePath: await chromium.executablePath() });
      const context = await browser.newContext();
      const page = await context.newPage();
      return { browser, context, page };
    },

    async login(page, creds) {
      await page.goto(GIXEN_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
      // The login form is duplicated verbatim twice on the page (a compact
      // header widget and a larger centered box) with clashing ids — scope
      // to the first <form> that actually contains the username field.
      const form = page.locator("form").filter({ has: page.locator('input[name="username"]') }).first();
      await form.locator('input[name="username"]').fill(creds.username);
      await form.locator('input[name="password"]').fill(creds.password);
      await Promise.all([
        page.waitForURL(DASHBOARD_PATTERN, { timeout: 30_000 }),
        form.locator('input[name="Submit"]').click(),
      ]);
      if (!DASHBOARD_PATTERN.test(page.url())) throw new Error("Gixen login did not reach the dashboard.");
    },

    async submitAddSnipe(page, { itemId, maxBid }) {
      if (!DASHBOARD_PATTERN.test(page.url())) throw new Error("gixen-session-lost");
      const form = page.locator('form[name="addsnipe"]');
      await form.locator('input[name="newitemid"]').fill(itemId);
      await form.locator('input[name="newmaxbid"]').fill(maxBid);
      await form.locator('input[type="submit"]').click();
      await page.waitForLoadState("domcontentloaded", { timeout: 30_000 });
      // Checking the raw page HTML for itemId is unreliable: a rejected
      // submission (e.g. Gixen refusing a non-auction listing) can redisplay
      // the submitted id in the sticky form field or an error message,
      // producing a false positive. Require the id to appear in an actual
      // snipe-list row instead, the same signal submitDeleteSnipe already
      // trusts to confirm list membership.
      const added = await page.locator("tr", { hasText: itemId }).count();
      if (added > 0) return { ok: true, message: `Added item ${itemId} to Gixen's snipe queue.` };
      const bodyText = await page.locator("body").innerText().catch(() => "");
      console.error(`[gixen-client] add-snipe not confirmed for item ${itemId}. Page text:`, bodyText.slice(0, 2000));
      return { ok: false, message: "Could not confirm the item was added to Gixen's snipe queue." };
    },

    async submitDeleteSnipe(page, { itemId }) {
      if (!DASHBOARD_PATTERN.test(page.url())) throw new Error("gixen-session-lost");
      const row = page.locator("tr", { hasText: itemId }).first();
      if (!(await row.count())) return { ok: false, message: `Could not find a Gixen snipe for item ${itemId} to delete.` };
      const deleteButton = row.getByRole("button", { name: "Delete" });
      if (!(await deleteButton.count())) return { ok: false, message: `Found item ${itemId} on Gixen but no delete control for it.` };
      await deleteButton.click();
      await page.waitForLoadState("domcontentloaded", { timeout: 30_000 });
      const stillThere = await page.locator("tr", { hasText: itemId }).count();
      if (stillThere > 0) return { ok: false, message: `Could not confirm item ${itemId} was removed from Gixen.` };
      return { ok: true, message: `Removed item ${itemId} from Gixen's snipe queue.` };
    },
  };
}

let driver: GixenDriver = realDriver();
let session: Promise<GixenSession> | null = null;
let queue: Promise<unknown> = Promise.resolve();

/** Test-only seam: swap the driver instead of mocking fetch/real Chromium. */
export function __setGixenDriver(next: GixenDriver) {
  driver = next;
  session = null;
}
export function __resetGixenDriver() {
  driver = realDriver();
  session = null;
}

async function getSession(creds: { username: string; password: string }) {
  if (!session) {
    session = (async () => {
      const born = await driver.launch();
      await driver.login(born.page, creds);
      return born;
    })();
  }
  return session;
}

// Runs `fn` against a lazily-created, cached, logged-in session that's reused
// across calls within the same warm process (so a batch of several snipes in
// one background tick only logs in once). Chained through a FIFO queue since
// a single Page isn't safe for concurrent use — addSnipe/deleteSnipe are
// called from two independent call sites that could otherwise overlap.
async function withBrowserSession<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  const creds = credentials()!;
  const run = async (): Promise<T> => {
    try {
      const { page } = await getSession(creds);
      return await fn(page);
    } catch {
      // The cached session may be dead (logged out, crashed page, etc.) —
      // drop it and retry once with a fresh login before giving up.
      session = null;
      const { page } = await getSession(creds);
      return await fn(page);
    }
  };
  const result = queue.then(run, run);
  queue = result.then(() => undefined, () => undefined);
  return result;
}

async function browserAddSnipe(itemId: string, maxBid: string): Promise<GixenResult> {
  try {
    return await withBrowserSession((page) => driver.submitAddSnipe(page, { itemId, maxBid }));
  } catch (error) {
    console.error("[gixen-client] addSnipe automation failed:", error);
    return { ok: false, message: "Gixen automation failed unexpectedly." };
  }
}

async function browserDeleteSnipe(itemId: string): Promise<GixenResult> {
  try {
    return await withBrowserSession((page) => driver.submitDeleteSnipe(page, { itemId }));
  } catch (error) {
    console.error("[gixen-client] deleteSnipe automation failed:", error);
    return { ok: false, message: "Gixen automation failed unexpectedly." };
  }
}

export async function addSnipe({ itemId, maxBid, quantity = 1 }: { itemId: string; maxBid: number; quantity?: number }): Promise<GixenResult> {
  if (automationMode() === "api") return callApi({ itemid: itemId, maxbid: maxBid.toFixed(2), quantity: String(quantity) });
  const creds = credentials();
  if (!creds) return { ok: false, message: "Gixen credentials are not configured." };
  return browserAddSnipe(gixenItemId(itemId), maxBid.toFixed(2));
}

export async function deleteSnipe({ itemId }: { itemId: string }): Promise<GixenResult> {
  if (automationMode() === "api") return callApi({ ditemid: itemId });
  const creds = credentials();
  if (!creds) return { ok: false, message: "Gixen credentials are not configured." };
  return browserDeleteSnipe(gixenItemId(itemId));
}
