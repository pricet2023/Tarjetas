import { Activity, Gauge, RotateCcw, Target, Timer, Zap } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { getStudyDeck, recordReview } from "@/api/cards";
import { advance } from "@/app/lib/session-queue";
import { type Attempt, usePronunciation } from "@/app/lib/pronounce/usePronunciation";
import { cn } from "@/app/lib/utils";
import { FlashCard } from "@/components/FlashCard";
import { PronounceCard } from "@/components/PronounceCard";
import type { PhoneScore } from "@/app/lib/phonology/gop";
import type { DeckEntry, PhoneScoreRow, Side } from "@/types/cards";

const DECK_SIZE = 20;

/** Which directions to draw from. */
type Direction = "english" | "spanish" | "mixed" | "pronounce";

const SIDES: Record<Direction, Side[]> = {
  english: ["english"],
  spanish: ["spanish"],
  mixed: ["english", "spanish"],
  // Its own deck rather than a fourth competitor for a slot: `study_deck`
  // deals one direction per card, so letting 'pronounce' into the mixed pool
  // would quietly replace translation prompts with pronunciation ones. See
  // the header of migration 013.
  pronounce: ["pronounce"],
};

/**
 * How many of a deck's slots are reserved for unseen cards.
 *
 * Since 016 this is a reservation rather than a cap on a shared pool: the new
 * cards get these slots outright instead of losing them to overdue cards in
 * the race. Half a deck, so the 3,479-card seeded portfolio is reachable in a
 * few hundred sessions rather than seven hundred, while leaving half for
 * review. Raise it to see more of the deck, lower it to drill what you have.
 *
 * In pronunciation mode nothing is new *material*: the words are ones you are
 * already learning and only the direction has never been asked, so every card
 * reads as unseen and reserving half the deck would halve it.
 */
const newLimitFor = (direction: Direction): number =>
  direction === "pronounce" ? DECK_SIZE : DECK_SIZE / 2;

const keyOf = (e: DeckEntry) => `${e.card.id}:${e.promptSide}`;

