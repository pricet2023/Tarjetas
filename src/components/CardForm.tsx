import { Loader2, Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { type CardInput } from "@/api/cards";
import { suggestTranslation } from "@/api/translate";
import { cn } from "@/app/lib/utils";
import type { Card, Side } from "@/types/cards";

/** Idle time before a translation is requested for what's been typed. */
const DEBOUNCE_MS = 650;

interface CardFormProps {
  /** Present when editing; absent when adding. */
  card?: Card;
  onSubmit(input: CardInput): Promise<void>;
  onCancel?(): void;
}

interface Suggestion {
  /** The side the suggestion is *for*. */
  side: Side;
  text: string;
  provider: string;
}

export function CardForm({ card, onSubmit, onCancel }: CardFormProps) {
  const [english, setEnglish] = useState(card?.english ?? "");
  const [spanish, setSpanish] = useState(card?.spanish ?? "");
  const [notes, setNotes] = useState(card?.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  // Which field the user last typed into — the translation goes the other way.
  const [source, setSource] = useState<Side | null>(null);

  // Bumped on every fetch so a slow response for stale input is discarded.
  const requestId = useRef(0);

  const sourceText = source === "english" ? english : source === "spanish" ? spanish : "";
  const targetText = source === "english" ? spanish : english;

  useEffect(() => {
    const text = sourceText.trim();
    if (!source || text.length < 2) {
      setSuggestion(null);
      return;
    }

    const id = ++requestId.current;
    const timer = window.setTimeout(async () => {
      setSuggesting(true);
      try {
        const result = await suggestTranslation(text, source === "english" ? "en" : "es");
        if (id !== requestId.current) return;
        setSuggestion({
          side: source === "english" ? "spanish" : "english",
          text: result.text,
          provider: result.provider,
        });
      } catch {
        // A suggestion is a convenience. If the provider is down or out of
        // quota the form stays fully usable, so fail quietly.
        if (id === requestId.current) setSuggestion(null);
      } finally {
        if (id === requestId.current) setSuggesting(false);
      }
    }, DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [sourceText, source]);

  const applySuggestion = () => {
    if (!suggestion) return;
    if (suggestion.side === "spanish") setSpanish(suggestion.text);
    else setEnglish(suggestion.text);
    setSuggestion(null);
  };

  // Don't offer a translation that's already in the box.
  const showSuggestion =
    suggestion !== null &&
    suggestion.text.trim().toLowerCase() !== targetText.trim().toLowerCase();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!english.trim() || !spanish.trim()) {
      setError("Both sides are required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSubmit({ english, spanish, notes });
      if (!card) {
        setEnglish("");
        setSpanish("");
        setNotes("");
        setSource(null);
        setSuggestion(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <Field
        label="English"
        value={english}
        onChange={(v) => {
          setEnglish(v);
          setSource("english");
        }}
        placeholder="the house"
        autoFocus={!card}
      />
      {showSuggestion && suggestion.side === "english" ? (
        <SuggestionChip
          text={suggestion.text}
          provider={suggestion.provider}
          onApply={applySuggestion}
          onDismiss={() => setSuggestion(null)}
        />
      ) : null}

      <Field
        label="Español"
        value={spanish}
        onChange={(v) => {
          setSpanish(v);
          setSource("spanish");
        }}
        placeholder="la casa"
        busy={suggesting && source === "english"}
      />
      {showSuggestion && suggestion.side === "spanish" ? (
        <SuggestionChip
          text={suggestion.text}
          provider={suggestion.provider}
          onApply={applySuggestion}
          onDismiss={() => setSuggestion(null)}
        />
      ) : null}

      <Field
        label="Notes"
        hint="optional"
        value={notes}
        onChange={setNotes}
        placeholder="feminine — la casa es grande"
      />

      {error ? (
        <p role="alert" className="text-sm font-medium text-rose-600">
          {error}
        </p>
      ) : null}

      <div className="flex gap-2 pt-1">
        <button
          type="submit"
          disabled={saving}
          className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 font-semibold text-white transition hover:bg-indigo-700 disabled:opacity-50"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {card ? "Save changes" : "Add card"}
        </button>
        {onCancel ? (
          <button
            type="button"
            onClick={onCancel}
            className="rounded-xl border border-slate-300 px-4 py-2.5 font-semibold text-slate-600 transition hover:bg-slate-100"
          >
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );
}

function Field({
  label,
  hint,
  value,
  onChange,
  placeholder,
  busy,
  autoFocus,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange(value: string): void;
  placeholder?: string;
  busy?: boolean;
  autoFocus?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1 flex items-center gap-2 text-sm font-semibold text-slate-600">
        {label}
        {hint ? <span className="font-normal text-slate-400">{hint}</span> : null}
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin text-indigo-500" /> : null}
      </span>
      <input
        type="text"
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        autoCapitalize="none"
        className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-base outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
      />
    </label>
  );
}

function SuggestionChip({
  text,
  provider,
  onApply,
  onDismiss,
}: {
  text: string;
  provider: string;
  onApply(): void;
  onDismiss(): void;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-xl border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm",
        "animate-popIn",
      )}
    >
      <Sparkles className="h-4 w-4 shrink-0 text-indigo-500" />
      <button
        type="button"
        onClick={onApply}
        className="min-w-0 flex-1 truncate text-left font-medium text-indigo-900 hover:underline"
        title={`Use "${text}" (via ${provider})`}
      >
        {text}
      </button>
      <span className="hidden shrink-0 text-xs text-indigo-400 sm:inline">tap to use</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss suggestion"
        className="shrink-0 rounded-lg p-1 text-indigo-400 transition hover:bg-indigo-100 hover:text-indigo-700"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
