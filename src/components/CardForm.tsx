import { ArrowLeftRight, Check, Loader2, Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { type CardInput } from "@/api/cards";
import { suggestTranslation } from "@/api/translate";
import { cn } from "@/app/lib/utils";
import type { Card, Side } from "@/types/cards";

/** Idle time before a translation is requested for what's been typed. */
const DEBOUNCE_MS = 650;
/** How long the "applied" flash sits on a field after a suggestion is taken. */
const FLASH_MS = 800;

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
  // Field that just took a suggestion, so it can flash. Presentation only.
  const [flash, setFlash] = useState<Side | null>(null);

  // Bumped on every fetch so a slow response for stale input is discarded.
  const requestId = useRef(0);

  const sourceText = source === "english" ? english : source === "spanish" ? spanish : "";
  const targetText = source === "english" ? spanish : english;
  const target: Side | null = source === "english" ? "spanish" : source === "spanish" ? "english" : null;

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

  // Clear the applied-flash once its animation has run.
  useEffect(() => {
    if (!flash) return;
    const timer = window.setTimeout(() => setFlash(null), FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [flash]);

  const applySuggestion = () => {
    if (!suggestion) return;
    if (suggestion.side === "spanish") setSpanish(suggestion.text);
    else setEnglish(suggestion.text);
    setFlash(suggestion.side);
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
      <div className="grid gap-4 sm:grid-cols-[1fr_auto_1fr] sm:items-start">
        <div className="space-y-2">
          <Field
            label="English"
            value={english}
            onChange={(v) => {
              setEnglish(v);
              setSource("english");
            }}
            placeholder="the house"
            autoFocus={!card}
            busy={suggesting && target === "english"}
            flash={flash === "english"}
          />
          {showSuggestion && suggestion.side === "english" ? (
            <SuggestionChip
              text={suggestion.text}
              provider={suggestion.provider}
              onApply={applySuggestion}
              onDismiss={() => setSuggestion(null)}
            />
          ) : null}
        </div>

        {/* The link between the two sides; it spins while a translation is in
            flight so the wait has somewhere to look. */}
        <div className="hidden self-center pt-7 sm:block">
          <div
            className={cn(
              "relative flex h-9 w-9 items-center justify-center rounded-full",
              suggesting ? "ring-sweep overflow-hidden" : "",
            )}
          >
            <div className="plate absolute inset-[1.5px] rounded-full" />
            <ArrowLeftRight
              className={cn(
                "relative h-4 w-4 transition-colors duration-300",
                suggesting ? "animate-pulseGlow text-neon-cyan" : "text-steel-500",
              )}
            />
          </div>
        </div>

        <div className="space-y-2">
          <Field
            label="Español"
            value={spanish}
            onChange={(v) => {
              setSpanish(v);
              setSource("spanish");
            }}
            placeholder="la casa"
            busy={suggesting && target === "spanish"}
            flash={flash === "spanish"}
          />
          {showSuggestion && suggestion.side === "spanish" ? (
            <SuggestionChip
              text={suggestion.text}
              provider={suggestion.provider}
              onApply={applySuggestion}
              onDismiss={() => setSuggestion(null)}
            />
          ) : null}
        </div>
      </div>

      <TranslationStatus
        busy={suggesting}
        source={source}
        provider={showSuggestion ? suggestion.provider : null}
      />

      <Field
        label="Notes"
        hint="optional"
        value={notes}
        onChange={setNotes}
        placeholder="feminine — la casa es grande"
      />

      {error ? (
        <p
          role="alert"
          className="animate-riseIn rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm font-medium text-rose-300"
        >
          {error}
        </p>
      ) : null}

      <div className="flex gap-2 pt-1">
        <button type="submit" disabled={saving} className="btn btn-primary sheen flex-1">
          {saving ? (
            <>
              <span className="shimmer-band absolute inset-0 animate-shimmer opacity-60" />
              <Loader2 className="relative h-4 w-4 animate-spin" />
            </>
          ) : null}
          <span className="relative">{card ? "Save changes" : "Add card"}</span>
        </button>
        {onCancel ? (
          <button type="button" onClick={onCancel} className="btn btn-steel sheen">
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
  flash,
  autoFocus,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange(value: string): void;
  placeholder?: string;
  /** A translation for this field is being generated. */
  busy?: boolean;
  /** This field just took a suggestion. */
  flash?: boolean;
  autoFocus?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-center gap-2">
        <span className="label">{label}</span>
        {hint ? <span className="label text-steel-600">{hint}</span> : null}
        {busy ? (
          <span className="label animate-ticker text-neon-cyan">translating</span>
        ) : null}
        {flash ? (
          <span className="label flex animate-popIn items-center gap-1 text-neon-mint">
            <Check className="h-3 w-3" /> applied
          </span>
        ) : null}
      </span>

      {/* The 1.5px gutter is always there so the sweeping ring can appear
          without nudging the layout. */}
      <span
        className={cn(
          "relative block overflow-hidden rounded-xl p-[1.5px]",
          busy && "ring-sweep",
          flash && "shadow-mint",
        )}
      >
        <input
          type="text"
          value={value}
          autoFocus={autoFocus}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoComplete="off"
          autoCapitalize="none"
          className={cn(
            "input-metal relative z-10",
            flash && "border-neon-mint/50 text-neon-mint",
          )}
        />
        {/* Scan line, sweeping down the field while the provider is queried. */}
        {busy ? (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-x-[1.5px] z-20 h-8 animate-scan bg-gradient-to-b from-transparent via-neon-cyan/30 to-transparent"
          />
        ) : null}
        {flash ? (
          <span aria-hidden className="sheen-run pointer-events-none absolute inset-0 z-20" />
        ) : null}
      </span>
    </label>
  );
}

/** A one-line readout of what the translator is doing. */
function TranslationStatus({
  busy,
  source,
  provider,
}: {
  busy: boolean;
  source: Side | null;
  provider: string | null;
}) {
  const arrow = source === "english" ? "en → es" : source === "spanish" ? "es → en" : "en ⇄ es";
  return (
    <div className="well flex items-center gap-3 px-3 py-2">
      <span
        className={cn(
          "h-1.5 w-1.5 shrink-0 rounded-full",
          busy
            ? "animate-pulseGlow bg-neon-cyan shadow-cyan"
            : provider
              ? "bg-neon-mint shadow-mint"
              : "bg-steel-600",
        )}
      />
      <span className="label shrink-0">{arrow}</span>

      {busy ? (
        // Equaliser bars: cheap, legible "working on it".
        <span aria-hidden className="flex flex-1 items-center gap-0.5">
          {Array.from({ length: 24 }, (_, i) => (
            <span
              key={i}
              className="w-full animate-pulseGlow rounded-full bg-neon-cyan/70"
              // A standing wave rather than noise: it reads as a signal.
              style={{
                height: `${(4 + 5 * (1 + Math.sin(i * 0.8))).toFixed(1)}px`,
                animationDelay: `${i * 55}ms`,
              }}
            />
          ))}
        </span>
      ) : (
        <span className="h-px flex-1 bg-gradient-to-r from-white/10 to-transparent" />
      )}

      <span className="label shrink-0 truncate">
        {busy ? "consultando…" : provider ? `via ${provider}` : "auto-translate armed"}
      </span>
    </div>
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
    <div className="plate sheen-run flex animate-popIn items-center gap-2 rounded-xl border-neon-cyan/25 px-3 py-2 text-sm shadow-cyan">
      <Sparkles className="h-4 w-4 shrink-0 animate-pulseGlow text-neon-cyan" />
      <button
        type="button"
        onClick={onApply}
        className="min-w-0 flex-1 truncate text-left font-medium text-steel-50 transition hover:text-neon-ice"
        title={`Use "${text}" (via ${provider})`}
      >
        {/* Typed out a character at a time, so an arriving suggestion is felt. */}
        {[...text].map((char, i) => (
          <span
            key={i}
            className="inline-block animate-charIn whitespace-pre"
            style={{ animationDelay: `${i * 18}ms` }}
          >
            {char}
          </span>
        ))}
      </button>
      <span className="label hidden shrink-0 sm:inline">tap to use</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss suggestion"
        className="shrink-0 rounded-lg p-1 text-steel-500 transition hover:bg-white/5 hover:text-steel-100"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
