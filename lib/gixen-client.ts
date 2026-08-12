const GIXEN_API_URL = "https://www.gixen.com/api.php";

export type GixenResult = { ok: boolean; message: string };

function credentials() {
  const username = process.env.GIXEN_USERNAME?.trim();
  const password = process.env.GIXEN_PASSWORD?.trim();
  if (!username || !password) return null;
  return { username, password };
}

async function call(params: Record<string, string>) {
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

export async function addSnipe({ itemId, maxBid, quantity = 1 }: { itemId: string; maxBid: number; quantity?: number }): Promise<GixenResult> {
  return call({ itemid: itemId, maxbid: maxBid.toFixed(2), quantity: String(quantity) });
}

export async function deleteSnipe({ itemId }: { itemId: string }): Promise<GixenResult> {
  return call({ ditemid: itemId });
}
