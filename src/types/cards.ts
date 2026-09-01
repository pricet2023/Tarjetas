import type { Database } from "@/types/database.types";

export type CardRow = Database["public"]["Tables"]["cards"]["Row"];

/** A card as the app uses it — camelCase, review counters included. */
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

/** Which side of the card is face-up when a study prompt is shown. */
export type Side = "english" | "spanish";

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
