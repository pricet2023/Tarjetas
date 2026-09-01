import { describe, expect, it } from "vitest";

import { advance } from "./session-queue";

describe("advance", () => {
  const deck = ["a", "b", "c", "d", "e", "f", "g"];

  it("drops a card that was known", () => {
    expect(advance(deck, true)).toEqual(["b", "c", "d", "e", "f", "g"]);
  });

  it("moves a failed card back by the gap", () => {
    expect(advance(deck, false, 4)).toEqual(["b", "c", "d", "e", "a", "f", "g"]);
  });

  it("puts a failed card last when fewer than gap cards remain", () => {
    expect(advance(["a", "b", "c"], false, 4)).toEqual(["b", "c", "a"]);
  });

  it("retries the last card of a deck rather than ending the session", () => {
    expect(advance(["a"], false)).toEqual(["a"]);
  });

  it("ends the session when the last card is known", () => {
    expect(advance(["a"], true)).toEqual([]);
  });

  it("is a no-op on an empty queue", () => {
    expect(advance([], true)).toEqual([]);
    expect(advance([], false)).toEqual([]);
  });

  it("keeps every card until it is answered correctly", () => {
    // Fail 'a' repeatedly: it must never be lost from the queue.
    let q = [...deck];
    for (let i = 0; i < 20; i++) {
      q = q[0] === "a" ? advance(q, false) : advance(q, true);
      expect(q).toContain("a");
    }
  });
});
