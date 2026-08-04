import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { staffOnly } from "@/app/api/bids/auth";
import { encryptToken } from "@/lib/token-crypto";

export async function GET(request: Request) {
  const denied = await staffOnly(request);
  if (denied) return denied;
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const store = await cookies();
  if (!state || state !== store.get("ebay_oauth_state")?.value || !code) return NextResponse.json({ error: "Invalid eBay OAuth callback." }, { status: 400 });
  const clientId = process.env.EBAY_CLIENT_ID; const clientSecret = process.env.EBAY_CLIENT_SECRET; const redirectUri = process.env.EBAY_OAUTH_REDIRECT_URI; const accountId = store.get("ebay_oauth_account_id")?.value;
  if (!clientId || !clientSecret || !redirectUri) return NextResponse.json({ error: "eBay OAuth is not configured." }, { status: 503 });
  const tokenResponse = await fetch("https://api.ebay.com/identity/v1/oauth2/token", { method: "POST", headers: { Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri }) });
  if (!tokenResponse.ok) return NextResponse.json({ error: "eBay did not authorize this account." }, { status: 502 });
  const token = await tokenResponse.json() as { refresh_token?: string; refresh_token_expires_in?: number };
  if (!token.refresh_token) return NextResponse.json({ error: "eBay did not return a refresh token." }, { status: 502 });
  let encryptedToken: string;
  try { encryptedToken = encryptToken(token.refresh_token); } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Token encryption is not configured." }, { status: 503 }); }
  const account = { label: "Connected eBay account", marketplace: process.env.EBAY_MARKETPLACE_ID || "EBAY_US", status: "connected", refresh_token_ciphertext: encryptedToken, token_expires_at: token.refresh_token_expires_in ? new Date(Date.now() + token.refresh_token_expires_in * 1000).toISOString() : null };
  const query = accountId ? supabaseAdmin.from("ebay_accounts").update(account).eq("id", accountId) : supabaseAdmin.from("ebay_accounts").insert(account);
  const { error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const response = NextResponse.redirect(new URL("/", request.url)); response.cookies.delete("ebay_oauth_state"); response.cookies.delete("ebay_oauth_account_id"); return response;
}
