import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/types/database.types";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl) {
  throw new Error("VITE_SUPABASE_URL is not set — copy .env.example to .env");
}
if (!supabaseAnonKey) {
  throw new Error("VITE_SUPABASE_ANON_KEY is not set — run `npx supabase status`");
}

// Supabase Auth owns the session; supabase-js persists it to localStorage and
// attaches the JWT to every PostgREST and Edge Function call, which is what
// the `user_id = auth.uid()` RLS policies key off.
export const supabase = createClient<Database>(supabaseUrl, supabaseAnonKey);
