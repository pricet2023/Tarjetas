import { useCallback, useEffect, useRef, useState } from "react";

import { cn } from "@/app/lib/utils";
import type { Card, Side } from "@/types/cards";

/** Horizontal distance (px) past which a release counts as a swipe. */
const COMMIT_PX = 110;
/** Distance at which the knew/didn't-know overlay reaches full opacity. */
const HINT_PX = 70;
/** A release moving at least this fast (px/ms) answers on a short flick. */
const FLICK_SPEED = 0.45;
/** ...as long as it travelled this far, so a tap can never become a swipe. */
const FLICK_MIN_PX = 24;
/** Window the release speed is measured over. */
const FLICK_WINDOW_MS = 90;
/** Past this the drag is a swipe, and a tap is off the table. */
const TAP_SLOP_PX = 6;
/** Must match LEAVE_TRANSITION. */
const LEAVE_MS = 260;
/** Sparks thrown when a swipe commits. */
const SPARKS = 16;
/**
 * Maximum lean towards the cursor. Deliberately small: a big tilt swings the
 * card out from under the pointer, which makes hover flicker at the edges.
 */
const TILT_DEG = 5;

/** Card geometry, shared by the live card and the ghost plates behind it. */
const CARD_BOX = "h-[22rem] w-full max-w-xl sm:h-[26rem] lg:h-[30rem]";
const IDLE_TRANSITION = "transform 220ms cubic-bezier(0.22, 1, 0.36, 1)";
/* Transform only: any opacity below 1 flattens the preserve-3d wrapper, which
   would drop the perspective off the flip mid-flight. The card clears the
   viewport regardless. */
const LEAVE_TRANSITION = `transform ${LEAVE_MS}ms cubic-bezier(0.4, 0, 0.7, 0.2)`;

interface FlashCardProps {
  card: Card;
  /**
   * Which side is face-up before the reveal. Pronunciation is a `Side` too,
   * but it is not a two-faced card — `PronounceCard` renders that one — so it
   * is excluded here rather than silently falling through to the ES→EN branch.
   */
  promptSide: Exclude<Side, "pronounce">;
  /** Never reviewed in this direction — shown as a corner tag. */
  isNew?: boolean;
  /** Already missed once this session — shown as a corner tag. */
  /** Called once the swipe-out animation has finished. */
  onSwipe(knew: boolean): void;
}

/** Where the gesture lives. Refs, not state — see the note on the component. */
interface Gesture {
  active: boolean;
  startX: number;
  dx: number;
  /** Set once the pointer has travelled past the tap slop. */
  moved: boolean;
  /** Recent positions, for the release speed. */
  samples: { x: number; t: number }[];
}

/**
 * A single study card: tap or press Space to flip it, drag (or arrow-key) left
 * for "didn't know" and right for "knew it".
 *
 * The drag is tracked with pointer events so mouse, touch and pen all take the
 * same path. Pointer capture keeps the gesture attached to the card even when
 * the finger leaves its bounds mid-drag.
 *
 * **The gesture is deliberately kept out of React state.** Offset, tilt and
 * highlight live in refs and are written to the DOM in one `requestAnimation-
 * Frame` per frame. Driving them through state meant a full re-render of the
 * card on every pointermove, and — worse — the release handler read a stale
 * offset from its render closure, so a fast flick would spring back instead of
 * answering. React state is only used for things that genuinely change the
 * tree: the flip, the reveal counter and the leaving animation.
 */