export function Study() {
  const [queue, setQueue] = useState<DeckEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [direction, setDirection] = useState<Direction>("mixed");
  const [dealt, setDealt] = useState(0);
  // Every card is a first attempt: since 016 a card is asked once per session
  // and the queue only ever shrinks, so there is no retry to discount.
  const [score, setScore] = useState({ knew: 0, total: 0 });
  // Counts card presentations, not cards, and is folded into the card's key so
  // that <FlashCard> is remounted on every answer rather than keeping its
  // mid-swipe state.
  const [turn, setTurn] = useState(0);
  // Longest and current run of correct first attempts, for the HUD.
  const [streak, setStreak] = useState({ current: 0, best: 0 });
  // Last response time, shown so the pace of the session is visible.
  const [lastMs, setLastMs] = useState<number | null>(null);
  // When the current card was put on screen, for response_ms.
  const shownAt = useRef(Date.now());
  // Mounted for the whole page, armed only on entering pronunciation mode:
  // the weights are a 197 MB download and must not be fetched because someone
  // opened the study screen. Kept across cards so the worker and the open
  // microphone survive from one attempt to the next.
  const pronunciation = usePronunciation();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const deck = await getStudyDeck({
        deckSize: DECK_SIZE,
        newLimit: newLimitFor(direction),
        sides: SIDES[direction],
      });
      setQueue(deck);
      setDealt(deck.length);
      setScore({ knew: 0, total: 0 });
      setTurn(0);
      setStreak({ current: 0, best: 0 });
      setLastMs(null);
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

  const answer = (knew: boolean, attempt: Attempt | null = null) => {
    if (!current) return;
    const responseMs = Date.now() - shownAt.current;

    setLastMs(responseMs);
    setScore((s) => ({ knew: s.knew + (knew ? 1 : 0), total: s.total + 1 }));
    setStreak((s) => {
      const next = knew ? s.current + 1 : 0;
      return { current: next, best: Math.max(s.best, next) };
    });

    setQueue((q) => advance(q));
    setTurn((t) => t + 1);
    pronunciation.reset();

    // Fire-and-forget: the next card shouldn't wait on the write.
    void recordReview(
      current.card.id,
      knew,
      current.promptSide,
      responseMs,
      attempt ? { score: attempt.score, phones: attempt.phones.map(toPhoneScoreRow) } : undefined,
    ).catch((err) => {
      setError(err instanceof Error ? err.message : "Failed to save review");
    });
  };

  if (loading) return <DealingDeck />;

  if (error && dealt === 0) {
    return (
      <div className="plate rim mx-auto max-w-md p-8 text-center">
        <p role="alert" className="font-medium text-rose-400">
          {error}
        </p>
      </div>
    );
  }

  if (dealt === 0) {
    return (
      <div className="plate rim sheen mx-auto max-w-md overflow-hidden p-10 text-center">
        <Zap className="mx-auto mb-4 h-8 w-8 animate-pulseGlow text-neon-cyan" />
        <p className="chrome mb-1 text-2xl font-bold tracking-tight">Deck empty</p>
        <p className="mb-6 text-sm text-steel-400">
          Nothing to drill yet — add a card and the scheduler will do the rest.
        </p>
        <Link to="/cards" className="btn btn-primary sheen">
          Add your first card
        </Link>
      </div>
    );
  }

  const accuracy = score.total ? score.knew / score.total : 0;
  const answered = Math.max(dealt - queue.length, 0);

  if (!current) return <Summary score={score} streak={streak} dealt={dealt} onAgain={() => void load()} />;

  return (
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_19rem]">
      <section className="flex min-w-0 flex-col gap-4 lg:min-h-[calc(100dvh-12.5rem)]">
        {/* Deck rail: what's left, how far in, and which way round. */}
        <div className="plate rim flex flex-wrap items-center justify-between gap-4 p-4">
          <div className="flex items-baseline gap-2">
            <span className="chrome-cyan font-mono text-3xl font-bold leading-none">
              {String(queue.length).padStart(2, "0")}
            </span>
            <span className="label">left in deck</span>
          </div>
          <DirectionPicker value={direction} onChange={setDirection} />
          <div className="w-full">
            <ProgressRail total={dealt} done={answered} />
          </div>
        </div>

        <div className="flex flex-1 items-center justify-center">
          {/* Branching on the entry's own side rather than on `direction`
              narrows the type: `FlashCard` does not accept a pronunciation
              prompt, and this is what makes that a compile-time fact. */}
          {current.promptSide === "pronounce" ? (
            <PronounceCard
              key={`${keyOf(current)}:${turn}`}
              card={current.card}
              isNew={current.isNew}
              pronunciation={pronunciation}
              onAnswer={answer}
            />
          ) : (
            <FlashCard
              key={`${keyOf(current)}:${turn}`}
              card={current.card}
              promptSide={current.promptSide}
              isNew={current.isNew}
              onSwipe={answer}
            />
          )}
        </div>

        {/* Shortcut legend — doubles as the gesture hint. */}
        <div className="plate flex flex-wrap items-center justify-center gap-x-5 gap-y-2 p-3 text-xs text-steel-400">
          {current.promptSide === "pronounce" ? (
            <>
              <span className="flex items-center gap-2">
                <span className="keycap">space</span> hold to speak
              </span>
              <span className="hidden items-center gap-2 sm:flex">
                <span className="keycap">hold</span> the mic and say it out loud
              </span>
            </>
          ) : (
            <>
              <span className="flex items-center gap-2">
                <span className="keycap">space</span> reveal
              </span>
              <span className="flex items-center gap-2">
                <span className="keycap">←</span>
                <span className="font-semibold text-rose-400">didn&rsquo;t know</span>
              </span>
              <span className="flex items-center gap-2">
                <span className="keycap">→</span>
                <span className="font-semibold text-neon-mint">knew it</span>
              </span>
              <span className="hidden items-center gap-2 sm:flex">
                <span className="keycap">drag</span> to answer
              </span>
            </>
          )}
        </div>

        {error ? (
          <p
            role="alert"
            className="animate-riseIn rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm font-medium text-rose-300"
          >
            {error}
          </p>
        ) : null}
      </section>

      <aside className="grid gap-4 self-start sm:grid-cols-2 lg:sticky lg:top-24 lg:grid-cols-1">
        <div className="plate rim p-4">
          <h2 className="label mb-3">session</h2>
          <div className="flex items-center gap-4">
            <AccuracyRing value={accuracy} />
            <div className="min-w-0 flex-1 space-y-2">
              <Metric
                icon={<Target className="h-3.5 w-3.5" />}
                label="first-try"
                value={`${score.knew}/${score.total}`}
              />
              <Metric
                icon={<Activity className="h-3.5 w-3.5" />}
                label="streak"
                value={`${streak.current}${streak.best > streak.current ? ` · ${streak.best} best` : ""}`}
              />
              <Metric
                icon={<Timer className="h-3.5 w-3.5" />}
                label="last"
                value={lastMs === null ? "—" : `${(lastMs / 1000).toFixed(1)}s`}
              />
            </div>
          </div>
        </div>

        <CardIntel entry={current} />
        <NextUp entries={queue.slice(1, 5)} className="sm:col-span-2 lg:col-span-1" />
      </aside>
    </div>
  );
}

