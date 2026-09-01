/**
 * In-session card queue.
 *
 * The database decides which cards enter a session and in what order (see
 * `study_deck`). This decides what happens to a card *within* one, because the
 * deck is dealt once up front: a card failed at position 3 would otherwise not
 * be seen again until the next session, which is precisely when re-testing it
 * is worth most.
 */

/** How many cards to put between a failed card and its retry. */
export const REQUEUE_GAP = 4;

/**
 * Advance the queue past its first card.
 *
 * A card that was known is dropped. A card that wasn't is moved `gap` places
 * back — or to the end when fewer than `gap` cards remain, so that failing the
 * last card of a deck still earns a retry rather than ending the session.
 */
export function advance<T>(queue: readonly T[], knew: boolean, gap = REQUEUE_GAP): T[] {
  if (queue.length === 0) return [];
  const [head, ...rest] = queue;
  if (knew) return rest;
  const at = Math.min(gap, rest.length);
  return [...rest.slice(0, at), head, ...rest.slice(at)];
}
