import type { Database } from "@/types/database.types";

type CardsWithProgressRow = Database["public"]["Views"]["cards_with_progress"]["Row"];
type DeckRow = Database["public"]["Functions"]["study_deck"]["Returns"][number];

/**
 * Postgres reports no not-null information for view columns, so the generator
 * marks every one of them nullable. This narrows the ones that can't actually
 * be null back down — the key list is checked against the view type, so a
 * column that disappears from the view is a compile error rather than a silent
 * `never`.
 */
type NotNull<T, K extends keyof T> = Omit<T, K> & { [P in K]-?: NonNullable<T[P]> };

/**
 * A row of `cards_with_progress`: the shared card plus the *calling user's*
 * progress against it. id/english/spanish/created_at come straight off
 * public.cards and the two counters are coalesced in the view, so only
 * `last_seen_at` (never reviewed) and the content nullables are open.
 */
export type CardRow = NotNull<
  CardsWithProgressRow,
  "id" | "english" | "spanish" | "created_at" | "times_seen" | "times_known"
>;

/**
 * A card as the app uses it — camelCase. The deck of cards is shared between
 * accounts; the counters are the signed-in user's own, so two people looking
 * at the same card see different numbers.
 */
export interface Card {
  id: string;
  english: string;
  spanish: string;
  notes: string | null;
  timesSeen: number;
  timesKnown: number;
  lastSeenAt: string | null;
  createdAt: string;
}

/**
 * Which skill the prompt is asking for. 'english' means you have to produce
 * the Spanish (the harder direction); 'spanish' means you only have to
 * recognise it; 'pronounce' shows the English and asks you to *say* the
 * Spanish out loud. Three separate skills, scheduled separately, per user.
 */
export type Side = "english" | "spanish" | "pronounce";

const SIDES: readonly Side[] = ["english", "spanish", "pronounce"];

/**
 * Narrow a `prompt_side` off a row. The column is `text` with a check
 * constraint, so the generated types give us `string` and something has to
 * decide what an unrecognised value means. It means the DB has a direction
 * this build has never heard of, which is a bug rather than a card to deal.
 */
export const toSide = (value: string): Side => {
  const side = SIDES.find((s) => s === value);
  if (!side) throw new Error(`Unknown prompt side "${value}"`);
  return side;
};

/**
 * One phone's verdict, as scored on the device. Mirrors `PhoneScore` in
 * `@/app/lib/phonology/gop`, snake_cased for the `card_reviews.phone_scores`
 * column — the api boundary is where the two spellings meet, per CLAUDE.md.
 *
 * A `type` rather than an `interface` on purpose: only a type alias gets an
 * implicit index signature, and without one this is not assignable to the
 * generated `Json` the jsonb column is typed as.
 */
export type PhoneScoreRow = {
  phone: string;
  start: number;
  end: number;
  gop: number | null;
  rival: string | null;
  rival_label: string;
  z: number | null;
  calibrated: boolean;
  verdict: "good" | "close" | "off";
};

/** A card as dealt by `study_deck`: the direction and weight come from the DB. */
export interface DeckEntry {
  card: Card;
  promptSide: Side;
  /** The scheduler's weight, carried through for the debug overlay. */
  weight: number;
  /** True when this user has never been asked this direction. */
  isNew: boolean;
}

export const toCard = (row: CardRow): Card => ({
  id: row.id,
  english: row.english,
  spanish: row.spanish,
  notes: row.notes,
  timesSeen: row.times_seen,
  timesKnown: row.times_known,
  lastSeenAt: row.last_seen_at,
  createdAt: row.created_at,
});

export const toDeckEntry = (row: DeckRow): DeckEntry => ({
  card: {
    id: row.id,
    english: row.english,
    spanish: row.spanish,
    notes: row.notes,
    timesSeen: row.times_seen,
    timesKnown: row.times_known,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
  },
  promptSide: toSide(row.prompt_side),
  weight: row.weight,
  isNew: row.is_new,
});
