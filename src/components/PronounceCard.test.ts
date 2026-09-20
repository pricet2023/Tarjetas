/**
 * That the card actually renders each of its states, and shows the right thing
 * in each.
 *
 * `usePronunciation` is covered separately and is injected here as a plain
 * object, so nothing below touches Web Audio, ONNX or a Worker — this is about
 * the tree. It exists because Phase 7's states are the ones a person only sees
 * under conditions that are awkward to reproduce by hand: a 197 MB download in
 * progress, a card G2P refuses, a model that failed to load.
 *
 * `createElement` rather than JSX so this stays a `.ts` file alongside
 * `FlashCard.test.ts`, and the same hand-rolled `act` harness
 * `usePronunciation.test.ts` uses.
 */

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import type { UseRecorder } from "@/app/lib/audio/useRecorder";
import { groupByWord } from "@/app/lib/phonology/feedback";
import type { PhoneScore } from "@/app/lib/phonology/gop";
import { prepare, type Attempt, type UsePronunciation } from "@/app/lib/pronounce/usePronunciation";
import type { Card } from "@/types/cards";

import { PronounceCard } from "./PronounceCard";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const card: Card = {
  id: "card-1",
  english: "the dog",
  spanish: "el perro",
  notes: null,
  timesSeen: 0,
  timesKnown: 0,
  lastSeenAt: null,
  createdAt: new Date().toISOString(),
};

const recorder = (state: UseRecorder["state"] = "idle"): UseRecorder => ({
  state,
  error: null,
  level: { current: 0 },
  warnings: [],
  arm: vi.fn(async () => {}),
  start: vi.fn(),
  stop: vi.fn(async () => null),
  cancel: vi.fn(),
});

const hook = (over: Partial<UsePronunciation> = {}): UsePronunciation => ({
  model: { state: "ready", received: 0, total: 0, error: null },
  recorder: recorder(),
  scoring: false,
  attempt: null,
  error: null,
  arm: vi.fn(async () => {}),
  start: vi.fn(),
  stop: vi.fn(async () => null),
  reset: vi.fn(),
  ...over,
});

const score = (phone: string, over: Partial<PhoneScore> = {}): PhoneScore => ({
  phone,
  start: 0,
  end: 1,
  gop: 5,
  rival: null,
  rivalLabel: "",
  z: 1,
  calibrated: true,
  verdict: "good",
  ...over,
});

/** An attempt on *el perro* whose trill came out as a tap. */
function tappedAttempt(): Attempt {
  const { words } = prepare(card.spanish);
  const phones = words
    .flatMap((w) => w.phones)
    .map((p) =>
      p === "r" ? score("r", { verdict: "off", rival: "ɾ", rivalLabel: "ɾ", z: -3.4, gop: -2.9 }) : score(p),
    );
  return {
    phones,
    // The real grouping, so the per-syllable meters render rather than
    // silently falling back to the unscored track.
    words: groupByWord(words, phones),
    score: 5 / 6,
    worst: phones.find((p) => p.verdict === "off") ?? null,
    audio: {
      samples: new Float32Array(1600),
      full: new Float32Array(3200),
      sampleRate: 16000,
      durationMs: 100,
      capturedMs: 200,
      endpoints: { start: 0, end: 1600, floorDb: -60, thresholdDb: -48, peakDb: -12 },
      truncated: false,
      warnings: [],
    },
  };
}

function render(props: Parameters<typeof PronounceCard>[0]) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(createElement(PronounceCard, props)));
  return {
    text: () => container.textContent ?? "",
    html: () => container.innerHTML,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

const base = { card, isNew: false, onAnswer: vi.fn() };

describe("PronounceCard", () => {
  it("shows the prompt and the target, split into syllables", () => {
    const view = render({ ...base, pronunciation: hook() });
    const text = view.text();

    expect(text).toContain("the dog");
    // el · pe · rro, as G2P syllabifies it — the phones, not the spelling.
    expect(text).toContain("el");
    expect(text).toContain("pe");
    expect(text).toContain("ro");
    expect(text).toContain("hold to speak");
    view.unmount();
  });

  it("says it is listening while the mic is open", () => {
    const view = render({ ...base, pronunciation: hook({ recorder: recorder("recording") }) });
    expect(view.text()).toContain("listening");
    view.unmount();
  });

  it("shows megabytes, not a spinner, while the weights download", () => {
    // A ~200 s wait (§13.2). A spinner here reads as a hang.
    const view = render({
      ...base,
      pronunciation: hook({
        model: { state: "loading", received: 50_000_000, total: 197_000_000, error: null },
      }),
    });
    expect(view.text()).toContain("50 / 197 MB");
    expect(view.text()).toMatch(/cached/i);
    view.unmount();
  });

  it("names the sound and the rival once an attempt is scored", () => {
    const attempt = tappedAttempt();
    const view = render({ ...base, pronunciation: hook({ attempt }) });
    const text = view.text();

    expect(text).toContain("/r/");
    expect(text).toContain("that was a tap, not a trill");
    // The articulation hint, which is the actionable half.
    expect(text).toMatch(/flutter/);
    // The share of phones clean, as a percentage.
    expect(text).toContain("83");
    // And the syllable carrying the bad phone is lit as a miss, not as a hit.
    expect(view.html()).toContain("from-rose-500");
    view.unmount();
  });

  it("offers a retry rather than a verdict for a failed attempt", () => {
    const view = render({ ...base, pronunciation: hook({ attempt: tappedAttempt() }) });
    expect(view.text()).toContain("Try again");
    expect(view.text()).toContain("Next card");
    view.unmount();
  });

  it("refuses a card G2P can't pronounce, and doesn't offer the mic", () => {
    const view = render({
      ...base,
      card: { ...card, spanish: "100%" },
      pronunciation: hook(),
    });
    expect(view.text()).not.toContain("hold to speak");
    expect(view.text()).toContain("Skip");
    view.unmount();
  });

  it("surfaces a model that failed to load instead of a dead button", () => {
    const view = render({
      ...base,
      pronunciation: hook({
        model: { state: "failed", received: 0, total: 0, error: "The model wouldn't load." },
      }),
    });
    expect(view.text()).toContain("The model wouldn't load.");
    expect(view.text()).not.toContain("hold to speak");
    view.unmount();
  });

  it("says so when a sound has no native baseline", () => {
    const attempt = tappedAttempt();
    attempt.phones[0] = score("e", { calibrated: false, z: 0.2 });
    const view = render({ ...base, pronunciation: hook({ attempt }) });
    expect(view.text()).toMatch(/no native baseline/i);
    view.unmount();
  });
});
