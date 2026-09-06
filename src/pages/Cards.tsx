import { Boxes, Layers, Pencil, Plus, Search, Sparkles, Trash2, TrendingUp } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { createCard, deleteCard, listCards, updateCard } from "@/api/cards";
import { cn } from "@/app/lib/utils";
import { CardForm } from "@/components/CardForm";
import type { Card } from "@/types/cards";

/** How long the tile spends collapsing before it leaves the list. */
const EXIT_MS = 200;
/** Reviews needed before a high hit-rate counts as mastered rather than luck. */
const MASTERY_MIN_SEEN = 3;

type Bucket = "unseen" | "learning" | "mastered";
type Filter = "all" | Bucket;

const mastery = (card: Card) => (card.timesSeen ? card.timesKnown / card.timesSeen : 0);

const bucketOf = (card: Card): Bucket => {
  if (card.timesSeen === 0) return "unseen";
  return card.timesSeen >= MASTERY_MIN_SEEN && mastery(card) >= 0.8 ? "mastered" : "learning";
};

export function Cards() {
  const [cards, setCards] = useState<Card[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Card | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  // Tile currently playing its exit animation.
  const [removing, setRemoving] = useState<string | null>(null);
  // Deletes the server rejected, so the pending exit can be called off.
  const cancelled = useRef(new Set<string>());

  const refresh = useCallback(async () => {
    try {
      setCards(await listCards());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load cards");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const remove = (card: Card) => {
    // The deck is shared, so a delete is a delete for both of us.
    if (!window.confirm(`Delete "${card.english}"? It leaves the deck for both of you.`))
      return;
    const previous = cards;
    setRemoving(card.id);

    // Optimistic: the tile collapses straight away and only leaves the list
    // once the animation has run. If the delete is rejected the row is put
    // back, and the pending exit is cancelled so it can't re-remove it.
    void deleteCard(card.id).catch((err) => {
      cancelled.current.add(card.id);
      setCards(previous);
      setRemoving(null);
      setError(err instanceof Error ? err.message : "Failed to delete card");
    });

    window.setTimeout(() => {
      if (cancelled.current.delete(card.id)) return;
      setCards((c) => c.filter((x) => x.id !== card.id));
      setRemoving((r) => (r === card.id ? null : r));
    }, EXIT_MS);
  };

  const stats = useMemo(() => {
    const counts = { unseen: 0, learning: 0, mastered: 0 };
    for (const card of cards) counts[bucketOf(card)] += 1;
    const seen = cards.filter((c) => c.timesSeen > 0);
    const rate = seen.length
      ? seen.reduce((sum, c) => sum + mastery(c), 0) / seen.length
      : 0;
    return { ...counts, total: cards.length, rate };
  }, [cards]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return cards.filter((card) => {
      if (filter !== "all" && bucketOf(card) !== filter) return false;
      if (!needle) return true;
      return (
        card.english.toLowerCase().includes(needle) ||
        card.spanish.toLowerCase().includes(needle) ||
        (card.notes ?? "").toLowerCase().includes(needle)
      );
    });
  }, [cards, query, filter]);

  if (loading) return <VaultSkeleton />;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="chrome text-2xl font-bold uppercase tracking-[0.14em]">Card vault</h2>
          <p className="label mt-1.5">{stats.total} entries · scheduled by weight</p>
        </div>
        {!adding && !editing ? (
          <button onClick={() => setAdding(true)} className="btn btn-primary sheen">
            <Plus className="h-4 w-4" />
            Add card
          </button>
        ) : null}
      </div>

      {/* Vault readout — four tiles so the header carries some weight. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile
          icon={<Boxes className="h-4 w-4" />}
          label="total"
          value={stats.total}
          fraction={1}
          tone="ice"
        />
        <StatTile
          icon={<TrendingUp className="h-4 w-4" />}
          label="mastered"
          value={stats.mastered}
          fraction={stats.total ? stats.mastered / stats.total : 0}
          tone="mint"
        />
        <StatTile
          icon={<Layers className="h-4 w-4" />}
          label="learning"
          value={stats.learning}
          fraction={stats.total ? stats.learning / stats.total : 0}
          tone="violet"
        />
        <StatTile
          icon={<Sparkles className="h-4 w-4" />}
          label="unseen"
          value={stats.unseen}
          fraction={stats.total ? stats.unseen / stats.total : 0}
          tone="amber"
        />
      </div>

      {error ? (
        <p
          role="alert"
          className="animate-riseIn rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm font-medium text-rose-300"
        >
          {error}
        </p>
      ) : null}

      {adding ? (
        <FormPanel title="New card" onClose={() => setAdding(false)}>
          <CardForm
            onSubmit={async (input) => {
              const created = await createCard(input);
              setCards((c) => [created, ...c]);
            }}
            onCancel={() => setAdding(false)}
          />
        </FormPanel>
      ) : null}

      {editing ? (
        <FormPanel title={`Editing · ${editing.english}`} onClose={() => setEditing(null)}>
          <CardForm
            card={editing}
            onSubmit={async (input) => {
              const saved = await updateCard(editing.id, input);
              setCards((c) => c.map((x) => (x.id === saved.id ? saved : x)));
              setEditing(null);
            }}
            onCancel={() => setEditing(null)}
          />
        </FormPanel>
      ) : null}

      {/* Toolbar. */}
      {cards.length > 0 ? (
        <div className="flex flex-wrap items-center gap-3">
          <label className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-steel-500" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search either side, or the notes…"
              aria-label="Search cards"
              className="input-metal pl-9"
            />
          </label>
          <FilterBar value={filter} onChange={setFilter} counts={stats} />
        </div>
      ) : null}

      {cards.length === 0 && !adding ? (
        <div className="plate rim sheen overflow-hidden p-12 text-center">
          <Layers className="mx-auto mb-4 h-8 w-8 animate-pulseGlow text-neon-violet" />
          <p className="chrome text-xl font-bold">Vault empty</p>
          <p className="mt-1 text-sm text-steel-400">
            Add your first card to start building the deck.
          </p>
        </div>
      ) : null}

      {cards.length > 0 && visible.length === 0 ? (
        <p className="well animate-riseIn px-4 py-10 text-center text-sm text-steel-400">
          Nothing matches <span className="font-mono text-neon-ice">{query || filter}</span>.
        </p>
      ) : null}

      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {visible.map((card, i) => (
          <CardTile
            key={card.id}
            card={card}
            index={i}
            leaving={removing === card.id}
            onEdit={() => {
              setAdding(false);
              setEditing(card);
            }}
            onDelete={() => remove(card)}
          />
        ))}

        {/* Fills out the last row and saves a trip to the header button. */}
        {cards.length > 0 && !adding && !editing ? (
          <li className="animate-riseIn">
            <button
              onClick={() => setAdding(true)}
              className="group flex h-full min-h-[8.5rem] w-full flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-white/10 text-steel-500 transition duration-300 ease-metal hover:border-neon-cyan/40 hover:bg-white/5 hover:text-neon-ice"
            >
              <Plus className="h-5 w-5 transition-transform duration-300 group-hover:rotate-90 group-hover:scale-110" />
              <span className="label">new card</span>
            </button>
          </li>
        ) : null}
      </ul>
    </div>
  );
}

// Static class strings — Tailwind only sees what it can read in the source.
const TONES = {
  ice: { text: "text-neon-ice", bar: "from-neon-ice to-neon-cyan" },
  mint: { text: "text-neon-mint", bar: "from-neon-mint to-emerald-500" },
  violet: { text: "text-neon-violet", bar: "from-neon-violet to-indigo-500" },
  amber: { text: "text-neon-amber", bar: "from-neon-amber to-orange-500" },
} as const;

function StatTile({
  icon,
  label,
  value,
  fraction,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  fraction: number;
  tone: keyof typeof TONES;
}) {
  const { text, bar } = TONES[tone];
  return (
    <div className="plate rim sheen overflow-hidden p-3.5">
      <div className="mb-2 flex items-center justify-between">
        <span className={cn("flex items-center gap-1.5", text)}>
          {icon}
          <span className="label">{label}</span>
        </span>
      </div>
      <p key={value} className="chrome animate-countPop font-mono text-2xl font-bold leading-none">
        {value}
      </p>
      <div className="well mt-2.5 h-1.5 overflow-hidden rounded-full">
        <div
          className={cn(
            "h-full rounded-full bg-gradient-to-r shadow-cyan transition-[width] duration-700 ease-metal",
            bar,
          )}
          style={{ width: `${Math.round(fraction * 100)}%` }}
        />
      </div>
    </div>
  );
}

function FilterBar({
  value,
  onChange,
  counts,
}: {
  value: Filter;
  onChange(value: Filter): void;
  counts: { total: number; unseen: number; learning: number; mastered: number };
}) {
  const options: { value: Filter; label: string; count: number }[] = [
    { value: "all", label: "all", count: counts.total },
    { value: "mastered", label: "mastered", count: counts.mastered },
    { value: "learning", label: "learning", count: counts.learning },
    { value: "unseen", label: "unseen", count: counts.unseen },
  ];
  return (
    <div className="well flex shrink-0 gap-1 p-1">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "sheen relative overflow-hidden rounded-lg px-2.5 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] transition duration-200",
            value === o.value
              ? "bg-gradient-to-b from-neon-ice to-cyan-600 text-ink-950 shadow-cyan"
              : "text-steel-400 hover:text-steel-100",
          )}
        >
          {o.label}
          <span className={cn("ml-1.5", value === o.value ? "text-ink-950/60" : "text-steel-600")}>
            {o.count}
          </span>
        </button>
      ))}
    </div>
  );
}

