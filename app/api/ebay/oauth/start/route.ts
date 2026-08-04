import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { staffOnly } from "@/app/api/bids/auth";
import { ebayAuthBaseUrl } from "@/lib/ebay-endpoints";

export async function GET(request: Request) {
  const denied = await staffOnly(request);
  if (denied) return denied;
  const clientId = process.env.EBAY_CLIENT_ID;
  const redirectUri = process.env.EBAY_OAUTH_REDIRECT_URI;
  const accountId = new URL(request.url).searchParams.get("accountId");
  if (!clientId || !redirectUri) return NextResponse.json({ error: "eBay OAuth is not configured." }, { status: 503 });
  const state = randomBytes(24).toString("hex");
  const url = new URL(`${ebayAuthBaseUrl()}/oauth2/authorize`);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "https://api.ebay.com/oauth/api_scope/buy.offer https://api.ebay.com/oauth/api_scope/buy.browse");
  url.searchParams.set("state", state);
  const response = NextResponse.redirect(url);
  response.cookies.set("ebay_oauth_state", state, { httpOnly: true, sameSite: "lax", secure: true, maxAge: 600, path: "/" });
  if (accountId) response.cookies.set("ebay_oauth_account_id", accountId, { httpOnly: true, sameSite: "lax", secure: true, maxAge: 600, path: "/" });
  return response;
}