export function FlashCard({ card, promptSide, isNew, onSwipe }: FlashCardProps) {
  const [flipped, setFlipped] = useState(false);
  // Bumped on every reveal so the reveal animations replay.
  const [reveals, setReveals] = useState(0);
  // One-shot wrapper animations. `entering` runs on mount, `pulse` on reveal.
  const [entering, setEntering] = useState(true);
  const [pulse, setPulse] = useState(false);
  // Non-null while the card is animating off-screen; blocks further input.
  const [leaving, setLeaving] = useState<null | boolean>(null);

  const drag = useRef<HTMLDivElement>(null);
  const tiltLayer = useRef<HTMLDivElement>(null);
  const bloomYes = useRef<HTMLDivElement>(null);
  const bloomNo = useRef<HTMLDivElement>(null);
  const stampYes = useRef<HTMLDivElement>(null);
  const stampNo = useRef<HTMLDivElement>(null);
  const ghostNear = useRef<HTMLDivElement>(null);
  const ghostFar = useRef<HTMLDivElement>(null);

  const gesture = useRef<Gesture>({
    active: false,
    startX: 0,
    dx: 0,
    moved: false,
    samples: [],
  });
  const tilt = useRef({ x: 0, y: 0 });
  const spot = useRef({ x: 50, y: 50, lit: 0 });
  /** The card's box, measured once per gesture rather than on every move. */
  const box = useRef<DOMRect | null>(null);
  /** True only for a real hovering mouse; touch and pen never lean. */
  const leanable = useRef(false);
  const frame = useRef(0);
  // Mirrors `leaving` so the handlers don't need it in a closure.
  const gone = useRef<null | boolean>(null);

  /** Writes the whole gesture to the DOM. Runs at most once per frame. */
  const paint = useCallback(() => {
    frame.current = 0;
    const el = drag.current;
    if (!el) return;

    const { dx, active } = gesture.current;

    el.style.transform =
      `translate3d(${dx.toFixed(1)}px, ${(Math.abs(dx) * 0.05).toFixed(1)}px, 0)` +
      ` rotate(${(dx * 0.05).toFixed(2)}deg)` +
      ` scale(${active ? 1.03 : 1})`;

    // The lean is written to its own pointer-transparent layer, so it can't
    // change what hit-testing finds under the cursor.
    const lean = tilt.current;
    if (tiltLayer.current) {
      tiltLayer.current.style.transform =
        `rotateX(${lean.x.toFixed(2)}deg) rotateY(${lean.y.toFixed(2)}deg)`;
    }

    // The faces inherit these, so the specular highlight is one write.
    el.style.setProperty("--sx", `${spot.current.x.toFixed(1)}%`);
    el.style.setProperty("--sy", `${spot.current.y.toFixed(1)}%`);
    el.style.setProperty("--lit", spot.current.lit.toFixed(2));

    const hint = Math.min(Math.abs(dx) / HINT_PX, 1);
    const knew = dx > 0;
    setOpacity(bloomYes.current, knew ? hint * 0.9 : 0);
    setOpacity(bloomNo.current, knew ? 0 : hint * 0.9);
    setStamp(stampYes.current, knew ? hint : 0, -11);
    setStamp(stampNo.current, knew ? 0 : hint, 11);

    setGhost(ghostNear.current, dx, 1);
    setGhost(ghostFar.current, dx, 2);
  }, []);

  const schedule = useCallback(() => {
    if (!frame.current) frame.current = requestAnimationFrame(paint);
  }, [paint]);

  // Set the resting styles once, and stop any pending frame on unmount.
  useEffect(() => {
    const el = drag.current;
    if (el) el.style.transition = IDLE_TRANSITION;
    leanable.current = false;
    paint();
    return () => {
      if (frame.current) cancelAnimationFrame(frame.current);
    };
  }, [paint]);

  // A new card arrives face-down and centred.
  useEffect(() => {
    setFlipped(false);
    setReveals(0);
    setLeaving(null);
    gone.current = null;
    gesture.current = { active: false, startX: 0, dx: 0, moved: false, samples: [] };
    tilt.current = { x: 0, y: 0 };
    spot.current = { x: 50, y: 50, lit: 0 };
    schedule();
  }, [card.id, schedule]);

  const flip = useCallback(() => {
    setFlipped((f) => {
      if (!f) setReveals((n) => n + 1);
      return !f;
    });
    setEntering(false);
    setPulse(true);
    buzz(8);
  }, []);

  const commit = useCallback(
    (knew: boolean) => {
      if (gone.current !== null) return;
      gone.current = knew;
      gesture.current.active = false;
      setLeaving(knew);
      buzz(knew ? [12, 40, 18] : 30);

      const el = drag.current;
      if (el) {
        el.style.transition = LEAVE_TRANSITION;
        el.style.transform =
          `translate3d(${knew ? 130 : -130}vw, 6vh, 0)` +
          ` rotate(${knew ? 26 : -26}deg) scale(0.82)`;
      }
      // The verdict stays lit while the card flies out, including when the
      // answer came from the keyboard and was never dragged.
      setOpacity(knew ? bloomYes.current : bloomNo.current, 0.9);
      setStamp(knew ? stampYes.current : stampNo.current, 1, knew ? -11 : 11);

      // Matches the leave transition; the parent swaps in the next card only
      // once this one is out of sight.
      window.setTimeout(() => onSwipe(knew), LEAVE_MS);
    },
    [onSwipe],
  );

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (gone.current !== null) return;
    const el = e.currentTarget;
    // Optional: without capture the drag still works, it just stops tracking
    // if the pointer leaves the card.
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* not capturable — carry on */
    }

    box.current = el.getBoundingClientRect();
    gesture.current = {
      active: true,
      startX: e.clientX,
      dx: 0,
      moved: false,
      samples: [{ x: e.clientX, t: e.timeStamp }],
    };
    // No lean mid-drag: the swipe rotation should read on its own.
    tilt.current = { x: 0, y: 0 };
    el.style.transition = "none";
    schedule();
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (gone.current !== null) return;
    const g = gesture.current;

    if (g.active) {
      g.dx = e.clientX - g.startX;
      if (Math.abs(g.dx) > TAP_SLOP_PX) g.moved = true;
      g.samples.push({ x: e.clientX, t: e.timeStamp });
      if (g.samples.length > 8) g.samples.shift();
    } else if (spot.current.lit === 0 && !leanable.current) {
      // Nothing on screen depends on the pointer right now.
      return;
    }

    const rect = box.current ?? (box.current = e.currentTarget.getBoundingClientRect());
    const px = clamp((e.clientX - rect.left) / rect.width);
    const py = clamp((e.clientY - rect.top) / rect.height);
    spot.current = { x: px * 100, y: py * 100, lit: spot.current.lit };
    if (!g.active && leanable.current) {
      tilt.current = { x: (0.5 - py) * TILT_DEG * 1.2, y: (px - 0.5) * TILT_DEG * 2 };
    }
    schedule();
  };

  /** Shared by pointerup, pointercancel and losing capture. */
  const onPointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g.active || gone.current !== null) return;
    g.active = false;

    const el = e.currentTarget;
    // Releasing a pointer that was never captured — or was already released,
    // as on pointercancel — throws, and would abort the rest of this handler.
    if (el.hasPointerCapture(e.pointerId)) {
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        /* already gone */
      }
    }

    const { dx } = g;
    const speed = releaseSpeed(g.samples);
    const flicked =
      Math.abs(dx) >= FLICK_MIN_PX &&
      Math.abs(speed) >= FLICK_SPEED &&
      Math.sign(speed) === Math.sign(dx);

    if (Math.abs(dx) >= COMMIT_PX || flicked) {
      commit(dx > 0);
      return;
    }

    // Under the threshold: spring back, and treat a still finger as a tap.
    g.dx = 0;
    el.style.transition = IDLE_TRANSITION;
    schedule();
    if (!g.moved) flip();
  };

  // Desktop shortcuts. Space/Enter flips, arrows answer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (gone.current !== null) return;
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        flip();
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
  }, [commit, flip]);

  const front = promptSide === "english" ? card.english : card.spanish;
  const back = promptSide === "english" ? card.spanish : card.english;
  const frontLabel = promptSide === "english" ? "English" : "Español";
  const backLabel = promptSide === "english" ? "Español" : "English";
  const frontCode = promptSide === "english" ? "EN" : "ES";
  const backCode = promptSide === "english" ? "ES" : "EN";

  return (
    <div className="perspective relative flex w-full justify-center py-2 [perspective-origin:50%_40%]">
      {/* The rest of the deck, sitting under the live card. It leans the
          opposite way to the drag so the stack feels physical. */}
      <div ref={ghostFar} className={cn("card-ghost plate", CARD_BOX)} style={{ opacity: 0.23 }} />
      <div ref={ghostNear} className={cn("card-ghost plate", CARD_BOX)} style={{ opacity: 0.39 }} />

      {/* One-shot wrapper animations. Sits between the stage and the drag
          wrapper so they never fight the gesture's own transform. */}
      <div
        className={cn(
          "card-surface preserve-3d relative w-full max-w-xl select-none",
          entering ? "animate-cardIn" : pulse ? "animate-flipPulse" : undefined,
        )}
        // animationend bubbles, so a per-character reveal inside the card
        // would otherwise cut these short.
        onAnimationEnd={(e) => {
          if (e.target !== e.currentTarget) return;
          setEntering(false);
          setPulse(false);
        }}
      >
        <div
          ref={drag}
          role="button"
          tabIndex={0}
          aria-label={`Flash card: ${front}. Tap to reveal, swipe right if you knew it.`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
          onLostPointerCapture={onPointerEnd}
          onPointerEnter={(e) => {
            leanable.current = e.pointerType === "mouse" && canHover();
            box.current = e.currentTarget.getBoundingClientRect();
            spot.current = { ...spot.current, lit: 1 };
            schedule();
          }}
          onPointerLeave={() => {
            leanable.current = false;
            tilt.current = { x: 0, y: 0 };
            spot.current = { x: 50, y: 50, lit: 0 };
            schedule();
          }}
          className="card-drag preserve-3d relative touch-none outline-none"
        >
          {/* Verdict-tinted bloom under the card, brightening as you drag. */}
          <div
            ref={bloomNo}
            aria-hidden
            className="pointer-events-none absolute -inset-6 -z-10 rounded-[40px] bg-rose-400/40 blur-2xl"
            style={{ opacity: 0 }}
          />
          <div
            ref={bloomYes}
            aria-hidden
            className="pointer-events-none absolute -inset-6 -z-10 rounded-[40px] bg-neon-mint/40 blur-2xl"
            style={{ opacity: 0 }}
          />

          <div ref={tiltLayer} className="card-tilt preserve-3d">
            <div
              className={cn(
                "preserve-3d relative transition-transform duration-500 ease-metal",
                CARD_BOX,
                flipped && "rotate-y-180",
              )}
            >
              <CardFace
                label={frontLabel}
                code={frontCode}
                text={front}
                isNew={isNew}
                hintText="tap to reveal"
              />
              <CardFace
                label={backLabel}
                code={backCode}
                text={back}
                notes={card.notes}
                className="rotate-y-180"
                tone="answer"
                revealKey={reveals}
                hintText="swipe to answer"
              />
            </div>
          </div>

          {/* Swipe verdict overlays — they track the drag so the meaning of the
              gesture is visible before the finger lifts. */}
          <Verdict side="left" elRef={stampNo} />
          <Verdict side="right" elRef={stampYes} />
        </div>
      </div>

      {/* Commit effects: a spark burst from the card's centre and a flash down
          the edge of the screen it flew towards. */}
      {leaving !== null ? <Burst knew={leaving} /> : null}
      {leaving !== null ? (
        <div
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-y-0 w-24 animate-edgeFlash blur-2xl",
            leaving
              ? "right-0 bg-gradient-to-l from-neon-mint/60 to-transparent"
              : "left-0 bg-gradient-to-r from-rose-400/60 to-transparent",
          )}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ helpers */

const clamp = (n: number) => Math.min(Math.max(n, 0), 1);

const canHover = () =>
  typeof window !== "undefined" &&
  window.matchMedia("(hover: hover) and (pointer: fine)").matches;

const buzz = (ms: number | number[]) => {
  // Present on Android/Chrome only; a no-op everywhere else.
  if (typeof navigator !== "undefined" && "vibrate" in navigator) navigator.vibrate(ms);
};

const setOpacity = (el: HTMLElement | null, value: number) => {
  if (el) el.style.opacity = value.toFixed(3);
};

const setStamp = (el: HTMLElement | null, strength: number, deg: number) => {
  if (!el) return;
  el.style.opacity = strength.toFixed(3);
  el.style.transform =
    `translateZ(60px) rotate(${deg}deg) scale(${(0.82 + strength * 0.22).toFixed(3)})`;
};

const setGhost = (el: HTMLElement | null, dx: number, depth: number) => {
  if (!el) return;
  el.style.transform =
    `translateY(${depth * 12}px) translateX(${(-dx * 0.05 * depth).toFixed(1)}px)` +
    ` scale(${1 - depth * 0.045}) rotate(${(-dx * 0.008 * depth).toFixed(2)}deg)`;
};

/** A position sample taken during a drag. */
export interface DragSample {
  x: number;
  t: number;
}

/**
 * Speed of the last stretch of the drag, in px/ms. Measured over a window
 * rather than the final two events, which are noisy at high pointer rates.
 *
 * Exported for the unit test — it decides whether a short flick answers.
 */
export function releaseSpeed(samples: DragSample[]): number {
  if (samples.length < 2) return 0;
  const last = samples[samples.length - 1];
  // Walk back while the samples are still inside the window. Taking the first
  // one *outside* it instead would average a slow drag in with the flick that
  // ended it, and read as too slow to answer.
  let first = samples[samples.length - 2];
  for (let i = samples.length - 2; i >= 0; i--) {
    if (last.t - samples[i].t > FLICK_WINDOW_MS) break;
    first = samples[i];
  }
  const dt = last.t - first.t;
  return dt > 0 ? (last.x - first.x) / dt : 0;
}

/* ----------------------------------------------------------------- subviews */

function CardFace({
  label,
  code,
  text,
  notes,
  className,
  tone = "prompt",
  revealKey,
  hintText,
  isNew,
}: {
  label: string;
  /** Two-letter language code, used as the watermark. */
  code: string;
  text: string;
  notes?: string | null;
  className?: string;
  tone?: "prompt" | "answer";
  /** Bumped on every reveal so the answer's entrance replays. */
  revealKey?: number;
  hintText: string;
  isNew?: boolean;
}) {
  const answer = tone === "answer";
  return (
    <div
      className={cn(
        "backface-hidden plate plate-bright absolute inset-0 flex flex-col overflow-hidden rounded-[26px] p-5 sm:p-7",
        answer && "border-neon-cyan/25",
        className,
      )}
    >
      {/* Specular highlight; position and strength are inherited from the
          drag wrapper as custom properties. */}
      <div aria-hidden className="card-spot" />
      {/* Brushed-metal striping + accent wash on the answer side. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.07]"
        style={{
          background:
            "repeating-linear-gradient(102deg, rgba(255,255,255,0.5) 0 1px, transparent 1px 4px)",
        }}
      />
      {answer ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(90% 70% at 50% 0%, rgba(34,211,238,0.18), transparent 60%)," +
              "radial-gradient(70% 60% at 100% 100%, rgba(167,139,250,0.16), transparent 65%)",
          }}
        />
      ) : null}

      {/* Oversized language code, stencilled into the plate. */}
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 font-mono text-[7rem] font-bold leading-none tracking-tighter sm:text-[11rem]",
          answer ? "text-neon-cyan/[0.06]" : "text-white/[0.035]",
        )}
      >
        {code}
      </span>

      {/* Machined corner brackets. */}
      {(["left-4 top-4 border-l-2 border-t-2", "right-4 top-4 border-r-2 border-t-2", "left-4 bottom-4 border-b-2 border-l-2", "right-4 bottom-4 border-b-2 border-r-2"] as const).map(
        (pos) => (
          <span
            key={pos}
            aria-hidden
            className={cn(
              "pointer-events-none absolute h-4 w-4 rounded-[3px]",
              answer ? "border-neon-cyan/40" : "border-white/20",
              pos,
            )}
          />
        ),
      )}

      <header className="relative z-10 flex items-start justify-between gap-2">
        <span className={cn("label", answer && "text-neon-ice")}>{label}</span>
        <span className="flex gap-1.5">
          {isNew ? <span className="chip border-emerald-400/30 text-neon-mint">new</span> : null}
        </span>
      </header>

      <div className="relative z-10 flex flex-1 flex-col items-center justify-center gap-4 text-center">
        {answer ? (
          <>
            {/* Reveal effects, replayed on every flip to this side. */}
            <span
              key={`ring-${revealKey}`}
              aria-hidden
              className="pointer-events-none absolute h-40 w-40 animate-ringOut rounded-full border border-neon-cyan/60"
            />
            <span
              key={`sheen-${revealKey}`}
              aria-hidden
              className="sheen-run pointer-events-none absolute inset-0"
            />
            <StaggerText
              key={`text-${revealKey}`}
              text={text}
              className="text-balance break-words text-4xl font-bold leading-[1.05] tracking-tight sm:text-5xl"
            />
          </>
        ) : (
          <p className="chrome text-balance break-words text-4xl font-bold leading-[1.05] tracking-tight sm:text-5xl">
            {text}
          </p>
        )}

        {notes ? (
          <p
            key={`notes-${revealKey}`}
            className="well mt-1 max-w-[92%] animate-riseIn px-3 py-2 text-sm text-steel-300"
            style={{ animationDelay: "220ms" }}
          >
            {notes}
          </p>
        ) : null}
      </div>

      <footer className="relative z-10 flex items-center justify-between">
        <span className="label">{hintText}</span>
        <span aria-hidden className="flex gap-1">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className={cn("h-1 w-1 rounded-full", answer ? "bg-neon-cyan/70" : "bg-white/25")}
            />
          ))}
        </span>
      </footer>
    </div>
  );
}

