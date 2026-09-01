import { Loader2, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { getStudyDeck, recordReview } from "@/api/cards";
import { FlashCard } from "@/components/FlashCard";
import type { Card, Side } from "@/types/cards";

const DECK_SIZE = 20;

/** Which side leads for the whole session. */
type Direction = Side | "mixed";

export function Study() {
  const [deck, setDeck] = useState<Card[]>([]);
  const [index, setIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [score, setScore] = useState({ knew: 0, total: 0 });
  const [direction, setDirection] = useState<Direction>("english");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setDeck(await getStudyDeck(DECK_SIZE));
      setIndex(0);
      setScore({ knew: 0, total: 0 });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to build deck");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const current = deck[index];

  // For "mixed", the side is derived from the card id so it stays stable if
  // the same card is re-rendered mid-session.
  const promptSide: Side =
    direction === "mixed"
      ? current && current.id.charCodeAt(0) % 2 === 0
        ? "english"
        : "spanish"
      : direction;

  const handleSwipe = (knew: boolean) => {
    if (!current) return;
    setScore((s) => ({ knew: s.knew + (knew ? 1 : 0), total: s.total + 1 }));
    setIndex((i) => i + 1);
    // Fire-and-forget: the next card shouldn't wait on the write. A failed
    // review only costs us one row of history, so surface it and move on.
    void recordReview(current.id, knew, promptSide).catch((err) => {
      setError(err instanceof Error ? err.message : "Failed to save review");
    });
  };

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
      </div>
    );
  }

  if (error && deck.length === 0) {
    return <p role="alert" className="py-12 text-center text-rose-600">{error}</p>;
  }

  if (deck.length === 0) {
    return (
      <div className="py-16 text-center">
        <p className="mb-4 text-slate-500">No cards to study yet.</p>
        <Link
          to="/cards"
          className="rounded-xl bg-indigo-600 px-4 py-2.5 font-semibold text-white transition hover:bg-indigo-700"
        >
          Add your first card
        </Link>
      </div>
    );
  }

  if (!current) {
    return (
      <div className="py-16 text-center">
        <p className="text-5xl font-bold tracking-tight">
          {score.knew}
          <span className="text-slate-300">/{score.total}</span>
        </p>
        <p className="mb-6 mt-2 text-slate-500">Deck finished.</p>
        <button
          onClick={() => void load()}
          className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 font-semibold text-white transition hover:bg-indigo-700"
        >
          <RotateCcw className="h-4 w-4" />
          Shuffle again
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-5">
      <div className="flex w-full max-w-sm items-center justify-between text-sm">
        <span className="font-semibold text-slate-500">
          {index + 1} / {deck.length}
        </span>
        <DirectionPicker value={direction} onChange={setDirection} />
      </div>

      <FlashCard card={current} promptSide={promptSide} onSwipe={handleSwipe} />

      <p className="text-center text-sm text-slate-400">
        Tap the card to reveal · swipe <span className="font-semibold text-rose-500">left</span> if you
        didn&rsquo;t know it, <span className="font-semibold text-emerald-600">right</span> if you did
      </p>

      {error ? (
        <p role="alert" className="text-sm font-medium text-rose-600">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function DirectionPicker({
  value,
  onChange,
}: {
  value: Direction;
  onChange(value: Direction): void;
}) {
  const options: { value: Direction; label: string }[] = [
    { value: "english", label: "EN→ES" },
    { value: "spanish", label: "ES→EN" },
    { value: "mixed", label: "Mixed" },
  ];
  return (
    <div className="flex rounded-lg border border-slate-200 bg-white p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={
            value === o.value
              ? "rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-semibold text-white"
              : "rounded-md px-2.5 py-1 text-xs font-semibold text-slate-500 transition hover:text-indigo-600"
          }
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
