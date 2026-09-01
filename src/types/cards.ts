import type { Database } from "@/types/database.types";

export type CardRow = Database["public"]["Tables"]["cards"]["Row"];
type DeckRow = Database["public"]["Functions"]["study_deck"]["Returns"][number];

/** A card as the app uses it — camelCase, lifetime counters included. */
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
 * Which side of the card is face-up when the prompt is shown. 'english' means
 * you have to produce the Spanish (the harder direction); 'spanish' means you
 * only have to recognise it. Each is scheduled separately.
 */
export type Side = "english" | "spanish";

/** A card as dealt by `study_deck`: the direction and weight come from the DB. */
export interface DeckEntry {
  card: Card;
  promptSide: Side;
  /** The scheduler's weight, carried through for the debug overlay. */
  weight: number;
  /** True when this direction has never been reviewed. */
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
  promptSide: row.prompt_side === "spanish" ? "spanish" : "english",
  weight: row.weight,
  isNew: row.is_new,
});