/**
 * Reveals text one character at a time; the string stays readable to AT.
 *
 * Each character carries the chrome gradient itself rather than inheriting a
 * clip from the wrapper: the per-character transform puts the glyphs in their
 * own paint layers, where an ancestor's `background-clip: text` can't reach
 * them. The gradient is vertical, so nothing about the look changes.
 */
function StaggerText({ text, className }: { text: string; className?: string }) {
  const words = text.split(" ");
  let index = 0;
  return (
    <span className={className}>
      <span className="sr-only">{text}</span>
      <span aria-hidden>
        {words.map((word, wi) => (
          <span key={wi}>
            <span className="inline-block whitespace-nowrap">
              {[...word].map((char, ci) => (
                <span
                  key={ci}
                  className="chrome inline-block animate-charIn"
                  style={{ animationDelay: `${index++ * 26}ms` }}
                >
                  {char}
                </span>
              ))}
            </span>
            {wi < words.length - 1 ? " " : null}
          </span>
        ))}
      </span>
    </span>
  );
}

/** Drag verdict stamp. Opacity and scale are written by `paint`. */
function Verdict({
  side,
  elRef,
}: {
  side: "left" | "right";
  elRef: React.Ref<HTMLDivElement>;
}) {
  const knew = side === "right";
  return (
    <div
      ref={elRef}
      aria-hidden
      className={cn(
        "pointer-events-none absolute top-10 rounded-2xl border-2 px-4 py-2 font-mono text-xl font-bold uppercase tracking-[0.18em] backdrop-blur-sm",
        knew
          ? "right-6 border-neon-mint text-neon-mint shadow-mint"
          : "left-6 border-rose-400 text-rose-400 shadow-rose",
      )}
      style={{
        opacity: 0,
        transform: `translateZ(60px) rotate(${knew ? -11 : 11}deg) scale(0.82)`,
      }}
    >
      {knew ? "Knew it" : "Nope"}
    </div>
  );
}

/** Radial spark burst thrown from the card's centre when a swipe commits. */
function Burst({ knew }: { knew: boolean }) {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 z-20">
      <div className="absolute left-1/2 top-1/2 h-0 w-0">
        {Array.from({ length: SPARKS }, (_, i) => (
          <span
            key={i}
            className={cn("spark", knew ? "bg-neon-mint text-neon-mint" : "bg-rose-400 text-rose-400")}
            style={{
              // Fanned out towards the side the card left by, not a full circle.
              ["--a" as string]: `${(knew ? -55 : 125) + (i / (SPARKS - 1)) * 110}deg`,
              ["--d" as string]: `${90 + (i % 4) * 46}px`,
              animationDelay: `${i * 12}ms`,
              boxShadow: "0 0 12px currentColor",
            }}
          />
        ))}
      </div>
    </div>
  );
}
