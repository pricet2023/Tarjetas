import { Loader2, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { getStudyDeck, recordReview } from "@/api/cards";
import { advance } from "@/app/lib/session-queue";
import { FlashCard } from "@/components/FlashCard";
import type { DeckEntry, Side } from "@/types/cards";

const DECK_SIZE = 20;

/** Which directions to draw from. */
type Direction = "english" | "spanish" | "mixed";

const SIDES: Record<Direction, Side[]> = {
  english: ["english"],
  spanish: ["spanish"],
  mixed: ["english", "spanish"],
};

const keyOf = (e: DeckEntry) => `${e.card.id}:${e.promptSide}`;

export function Study() {
  const [queue, setQueue] = useState<DeckEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [direction, setDirection] = useState<Direction>("mixed");
  const [dealt, setDealt] = useState(0);
  // Scored on first attempt only: a card you fail then get right on the
  // requeue counts as one miss, not one miss and one hit.
  const [score, setScore] = useState({ knew: 0, total: 0 });
  const attempted = useRef(new Set<string>());
  // Counts card presentations, not cards. Failing the last card in the queue
  // requeues it to position 0, so the card identity alone doesn't change and
  // <FlashCard> would keep its mid-swipe state instead of resetting. Folding
  // this into its key guarantees a fresh card on every answer.
  const [turn, setTurn] = useState(0);
  // When the current card was put on screen, for response_ms.
  const shownAt = useRef(Date.now());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const deck = await getStudyDeck({ deckSize: DECK_SIZE, sides: SIDES[direction] });
      setQueue(deck);
      setDealt(deck.length);
      setScore({ knew: 0, total: 0 });
      attempted.current = new Set();
      setTurn(0);
      shownAt.current = Date.now();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to build deck");
    } finally {
      setLoading(false);
    }
  }, [direction]);

  useEffect(() => {
    void load();
  }, [load]);

  const current = queue[0];

  // Restart the clock whenever a card reaches the front.
  useEffect(() => {
    shownAt.current = Date.now();
  }, [turn, loading]);

  const handleSwipe = (knew: boolean) => {
    if (!current) return;
    const responseMs = Date.now() - shownAt.current;
    const key = keyOf(current);

    if (!attempted.current.has(key)) {
      attempted.current.add(key);
      setScore((s) => ({ knew: s.knew + (knew ? 1 : 0), total: s.total + 1 }));
    }

    setQueue((q) => advance(q, knew));
    setTurn((t) => t + 1);

    // Fire-and-forget: the next card shouldn't wait on the write.
    void recordReview(current.card.id, knew, current.promptSide, responseMs).catch((err) => {
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

  if (error && dealt === 0) {
    return <p role="alert" className="py-12 text-center text-rose-600">{error}</p>;
  }

  if (dealt === 0) {
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
        <p className="mb-6 mt-2 text-slate-500">
          Deck finished — scored on first attempt.
        </p>
        <button
          onClick={() => void load()}
          className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 font-semibold text-white transition hover:bg-indigo-700"
        >
          <RotateCcw className="h-4 w-4" />
          Deal another deck
        </button>
      </div>
    );
  }

  const retry = attempted.current.has(keyOf(current));

  return (
    <div className="flex flex-col items-center gap-5">
      <div className="flex w-full max-w-sm items-center justify-between text-sm">
        <span className="font-semibold text-slate-500">{queue.length} left</span>
        <DirectionPicker value={direction} onChange={setDirection} />
      </div>

      <div className="flex h-5 items-center gap-2 text-xs font-semibold">
        {current.isNew ? (
          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-emerald-700">New</span>
        ) : null}
        {retry ? (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-amber-700">Retry</span>
        ) : null}
        <span className="text-slate-400">
          {current.promptSide === "english" ? "EN → ES" : "ES → EN"}
        </span>
      </div>

      <FlashCard
        key={`${keyOf(current)}:${turn}`}
        card={current.card}
        promptSide={current.promptSide}
        onSwipe={handleSwipe}
      />

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
