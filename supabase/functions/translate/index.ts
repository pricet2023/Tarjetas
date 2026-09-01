// Translation suggestions for the card editor.
//
//   POST /translate  { text: string, from: "en" | "es" }
//   -> 200 { text, provider, confidence? }
//
// Fronted by an edge function rather than called from the browser so the
// provider (and any future API key) stays server-side, and so the app has a
// stable shape to code against while we try different providers.
//
// Run locally: supabase functions serve translate
// The client sends the user's Supabase JWT; verify_jwt in config.toml keeps
// this from being an open translation proxy.

import { corsHeaders, json } from "../_shared/cors.ts";
import { activeProvider, type Lang } from "./provider.ts";

// A flash card side is a word or a short phrase. The cap keeps us inside the
// free provider's quota and stops the endpoint being used as a bulk
// translator.
const MAX_CHARS = 200;

const isLang = (v: unknown): v is Lang => v === "en" || v === "es";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  let payload: { text?: unknown; from?: unknown };
  try {
    payload = await req.json();
  } catch {
    return json({ error: "Body must be JSON" }, 400);
  }

  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  const from = payload.from;

  if (!text) {
    return json({ error: "`text` is required" }, 400);
  }
  if (text.length > MAX_CHARS) {
    return json({ error: `\`text\` must be ${MAX_CHARS} characters or fewer` }, 400);
  }
  if (!isLang(from)) {
    return json({ error: '`from` must be "en" or "es"' }, 400);
  }

  const to: Lang = from === "en" ? "es" : "en";

  try {
    return json(await activeProvider.translate(text, from, to));
  } catch (err) {
    // A suggestion is a convenience — the editor stays usable when it fails,
    // so surface the reason and let the client degrade quietly.
    console.error("translate failed:", err);
    return json(
      { error: err instanceof Error ? err.message : "Translation failed" },
      502,
    );
  }
});
