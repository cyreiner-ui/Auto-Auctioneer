import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { staffOnly } from "@/app/api/bids/auth";
import { encryptToken } from "@/lib/token-crypto";
import { ebayApiBaseUrl } from "@/lib/ebay-endpoints";
import { getEbayOAuthRuName } from "@/lib/ebay-oauth";

export async function GET(request: Request) {
  const denied = await staffOnly(request);
  if (denied) return denied;
  const url = new URL(request.url);
  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    const description = url.searchParams.get("error_description") || "The eBay account connection was declined.";
    return NextResponse.json({ error: oauthError, description }, { status: 400 });
  }
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const store = await cookies();
  if (!state || state !== store.get("ebay_oauth_state")?.value || !code) return NextResponse.json({ error: "Invalid eBay OAuth callback." }, { status: 400 });
  const clientId = process.env.EBAY_CLIENT_ID;
  const clientSecret = process.env.EBAY_CLIENT_SECRET;
  const accountId = store.get("ebay_oauth_account_id")?.value;
  if (!clientId || !clientSecret) return NextResponse.json({ error: "eBay OAuth client credentials are not configured." }, { status: 503 });
  let ruName: string;
  try {
    ruName = getEbayOAuthRuName();
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "eBay OAuth is not configured." }, { status: 503 });
  }
  const tokenResponse = await fetch(`${ebayApiBaseUrl()}/identity/v1/oauth2/token`, { method: "POST", headers: { Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: ruName }) });
  if (!tokenResponse.ok) {
    const details = await tokenResponse.json().catch(() => ({})) as { error?: string; error_description?: string };
    return NextResponse.json({ error: details.error || "ebay_authorization_failed", description: details.error_description || "eBay did not authorize this account." }, { status: 502 });
  }
  const token = await tokenResponse.json() as { refresh_token?: string; refresh_token_expires_in?: number };
  if (!token.refresh_token) return NextResponse.json({ error: "eBay did not return a refresh token." }, { status: 502 });
  let encryptedToken: string;
  try { encryptedToken = encryptToken(token.refresh_token); } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Token encryption is not configured." }, { status: 503 }); }
  const account = { marketplace: process.env.EBAY_MARKETPLACE_ID || "EBAY_US", status: "connected", refresh_token_ciphertext: encryptedToken, token_expires_at: token.refresh_token_expires_in ? new Date(Date.now() + token.refresh_token_expires_in * 1000).toISOString() : null };
  const query = accountId ? supabaseAdmin.from("ebay_accounts").update(account).eq("id", accountId) : supabaseAdmin.from("ebay_accounts").insert({ ...account, label: "Connected eBay account" });
  const { error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const response = NextResponse.redirect(new URL("/?ebay=connected", request.url)); response.cookies.delete("ebay_oauth_state"); response.cookies.delete("ebay_oauth_account_id"); return response;
}
