import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { staffOnly } from "@/app/api/bids/auth";
import { buildEbayConsentUrl, getEbayOAuthRuName } from "@/lib/ebay-oauth";

export async function GET(request: Request) {
  const denied = await staffOnly(request);
  if (denied) return denied;
  const clientId = process.env.EBAY_CLIENT_ID;
  const accountId = new URL(request.url).searchParams.get("accountId");
  if (!clientId) return NextResponse.json({ error: "EBAY_CLIENT_ID is not configured." }, { status: 503 });
  let ruName: string;
  try {
    ruName = getEbayOAuthRuName();
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "eBay OAuth is not configured." }, { status: 503 });
  }
  const state = randomBytes(24).toString("hex");
  let url: URL;
  try {
    url = buildEbayConsentUrl(clientId, ruName, state);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "eBay OAuth scopes are not configured." }, { status: 503 });
  }
  const response = NextResponse.redirect(url);
  const secure = new URL(request.url).protocol === "https:";
  response.cookies.set("ebay_oauth_state", state, { httpOnly: true, sameSite: "lax", secure, maxAge: 600, path: "/" });
  if (accountId) response.cookies.set("ebay_oauth_account_id", accountId, { httpOnly: true, sameSite: "lax", secure, maxAge: 600, path: "/" });
  return response;
}