/** Wrapper that gives the add/edit form its own lit panel. */
function FormPanel({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose(): void;
  children: React.ReactNode;
}) {
  // Escape closes the panel, which is what the label in the corner promises.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <section className="relative animate-riseIn">
      {/* Accent bloom so the open form clearly owns the page. */}
      <div
        aria-hidden
        className="absolute -inset-1 -z-10 rounded-[22px] bg-gradient-to-r from-neon-cyan/25 via-neon-violet/20 to-neon-magenta/20 blur-xl"
      />
      <div className="plate rim p-4 sm:p-5">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h3 className="chrome-cyan truncate font-mono text-xs font-bold uppercase tracking-[0.22em]">
            {title}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="label transition hover:text-steel-100"
            aria-label="Close form"
          >
            esc
          </button>
        </div>
        {children}
      </div>
    </section>
  );
}

function CardTile({
  card,
  index,
  leaving,
  onEdit,
  onDelete,
}: {
  card: Card;
  index: number;
  leaving: boolean;
  onEdit(): void;
  onDelete(): void;
}) {
  const bucket = bucketOf(card);
  const rate = mastery(card);
  const tone =
    bucket === "mastered"
      ? "border-emerald-400/30 text-neon-mint"
      : bucket === "unseen"
        ? "border-amber-400/30 text-neon-amber"
        : "border-violet-400/30 text-neon-violet";

  return (
    <li
      className={cn(
        "plate rim sheen group relative overflow-hidden p-4 transition-all duration-300 ease-metal",
        "hover:-translate-y-1 hover:border-neon-cyan/30 hover:shadow-cyan",
        leaving ? "scale-90 opacity-0 blur-sm" : "animate-riseIn",
      )}
      // Staggered so a freshly loaded vault deals itself out.
      style={leaving ? undefined : { animationDelay: `${Math.min(index, 12) * 45}ms` }}
    >
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="label">english</p>
          <p className="chrome truncate text-lg font-bold leading-tight">{card.english}</p>
          <p className="label mt-2">español</p>
          <p className="truncate text-lg font-semibold leading-tight text-neon-ice">
            {card.spanish}
          </p>
        </div>
        <div className="flex shrink-0 gap-1 opacity-100 transition-opacity duration-200 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
          <button onClick={onEdit} aria-label={`Edit ${card.english}`} className="btn-icon !p-2">
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={onDelete}
            aria-label={`Delete ${card.english}`}
            className="btn-icon !p-2 hover:!border-rose-400/40 hover:text-rose-300 hover:!shadow-rose"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {card.notes ? (
        <p className="mb-3 line-clamp-2 text-xs text-steel-400">{card.notes}</p>
      ) : null}

      <div className="flex items-center gap-3">
        <span className={cn("chip shrink-0", tone)}>{bucket}</span>
        <div className="well h-1.5 flex-1 overflow-hidden rounded-full">
          <div
            className={cn(
              "h-full rounded-full transition-[width] duration-700 ease-metal",
              bucket === "mastered"
                ? "bg-gradient-to-r from-neon-mint to-emerald-500 shadow-mint"
                : "bg-gradient-to-r from-neon-cyan to-neon-violet shadow-cyan",
            )}
            style={{ width: `${Math.round(rate * 100)}%` }}
          />
        </div>
        <span className="shrink-0 font-mono text-[11px] text-steel-400">
          {card.timesSeen ? `${card.timesKnown}/${card.timesSeen}` : "—"}
        </span>
      </div>
    </li>
  );
}

function VaultSkeleton() {
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="plate h-24 overflow-hidden">
            <div className="shimmer-band h-full w-full animate-shimmer opacity-30" />
          </div>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="plate h-40 overflow-hidden">
            <div
              className="shimmer-band h-full w-full animate-shimmer opacity-25"
              style={{ animationDelay: `${i * 120}ms` }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
