import { useCallback, useEffect, useRef, useState } from "react";

import { cn } from "@/app/lib/utils";
import type { Card, Side } from "@/types/cards";

/** Horizontal distance (px) past which a release counts as a swipe. */
const COMMIT_PX = 110;
/** Distance at which the knew/didn't-know overlay reaches full opacity. */
const HINT_PX = 70;

interface FlashCardProps {
  card: Card;
  /** Which side is face-up before the reveal. */
  promptSide: Side;
  /** Called once the swipe-out animation has finished. */
  onSwipe(knew: boolean): void;
}

/**
 * A single study card: tap or press Space to flip it, drag (or arrow-key) left
 * for "didn't know" and right for "knew it".
 *
 * The drag is tracked with pointer events so mouse, touch and pen all take the
 * same path. Pointer capture keeps the gesture attached to the card even when
 * the finger leaves its bounds mid-drag.
 */
export function FlashCard({ card, promptSide, onSwipe }: FlashCardProps) {
  const [flipped, setFlipped] = useState(false);
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  // Non-null while the card is animating off-screen; blocks further input.
  const [leaving, setLeaving] = useState<null | boolean>(null);

  const startX = useRef(0);
  // A drag that ends near where it began is a tap, not a swipe.
  const moved = useRef(false);

  // A new card arrives face-down and centred.
  useEffect(() => {
    setFlipped(false);
    setDx(0);
    setLeaving(null);
  }, [card.id]);

  const commit = useCallback(
    (knew: boolean) => {
      if (leaving !== null) return;
      setDragging(false);
      setLeaving(knew);
      setDx(knew ? window.innerWidth : -window.innerWidth);
      // Matches the 260ms transition below; the parent swaps in the next card
      // only once this one is out of sight.
      window.setTimeout(() => onSwipe(knew), 260);
    },
    [leaving, onSwipe],
  );

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (leaving !== null) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    startX.current = e.clientX;
    moved.current = false;
    setDragging(true);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging || leaving !== null) return;
    const next = e.clientX - startX.current;
    if (Math.abs(next) > 6) moved.current = true;
    setDx(next);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging || leaving !== null) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    setDragging(false);

    if (Math.abs(dx) >= COMMIT_PX) {
      commit(dx > 0);
      return;
    }
    // Under the threshold: spring back, and treat a still finger as a tap.
    setDx(0);
    if (!moved.current) setFlipped((f) => !f);
  };

  // Desktop shortcuts. Space/Enter flips, arrows answer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (leaving !== null) return;
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        setFlipped((f) => !f);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        commit(true);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        commit(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [commit, leaving]);

  const front = promptSide === "english" ? card.english : card.spanish;
  const back = promptSide === "english" ? card.spanish : card.english;
  const frontLabel = promptSide === "english" ? "English" : "Español";
  const backLabel = promptSide === "english" ? "Español" : "English";

  const hint = Math.min(Math.abs(dx) / HINT_PX, 1);

  return (
    <div className="perspective relative w-full max-w-sm select-none">
      <div
        role="button"
        tabIndex={0}
        aria-label={`Flash card: ${front}. Tap to reveal, swipe right if you knew it.`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className="relative touch-none"
        style={{
          transform: `translateX(${dx}px) rotate(${dx * 0.045}deg)`,
          transition: dragging ? "none" : "transform 260ms ease-out",
          opacity: leaving !== null ? 0 : 1,
        }}
      >
        <div
          className={cn(
            "preserve-3d relative h-72 w-full transition-transform duration-300 sm:h-80",
            flipped && "rotate-y-180",
          )}
        >
          <CardFace label={frontLabel} text={front} />
          <CardFace
            label={backLabel}
            text={back}
            notes={card.notes}
            className="rotate-y-180"
            tone="answer"
          />
        </div>

        {/* Swipe verdict overlays — they track the drag so the meaning of the
            gesture is visible before the finger lifts. */}
        <Verdict side="left" opacity={dx < 0 ? hint : 0} />
        <Verdict side="right" opacity={dx > 0 ? hint : 0} />
      </div>
    </div>
  );
}

function CardFace({
  label,
  text,
  notes,
  className,
  tone = "prompt",
}: {
  label: string;
  text: string;
  notes?: string | null;
  className?: string;
  tone?: "prompt" | "answer";
}) {
  return (
    <div
      className={cn(
        "backface-hidden absolute inset-0 flex flex-col items-center justify-center gap-3 rounded-3xl border p-6 text-center shadow-lg",
        tone === "prompt"
          ? "border-slate-200 bg-white"
          : "border-indigo-200 bg-indigo-50",
        className,
      )}
    >
      <span className="text-xs font-semibold uppercase tracking-widest text-slate-400">
        {label}
      </span>
      <p className="text-balance text-3xl font-semibold leading-tight sm:text-4xl">
        {text}
      </p>
      {notes ? <p className="text-sm text-slate-500">{notes}</p> : null}
    </div>
  );
}

function Verdict({ side, opacity }: { side: "left" | "right"; opacity: number }) {
  const knew = side === "right";
  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none absolute top-8 rounded-xl border-4 px-4 py-2 text-xl font-black uppercase tracking-wider",
        knew
          ? "right-6 -rotate-12 border-emerald-500 text-emerald-500"
          : "left-6 rotate-12 border-rose-500 text-rose-500",
      )}
      style={{ opacity }}
    >
      {knew ? "Knew it" : "Nope"}
    </div>
  );
}
