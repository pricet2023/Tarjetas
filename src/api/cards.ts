import { g2pPhrase } from "@/app/lib/phonology/g2p";
import { supabase } from "@/app/lib/supabase";
import {
  type Card,
  type CardRow,
  type DeckEntry,
  type PhoneScoreRow,
  type Side,
  toCard,
  toDeckEntry,
} from "@/types/cards";

export interface CardInput {
  english: string;
  spanish: string;
  notes?: string | null;
}

/**
 * The whole deck. Cards are shared between accounts — one portfolio, both of
 * us adding to it — so this is everyone's cards; the counters on each row are
 * the signed-in user's own (see the `cards_with_progress` view in 009).
 */
export async function listCards(): Promise<Card[]> {
  const { data, error } = await supabase
    .from("cards_with_progress")
    .select("*")
    .order("created_at", { ascending: false })
    .overrideTypes<CardRow[], { merge: false }>();
  if (error) throw new Error(`Failed to load cards: ${error.message}`);
  return (data ?? []).map(toCard);
}

/**
 * This user's counters for one card, as `cards_with_progress` would report
 * them. Needed after a write, because writing to `cards` returns the shared
 * row and the counters aren't on it.
 */
async function progressOf(cardId: string) {
  const { data, error } = await supabase
    .from("card_progress")
    .select("times_seen, times_known, last_seen_at")
    .eq("card_id", cardId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load card progress: ${error.message}`);
  return {
    times_seen: data?.times_seen ?? 0,
    times_known: data?.times_known ?? 0,
    last_seen_at: data?.last_seen_at ?? null,
  };
}

/**
 * Cache the phonemes of a card face, so the scheduler can weight a
 * pronunciation prompt for it before anyone has ever said it (migration 014).
 *
 * G2P is TypeScript and the deck weighting is SQL, so this is the only way the
 * database ever learns what sounds a phrase contains. The seed deck is filled
 * in by 015; this covers everything typed in afterwards.
 *
 * **Never allowed to fail a card write.** A card the app can't pronounce is a
 * perfectly good card in the other two directions — it simply keeps the flat
 * unseen urgency every other new card has — and losing a card because its
 * phonetics couldn't be cached would be an absurd trade.
 */
async function rememberPhones(spanish: string): Promise<void> {
  let phones: string[];
  try {
    phones = g2pPhrase(spanish).flatMap((word) => word.phones);
  } catch {
    return; // G2P refuses it; so will the scorer. Nothing to cache.
  }
  if (phones.length === 0) return;
  // The table is shared reference data derived from the text alone, so a row
  // someone else has already written is the same row: last writer wins and it
  // makes no difference which.
  await supabase.from("phrase_phones").upsert({ phrase: spanish, phones }, { onConflict: "phrase" });
}

export async function createCard(input: CardInput): Promise<Card> {
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) throw new Error("Not signed in");

  const { data, error } = await supabase
    .from("cards")
    .insert({
      // Authorship only: the card belongs to the deck, not to whoever typed it.
      created_by: auth.user.id,
      english: input.english.trim(),
      spanish: input.spanish.trim(),
      notes: input.notes?.trim() || null,
    })
    .select()
    .single();

  if (error) {
    // 23505 is the unique index on `english`, now deck-wide rather than
    // per-user: the duplicate may well be one your partner added.
    if (error.code === "23505") {
      throw new Error(`The deck already has a card for "${input.english.trim()}"`);
    }
    throw new Error(`Failed to create card: ${error.message}`);
  }
  await rememberPhones(data.spanish);
  // Nobody can have reviewed a card that didn't exist a moment ago.
  return toCard({ ...data, times_seen: 0, times_known: 0, last_seen_at: null });
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
      throw new Error(`The deck already has a card for "${input.english.trim()}"`);
    }
    throw new Error(`Failed to update card: ${error.message}`);
  }
  // The Spanish may have changed, and phrase_phones is keyed on it: the old
  // row still describes the old text, and the new text has no row until this.
  await rememberPhones(data.spanish);
  // An edit doesn't touch anyone's progress, but the counters aren't on the
  // row that comes back, so they're read alongside it.
  return toCard({ ...data, ...(await progressOf(id)) });
}

export async function deleteCard(id: string): Promise<void> {
  const { error } = await supabase.from("cards").delete().eq("id", id);
  if (error) throw new Error(`Failed to delete card: ${error.message}`);
}

export interface DeckOptions {
  deckSize?: number;
  /**
   * Deck slots reserved for unseen cards. A reservation, not a cap on a shared
   * pool: since 016 the new cards get these outright rather than losing them
   * to overdue cards in the race. Either lane tops up if the other is short.
   */
  newLimit?: number;
  /** Directions to draw from. Both = the deck picks the weaker one per card. */
  sides?: Side[];
}

/**
 * Build a study deck. Both the weighting and the choice of direction live in
 * the `study_deck` SQL function — see 016_deck_variety.sql for the current
 * algorithm. The deck is drawn from every card in the shared portfolio but
 * weighted by the caller's own history, so the two of us get different decks
 * out of the same cards, and a card cannot be dealt twice within an hour or
 * more than twice within six. The app does no ordering of its own at all.
 */
export async function getStudyDeck({
  deckSize = 20,
  newLimit = 10,
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

/**
 * What a pronunciation attempt adds to the review row. Scored entirely on the
 * device (`scoreUtterance` in `@/app/lib/phonology/gop`); this is only the
 * result being filed.
 */
export interface PronunciationResult {
  /** `summarise().score` — the share of phones that came back clean. */
  score: number;
  /** The per-phone detail behind it, which is what `phone_state` accumulates. */
  phones: PhoneScoreRow[];
}

export async function recordReview(
  cardId: string,
  knew: boolean,
  promptSide: Side,
  responseMs?: number,
  pronunciation?: PronunciationResult,
): Promise<void> {
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) throw new Error("Not signed in");

  // The DB rejects a score on a translation review (see 013), so don't send
  // one: a mis-sided row would otherwise fail the whole insert at the server
  // for what is a caller mistake.
  const scored = promptSide === "pronounce" ? pronunciation : undefined;

  const { error } = await supabase.from("card_reviews").insert({
    card_id: cardId,
    user_id: auth.user.id,
    knew,
    prompt_side: promptSide,
    // Clamped: a card left open in a backgrounded tab would otherwise record
    // an hour-long "response" and poison the timing data.
    response_ms:
      responseMs === undefined ? null : Math.min(Math.round(responseMs), 120_000),
    score: scored?.score ?? null,
    // The trigger in 013 reads `phone`, `gop` and `verdict` out of this and
    // rolls them onto phone_state.
    phone_scores: scored ? scored.phones : null,
  });
  if (error) throw new Error(`Failed to record review: ${error.message}`);
}
