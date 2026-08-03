import { createClient } from "@supabase/supabase-js";

export const supabaseAdmin = createClient(process.env.SUPABASE_URL || "https://placeholder.supabase.co", process.env.SUPABASE_SERVICE_ROLE_KEY || "placeholder", {
  auth: { autoRefreshToken: false, persistSession: false },
});

export const IMAGE_BUCKET = "listing-images";
