import { supabase } from "@/app/lib/supabase";
import { type Card, type DeckEntry, type Side, toCard, toDeckEntry } from "@/types/cards";

export interface CardInput {
  english: string;
  spanish: string;
  notes?: string | null;
}

export async function listCards(): Promise<Card[]> {
  const { data, error } = await supabase
    .from("cards")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw new Error(`Failed to load cards: ${error.message}`);
  return (data ?? []).map(toCard);
}

export async function createCard(input: CardInput): Promise<Card> {
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) throw new Error("Not signed in");

  const { data, error } = await supabase
    .from("cards")
    .insert({
      user_id: auth.user.id,
      english: input.english.trim(),
      spanish: input.spanish.trim(),
      notes: input.notes?.trim() || null,
    })
    .select()
    .single();

  if (error) {
    // 23505 is the (user_id, english) unique index.
    if (error.code === "23505") {
      throw new Error(`You already have a card for "${input.english.trim()}"`);
    }
    throw new Error(`Failed to create card: ${error.message}`);
  }
  return toCard(data);
}

export async function updateCard(id: string, input: CardInput): Promise<Card> {
  const { data, error } = await supabase
    .from("cards")
    .update({
      english: input.english.trim(),
      spanish: input.spanish.trim(),
      notes: input.notes?.trim() || null,
    })
    .eq("id", id)
    .select()
    .single();
  if (error) {
    if (error.code === "23505") {
      throw new Error(`You already have a card for "${input.english.trim()}"`);
    }
    throw new Error(`Failed to update card: ${error.message}`);
  }
  return toCard(data);
}

export async function deleteCard(id: string): Promise<void> {
  const { error } = await supabase.from("cards").delete().eq("id", id);
  if (error) throw new Error(`Failed to delete card: ${error.message}`);
}

export interface DeckOptions {
  deckSize?: number;
  /** Cap on unseen cards in one deck, so new material can't swamp a session. */
  newLimit?: number;
  /** Directions to draw from. Both = the deck picks the weaker one per card. */
  sides?: Side[];
}

/**
 * Build a study deck. Both the weighting and the choice of direction live in
 * the `study_deck` SQL function — see 008_study_deck.sql for the algorithm.
 * The app deliberately does no ordering of its own beyond in-session requeues.
 */
export async function getStudyDeck({
  deckSize = 20,
  newLimit = 5,
  sides = ["english", "spanish"],
}: DeckOptions = {}): Promise<DeckEntry[]> {
  const { data, error } = await supabase.rpc("study_deck", {
    deck_size: deckSize,
    new_limit: newLimit,
    sides,
  });
  if (error) throw new Error(`Failed to build deck: ${error.message}`);
  return (data ?? []).map(toDeckEntry);
}

export async function recordReview(
  cardId: string,
  knew: boolean,
  promptSide: Side,
  responseMs?: number,
): Promise<void> {
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) throw new Error("Not signed in");

  const { error } = await supabase.from("card_reviews").insert({
    card_id: cardId,
    user_id: auth.user.id,
    knew,
    prompt_side: promptSide,
    // Clamped: a card left open in a backgrounded tab would otherwise record
    // an hour-long "response" and poison the timing data.
    response_ms:
      responseMs === undefined ? null : Math.min(Math.round(responseMs), 120_000),
  });
  if (error) throw new Error(`Failed to record review: ${error.message}`);
}
