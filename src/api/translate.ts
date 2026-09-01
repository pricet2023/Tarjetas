import { supabase } from "@/app/lib/supabase";

export type Lang = "en" | "es";

export interface Suggestion {
  text: string;
  provider: string;
  confidence?: number;
}

/**
 * Ask the `translate` edge function for the other side of a card.
 * Throws on failure — callers treat a suggestion as optional and carry on.
 */
export async function suggestTranslation(
  text: string,
  from: Lang,
): Promise<Suggestion> {
  const { data, error } = await supabase.functions.invoke<Suggestion & { error?: string }>(
    "translate",
    { body: { text, from } },
  );

  if (error) throw new Error(error.message);
  if (!data || data.error) throw new Error(data?.error ?? "No suggestion returned");
  return data;
}