/**
 * The next few prompts, so the deck doesn't feel like a black box. Only the
 * prompt side is shown — the answers stay hidden.
 */
function NextUp({ entries, className }: { entries: DeckEntry[]; className?: string }) {
  if (entries.length === 0) return null;
  return (
    <div className={cn("plate rim p-4", className)}>
      <h2 className="label mb-3">up next</h2>
      <ol className="space-y-2">
        {entries.map((entry, i) => (
          <li
            key={`${keyOf(entry)}:${i}`}
            className="well flex animate-riseIn items-center gap-2 px-2.5 py-2"
            style={{ animationDelay: `${i * 70}ms`, opacity: 1 - i * 0.16 }}
          >
            <span className="font-mono text-[10px] text-steel-600">{i + 2}</span>
            <span className="min-w-0 flex-1 truncate text-xs text-steel-300">
              {entry.promptSide === "spanish" ? entry.card.spanish : entry.card.english}
            </span>
            <span className="label shrink-0 text-neon-ice/70">
              {entry.promptSide === "spanish" ? "es" : entry.promptSide === "english" ? "en" : "say"}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Lifetime and scheduler detail for the card on screen. */
function CardIntel({ entry }: { entry: DeckEntry }) {
  const { card, promptSide, weight, isNew } = entry;
  const mastery = card.timesSeen ? card.timesKnown / card.timesSeen : 0;

  return (
    <div className="plate rim p-4">
      <h2 className="label mb-3">card intel</h2>

      <div className="mb-3 flex flex-wrap gap-1.5">
        <span className="chip border-neon-cyan/30 text-neon-ice">{sideLabel(promptSide)}</span>
        {isNew ? <span className="chip border-emerald-400/30 text-neon-mint">new</span> : null}
      </div>

      <div className="space-y-3">
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="label">lifetime</span>
            <span className="font-mono text-xs text-steel-300">
              {card.timesKnown}/{card.timesSeen}
            </span>
          </div>
          <Bar value={mastery} />
        </div>
        <Metric
          icon={<Gauge className="h-3.5 w-3.5" />}
          label="weight"
          value={weight.toFixed(2)}
        />
        <Metric
          icon={<Timer className="h-3.5 w-3.5" />}
          label="last seen"
          value={card.lastSeenAt ? sinceLabel(card.lastSeenAt) : "never"}
        />
      </div>
    </div>
  );
}

function Metric({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="flex items-center gap-1.5 text-steel-500">
        {icon}
        <span className="label">{label}</span>
      </span>
      <span
        key={value}
        className="animate-countPop truncate font-mono text-xs font-medium text-steel-100"
      >
        {value}
      </span>
    </div>
  );
}

/** A thin lit meter. */
function Bar({ value }: { value: number }) {
  return (
    <div className="well h-2 overflow-hidden rounded-full">
      <div
        className="h-full rounded-full bg-gradient-to-r from-neon-cyan via-neon-ice to-neon-violet shadow-cyan transition-[width] duration-700 ease-metal"
        style={{ width: `${Math.round(value * 100)}%` }}
      />
    </div>
  );
}

/** One segment per dealt card, lit as the deck is cleared. */
function ProgressRail({ total, done }: { total: number; done: number }) {
  return (
    <div className="flex items-center gap-1">
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          className={cn(
            "h-1.5 flex-1 rounded-full transition-all duration-500 ease-metal",
            i < done
              ? "bg-gradient-to-r from-neon-cyan to-neon-ice shadow-cyan"
              : i === done
                ? "animate-pulseGlow bg-neon-ice"
                : "bg-white/10",
          )}
        />
      ))}
    </div>
  );
}

function AccuracyRing({ value }: { value: number }) {
  const r = 34;
  const c = 2 * Math.PI * r;
  return (
    <div className="relative h-24 w-24 shrink-0">
      <svg viewBox="0 0 80 80" className="h-full w-full -rotate-90">
        <defs>
          <linearGradient id="ring" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#7dd3fc" />
            <stop offset="55%" stopColor="#22d3ee" />
            <stop offset="100%" stopColor="#a78bfa" />
          </linearGradient>
        </defs>
        <circle cx="40" cy="40" r={r} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="6" />
        <circle
          cx="40"
          cy="40"
          r={r}
          fill="none"
          stroke="url(#ring)"
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - value)}
          style={{
            transition: "stroke-dashoffset 700ms cubic-bezier(0.22, 1, 0.36, 1)",
            filter: "drop-shadow(0 0 6px rgba(34,211,238,0.7))",
          }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span key={Math.round(value * 100)} className="chrome animate-countPop font-mono text-xl font-bold">
          {Math.round(value * 100)}
        </span>
        <span className="label">percent</span>
      </div>
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
    { value: "pronounce", label: "Say it" },
  ];
  const index = options.findIndex((o) => o.value === value);

  return (
    <div className="well relative flex p-1">
      {/* The lit slug slides between the options. */}
      <span
        aria-hidden
        className="absolute inset-y-1 rounded-lg bg-gradient-to-b from-neon-ice to-cyan-600 shadow-cyan transition-transform duration-300 ease-snap"
        style={{
          width: `calc((100% - 0.5rem) / ${options.length})`,
          transform: `translateX(calc(${index} * 100%))`,
          left: "0.25rem",
        }}
      />
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "relative z-10 rounded-lg px-3 py-1 font-mono text-[11px] font-semibold uppercase tracking-wider transition-colors duration-200",
            value === o.value ? "text-ink-950" : "text-steel-400 hover:text-steel-100",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Skeleton shown while `study_deck` picks the cards. */
function DealingDeck() {
  return (
    <div className="mx-auto grid max-w-lg gap-4 py-6">
      <div className="plate h-14 overflow-hidden">
        <div className="shimmer-band h-full w-full animate-shimmer opacity-40" />
      </div>
      <div className="plate relative h-[22rem] overflow-hidden rounded-[26px] sm:h-[26rem] lg:h-[30rem]">
        <div className="shimmer-band absolute inset-0 animate-shimmer opacity-30" />
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
          <div className="relative h-12 w-12">
            <div className="absolute inset-0 animate-spinFast rounded-full border-2 border-neon-cyan/25 border-t-neon-cyan" />
          </div>
          <p className="label animate-ticker">dealing deck</p>
        </div>
      </div>
    </div>
  );
}

function Summary({
  score,
  streak,
  dealt,
  onAgain,
}: {
  score: { knew: number; total: number };
  streak: { current: number; best: number };
  dealt: number;
  onAgain(): void;
}) {
  const accuracy = score.total ? score.knew / score.total : 0;
  return (
    <div className="mx-auto max-w-xl">
      <div className="plate rim sheen relative overflow-hidden p-8 text-center">
        <p className="label mb-6">deck cleared</p>

        <div className="relative mx-auto mb-6 w-fit">
          <div className="absolute -inset-8 -z-10 animate-pulseGlow rounded-full bg-neon-cyan/20 blur-3xl" />
          <p className="chrome font-mono text-7xl font-bold leading-none tracking-tight">
            {score.knew}
            <span className="text-steel-600">/{score.total}</span>
          </p>
        </div>

        <div className="mb-7 grid grid-cols-3 gap-3">
          <SummaryTile label="accuracy" value={`${Math.round(accuracy * 100)}%`} />
          <SummaryTile label="best run" value={String(streak.best)} />
          <SummaryTile label="dealt" value={String(dealt)} />
        </div>

        <p className="mb-6 text-sm text-steel-400">Scored on first attempt only.</p>

        <button onClick={onAgain} className="btn btn-primary sheen">
          <RotateCcw className="h-4 w-4" />
          Deal another deck
        </button>
      </div>
    </div>
  );
}

function SummaryTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="well animate-riseIn px-3 py-3">
      <p className="chrome-cyan font-mono text-xl font-bold">{value}</p>
      <p className="label mt-1">{label}</p>
    </div>
  );
}

/** How the direction reads in the HUD. */
function sideLabel(side: Side): string {
  if (side === "english") return "en → es";
  if (side === "spanish") return "es → en";
  return "en → say it";
}

/**
 * camelCase to snake_case at the api boundary, per CLAUDE.md — the shape the
 * `card_reviews.phone_scores` column and migration 013's trigger expect.
 *
 * `gop` is coerced through `Number.isFinite` because a phone with no rival
 * anywhere in the model's inventory scores -Infinity, which `JSON.stringify`
 * writes as `null`. Making that explicit here means the trigger's `is not
 * null` filter is a documented contract rather than an accident of JSON.
 */
function toPhoneScoreRow(score: PhoneScore): PhoneScoreRow {
  return {
    phone: score.phone,
    start: score.start,
    end: score.end,
    gop: Number.isFinite(score.gop) ? score.gop : null,
    rival: score.rival,
    rival_label: score.rivalLabel,
    z: score.z !== null && Number.isFinite(score.z) ? score.z : null,
    calibrated: score.calibrated,
    verdict: score.verdict,
  };
}

/** Coarse "how long ago" label — the exact minute never matters here. */
function sinceLabel(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
