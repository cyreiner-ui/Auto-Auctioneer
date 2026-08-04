export const EBAY_PUBLIC_SCOPE = "https://api.ebay.com/oauth/api_scope";
export const EBAY_AUCTION_OFFER_SCOPE = "https://api.ebay.com/oauth/api_scope/buy.offer.auction";
export const DEFAULT_EBAY_OAUTH_SCOPES = [EBAY_PUBLIC_SCOPE, EBAY_AUCTION_OFFER_SCOPE] as const;

type EbayOAuthEnvironment = {
  [key: string]: string | undefined;
  EBAY_OAUTH_RUNAME?: string;
  EBAY_OAUTH_REDIRECT_URI?: string;
  EBAY_OAUTH_SCOPES?: string;
};

export function getEbayOAuthRuName(environment: EbayOAuthEnvironment = process.env) {
  // EBAY_OAUTH_REDIRECT_URI remains a fallback so existing deployments fail with
  // a useful message instead of breaking solely because the variable was renamed.
  const ruName = String(environment.EBAY_OAUTH_RUNAME || environment.EBAY_OAUTH_REDIRECT_URI || "").trim();
  if (!ruName) throw new Error("EBAY_OAUTH_RUNAME is not configured.");
  if (/^https?:\/\//i.test(ruName)) {
    throw new Error("EBAY_OAUTH_RUNAME must be the eBay RuName, not the callback URL.");
  }
  if (/\s/.test(ruName)) throw new Error("EBAY_OAUTH_RUNAME cannot contain spaces.");
  return ruName;
}

export function getEbayOAuthScopes(value = process.env.EBAY_OAUTH_SCOPES) {
  const scopes = String(value || DEFAULT_EBAY_OAUTH_SCOPES.join(" "))
    .split(/\s+/)
    .map((scope) => scope.trim())
    .filter(Boolean);

  for (const requiredScope of DEFAULT_EBAY_OAUTH_SCOPES) {
    if (!scopes.includes(requiredScope)) {
      throw new Error(`EBAY_OAUTH_SCOPES must include ${requiredScope}.`);
    }
  }

  return [...new Set(scopes)].join(" ");
}

export function buildEbayConsentUrl(clientId: string, ruName: string, state: string, environment = process.env.EBAY_ENVIRONMENT) {
  const targetEnvironment = String(environment || "production").trim().toLowerCase();
  if (targetEnvironment !== "sandbox" && targetEnvironment !== "production") {
    throw new Error("EBAY_ENVIRONMENT must be either sandbox or production.");
  }
  const authBaseUrl = targetEnvironment === "sandbox" ? "https://auth.sandbox.ebay.com" : "https://auth.ebay.com";
  const url = new URL(`${authBaseUrl}/oauth2/authorize`);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", ruName);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", getEbayOAuthScopes());
  url.searchParams.set("state", state);
  return url;
}
