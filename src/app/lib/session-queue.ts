/**
 * In-session card queue.
 *
 * The database decides which cards enter a session and in what order (see
 * `study_deck`). This decides what happens to a card *within* one, and since
 * 016 the answer is "nothing": a card is asked once and leaves.
 *
 * It used to requeue a failed card four places back, on the reasoning that the
 * deck is dealt once up front so a card failed at position 3 would otherwise
 * not be seen again until the next session. The flaw was that it requeued
 * *indefinitely* — a card you could not get right came round every five cards
 * for the rest of the session, which is the most plausible source of the
 * "I saw 'ya' about eight times in a row" that prompted 016.
 *
 * The replacement is not "one retry instead of unlimited" but no retry at all,
 * because the scheduler now guarantees a card cannot be dealt twice within an
 * hour and an in-session retry is by definition inside that hour. A failed
 * card is still the first thing you meet next session: `study_deck` holds a
 * card whose streak is 0 at an urgency floor until it is answered correctly.
 * The re-test moved from minutes later to an hour later, which is also the
 * better spacing for it.
 */

/**
 * Advance the queue past its first card.
 *
 * The card is dropped whether or not it was known — see the module note. Takes
 * the queue alone: there is deliberately no `knew` parameter, so a caller
 * cannot ask for the old requeue behaviour by mistake.
 */
export function advance<T>(queue: readonly T[]): T[] {
  return queue.slice(1);
}
