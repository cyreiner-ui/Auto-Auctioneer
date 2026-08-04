const value = (name: string) => process.env[name]?.trim();

export function requiredEnv(name: string) {
  const result = value(name);
  if (!result) throw new Error(`${name} is not configured.`);
  return result;
}

export function supabaseUrl() {
  return (value("SUPABASE_URL") || value("NEXT_PUBLIC_SUPABASE_URL") || requiredEnv("SUPABASE_URL")).replace(/\/$/, "");
}

export function validateBiddingConfig() {
  if (!value("SUPABASE_URL") && !value("NEXT_PUBLIC_SUPABASE_URL")) throw new Error("SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL is not configured.");
  requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  requiredEnv("EBAY_CLIENT_ID");
  requiredEnv("EBAY_CLIENT_SECRET");
  requiredEnv("EBAY_TOKEN_ENCRYPTION_KEY");
  requiredEnv("EBAY_MARKETPLACE_ID");
}
