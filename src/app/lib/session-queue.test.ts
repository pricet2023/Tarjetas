import { describe, expect, it } from "vitest";

import { advance } from "./session-queue";

describe("advance", () => {
  const deck = ["a", "b", "c", "d", "e", "f", "g"];

  it("drops the answered card", () => {
    expect(advance(deck)).toEqual(["b", "c", "d", "e", "f", "g"]);
  });

  it("drops a failed card too, rather than requeueing it", () => {
    // The whole point of 016: a card is asked once per session. The retry is
    // the scheduler's job now, an hour later at the earliest.
    expect(advance(deck)).not.toContain("a");
  });

  it("ends the session on the last card", () => {
    expect(advance(["a"])).toEqual([]);
  });

  it("is a no-op on an empty queue", () => {
    expect(advance([])).toEqual([]);
  });

  it("empties a deck in exactly one pass", () => {
    let q: string[] = [...deck];
    for (let i = 0; i < deck.length; i++) q = advance(q);
    expect(q).toEqual([]);
  });

  it("never lengthens the queue", () => {
    // A queue that can grow is a session that can repeat a card.
    let q: string[] = [...deck];
    while (q.length > 0) {
      const before = q.length;
      q = advance(q);
      expect(q.length).toBe(before - 1);
    }
  });
});
