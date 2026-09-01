// Translation providers. The app only ever sees `translate()`, so swapping
// MyMemory for DeepL/Gemini later is a change to this file alone.

export type Lang = "en" | "es";

export interface TranslationResult {
  text: string;
  provider: string;
  /** 0–1 where the provider reports one; undefined when it doesn't. */
  confidence?: number;
}

export interface Provider {
  name: string;
  translate(text: string, from: Lang, to: Lang): Promise<TranslationResult>;
}

const LOCALE: Record<Lang, string> = { en: "en-GB", es: "es-ES" };

// MyMemory: free, no API key, ~5k chars/day per anonymous IP. Fine for the
// single words and short phrases a flash card holds; it degrades badly on
// long prose, which is why the caller caps input length.
export const myMemory: Provider = {
  name: "mymemory",
  async translate(text, from, to) {
    const url = new URL("https://api.mymemory.translated.net/get");
    url.searchParams.set("q", text);
    url.searchParams.set("langpair", `${LOCALE[from]}|${LOCALE[to]}`);

    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      throw new Error(`MyMemory responded ${res.status}`);
    }

    const body = await res.json();
    const translated = body?.responseData?.translatedText;
    if (typeof translated !== "string" || translated.length === 0) {
      throw new Error("MyMemory returned no translation");
    }

    // MyMemory reports quota exhaustion and other soft failures in the
    // response body with a 200 status, putting the error text where the
    // translation should be.
    if (/^MYMEMORY WARNING/i.test(translated) || body?.responseStatus === 403) {
      throw new Error(body?.responseDetails || "MyMemory quota exceeded");
    }

    const match = Number(body?.responseData?.match);
    return {
      text: translated,
      provider: myMemory.name,
      confidence: Number.isFinite(match) ? match : undefined,
    };
  },
};

export const activeProvider: Provider = myMemory;
