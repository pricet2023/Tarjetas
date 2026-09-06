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
// attaches the JWT to every PostgREST and Edge Function call. That JWT is what
// the RLS policies key off — being signed in at all gets you the shared deck,
// and `auth.uid()` picks out your own progress within it.
export const supabase = createClient<Database>(supabaseUrl, supabaseAnonKey);
