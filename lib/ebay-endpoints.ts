export type EbayEnvironment = "sandbox" | "production";

export function getEbayEnvironment(value = process.env.EBAY_ENVIRONMENT): EbayEnvironment {
  const environment = String(value || "production").trim().toLowerCase();
  if (environment !== "sandbox" && environment !== "production") {
    throw new Error("EBAY_ENVIRONMENT must be either sandbox or production.");
  }
  return environment;
}

export function ebayApiBaseUrl(value = process.env.EBAY_ENVIRONMENT) {
  return getEbayEnvironment(value) === "sandbox" ? "https://api.sandbox.ebay.com" : "https://api.ebay.com";
}

export function ebayAuthBaseUrl(value = process.env.EBAY_ENVIRONMENT) {
  return getEbayEnvironment(value) === "sandbox" ? "https://auth.sandbox.ebay.com" : "https://auth.ebay.com";
}
