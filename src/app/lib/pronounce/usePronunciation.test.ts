/**
 * The wiring, not the arithmetic.
 *
 * What can go wrong here is *sequencing* — releasing the button before the
 * weights have arrived, a card G2P refuses, an unmount halfway through a
 * 197 MB download — and none of it involves a single GOP calculation, which
 * `gop.test.ts` and `gop.integration.test.ts` already cover. So the model and
 * the microphone are both injected, exactly as `recorder.test.ts` injects its
 * mic, and every assertion below is about what happened in what order.
 *
 * Rendered through a hand-rolled `act` harness rather than a testing library:
 * one hook needs one component, and React 18.3 exports `act` itself.
 */

import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import type { AcousticModel } from "@/app/lib/acoustic/model";
import type { LogProbs } from "@/app/lib/align/ctc";
import type { Batch, Microphone } from "@/app/lib/audio/capture";

import { prepare, usePronunciation, type UsePronunciation } from "./usePronunciation";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const RATE = 16000;

/** Enough of the espeak inventory for *casa*, plus rivals worth losing to. */
const VOCAB = ["<pad>", "k", "a", "s", "e", "o", "t", "g", "ɡ", "θ", "p"];
const BLANK = 0;

/**
 * A posterior that says `k a s a` clearly: one confident frame per phone with
 * blank between, which is the peaky shape §13.3 measured on the real model.
 */
function casaPosterior(): LogProbs {
  const order = ["<pad>", "k", "<pad>", "a", "<pad>", "s", "<pad>", "a", "<pad>"];
  const data = order.flatMap((label) => {
    const weights = VOCAB.map((v) => (v === label ? 1 : 0.0005));
    const total = weights.reduce((a, b) => a + b, 0);
    return weights.map((w) => Math.log(w / total));
  });
  return { data, frames: order.length, vocabSize: VOCAB.length };
}

function fakeModel(overrides: Partial<AcousticModel> = {}) {
  // Holds the real session to its contract, so a test can't pass on audio the
  // app would have refused: `openSession` throws on anything but 16 kHz rather
  // than resampling, because silently scoring 44.1 kHz as if it were 16 kHz is
  // three-times-too-fast and wrong everywhere (§13.6).
  const score = vi.fn(async (samples: Float32Array, sampleRate: number = RATE) => {
    if (sampleRate !== RATE) throw new Error(`Expected ${RATE} Hz audio, got ${sampleRate}`);
    if (samples.length === 0) throw new Error("Nothing to score");
    return { logProbs: casaPosterior(), labels: VOCAB, blank: BLANK };
  });
  return {
    labels: VOCAB,
    blank: BLANK,
    sampleRate: RATE,
    score,
    close: vi.fn(),
    ...overrides,
  } as AcousticModel & { score: typeof score; close: ReturnType<typeof vi.fn> };
}

function fakeMic() {
  const listeners = new Set<(batch: Batch) => void>();
  const mic = {
    sampleRate: RATE,
    settings: {} as MediaTrackSettings,
    warnings: [] as readonly string[],
    onBatch(listener: (batch: Batch) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    flush: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  const emit = (samples: Float32Array): void => {
    let peak = 0;
    for (const x of samples) peak = Math.max(peak, Math.abs(x));
    for (const listener of listeners) listener({ samples, peak, reason: "full" });
  };
  return { mic: mic as Microphone & typeof mic, emit };
}

/** Room tone, a burst of voice, room tone — the shape the trim expects. */
function utterance(): Float32Array {
  const length = Math.round(1.4 * RATE);
  let state = 7;
  const samples = Float32Array.from({ length }, () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return ((state / 2147483648) * 2 - 1) * 0.001;
  });
  for (let i = Math.round(0.4 * RATE); i < Math.round(1.0 * RATE); i += 1) {
    samples[i] += 0.3 * Math.sin((i * 2 * Math.PI * 200) / RATE);
  }
  return samples;
}

const passthrough = async (samples: Float32Array) => samples.slice();

function render(deps: Parameters<typeof usePronunciation>[0]) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const box = { current: null as unknown as UsePronunciation };
  const Probe = () => {
    box.current = usePronunciation(deps);
    return null;
  };
  act(() => root.render(createElement(Probe)));
  return {
    hook: box,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe("prepare", () => {
  it("gives back the words a card will be scored against", () => {
    const { words, error } = prepare("el perro");
    expect(error).toBeNull();
    expect(words.map((w) => w.word)).toEqual(["el", "perro"]);
  });

  it("refuses a card G2P can't pronounce, rather than throwing at the learner", () => {
    // §11: G2P throws on characters it has no sound for, on purpose. A deck of
    // 3,479 seeded cards will contain one, and it is a card to skip.
    const { words, error } = prepare("100%");
    expect(words).toEqual([]);
    expect(error).toBeTruthy();
  });
});

describe("usePronunciation", () => {
  it("scores a held-and-released attempt against the card's phones", async () => {
    const model = fakeModel();
    const { mic, emit } = fakeMic();
    const { hook, unmount } = render({
      load: async () => model,
      recorder: { openMic: async () => mic, resample: passthrough },
    });

    await act(async () => {
      await hook.current.arm();
    });
    expect(hook.current.model.state).toBe("ready");

    act(() => hook.current.start());
    act(() => emit(utterance()));

    let attempt: Awaited<ReturnType<UsePronunciation["stop"]>> = null;
    await act(async () => {
      attempt = await hook.current.stop("casa");
    });

    expect(attempt).not.toBeNull();
    expect(attempt!.phones.map((p) => p.phone)).toEqual(["k", "a", "s", "a"]);
    // Folded back onto syllables for the display: ca-sa.
    expect(attempt!.words[0].syllables.map((s) => s.phones.length)).toEqual([2, 2]);
    expect(attempt!.score).toBe(1);
    expect(hook.current.attempt).toBe(attempt);
    // The audio it scored is kept, so the learner can hear what the model heard.
    expect(attempt!.audio.full.length).toBeGreaterThan(attempt!.audio.samples.length);
    unmount();
  });

  it("hands the model 16 kHz audio and nothing else", async () => {
    const model = fakeModel();
    const { mic, emit } = fakeMic();
    const { hook, unmount } = render({
      load: async () => model,
      recorder: { openMic: async () => mic, resample: passthrough },
    });

    await act(async () => {
      await hook.current.arm();
    });
    act(() => hook.current.start());
    act(() => emit(utterance()));
    await act(async () => {
      await hook.current.stop("casa");
    });

    expect(model.score).toHaveBeenCalledTimes(1);
    const [samples] = model.score.mock.calls[0];
    expect(samples).toBeInstanceOf(Float32Array);
    // The trimmed take, not the whole 1.4 s the fake device produced (§14.2).
    expect(samples.length).toBeLessThan(Math.round(1.4 * RATE));
    unmount();
  });

  it("reports download progress while the weights are still arriving", async () => {
    // The first load is a real ~200 s wait (§13.2), so the page has to be able
    // to draw a bar rather than a spinner — which means progress has to be
    // observable *during* the load, not summarised after it.
    const { mic } = fakeMic();
    let report: ((received: number, total: number) => void) | undefined;
    let finish!: (model: AcousticModel) => void;
    const pending = new Promise<AcousticModel>((resolve) => {
      finish = resolve;
    });

    const { hook, unmount } = render({
      load: async ({ onProgress } = {}) => {
        report = onProgress;
        return pending;
      },
      recorder: { openMic: async () => mic, resample: passthrough },
    });

    let armed!: Promise<void>;
    act(() => {
      armed = hook.current.arm();
    });
    expect(hook.current.model.state).toBe("loading");

    act(() => report?.(50_000_000, 197_000_000));
    expect(hook.current.model).toMatchObject({
      state: "loading",
      received: 50_000_000,
      total: 197_000_000,
    });

    await act(async () => {
      finish(fakeModel());
      await armed;
    });
    expect(hook.current.model.state).toBe("ready");
    unmount();
  });

  it("surfaces a failed load rather than leaving the button dead", async () => {
    const { mic } = fakeMic();
    const { hook, unmount } = render({
      load: async () => {
        throw new Error("The pronunciation model wouldn't load.");
      },
      recorder: { openMic: async () => mic, resample: passthrough },
    });

    await act(async () => {
      await hook.current.arm();
    });

    expect(hook.current.model.state).toBe("failed");
    expect(hook.current.error).toMatch(/wouldn't load/);
    unmount();
  });

  it("refuses to score a card it has no target for, and says which", async () => {
    const model = fakeModel();
    const { mic, emit } = fakeMic();
    const { hook, unmount } = render({
      load: async () => model,
      recorder: { openMic: async () => mic, resample: passthrough },
    });

    await act(async () => {
      await hook.current.arm();
    });
    act(() => hook.current.start());
    act(() => emit(utterance()));

    let attempt: Awaited<ReturnType<UsePronunciation["stop"]>> = null;
    await act(async () => {
      attempt = await hook.current.stop("100%");
    });

    expect(attempt).toBeNull();
    expect(hook.current.error).toBeTruthy();
    // And crucially it never reached the model: a bad target would have
    // mis-aligned every frame and read back as the learner's mistake (§11).
    expect(model.score).not.toHaveBeenCalled();
    unmount();
  });

  it("says it heard nothing rather than scoring a silent room", async () => {
    const model = fakeModel();
    const { mic, emit } = fakeMic();
    const { hook, unmount } = render({
      load: async () => model,
      recorder: { openMic: async () => mic, resample: passthrough },
    });

    await act(async () => {
      await hook.current.arm();
    });
    act(() => hook.current.start());
    act(() => emit(new Float32Array(RATE).fill(0)));

    let attempt: Awaited<ReturnType<UsePronunciation["stop"]>> = null;
    await act(async () => {
      attempt = await hook.current.stop("casa");
    });

    expect(attempt).toBeNull();
    expect(hook.current.error).toMatch(/didn't hear|microphone|mic/i);
    expect(model.score).not.toHaveBeenCalled();
    unmount();
  });

  it("loads the weights once, however many times it is armed", async () => {
    const model = fakeModel();
    const load = vi.fn(async () => model);
    const { mic } = fakeMic();
    const { hook, unmount } = render({
      load,
      recorder: { openMic: async () => mic, resample: passthrough },
    });

    await act(async () => {
      await Promise.all([hook.current.arm(), hook.current.arm()]);
      await hook.current.arm();
    });

    expect(load).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("closes the worker when the page leaves pronunciation mode", async () => {
    const model = fakeModel();
    const { mic } = fakeMic();
    const { hook, unmount } = render({
      load: async () => model,
      recorder: { openMic: async () => mic, resample: passthrough },
    });

    await act(async () => {
      await hook.current.arm();
    });
    unmount();

    // 197 MB of weights held by a worker nobody is talking to.
    expect(model.close).toHaveBeenCalled();
    expect(mic.close).toHaveBeenCalled();
  });

  it("drops the previous attempt when reset for the next card", async () => {
    const model = fakeModel();
    const { mic, emit } = fakeMic();
    const { hook, unmount } = render({
      load: async () => model,
      recorder: { openMic: async () => mic, resample: passthrough },
    });

    await act(async () => {
      await hook.current.arm();
    });
    act(() => hook.current.start());
    act(() => emit(utterance()));
    await act(async () => {
      await hook.current.stop("casa");
    });
    expect(hook.current.attempt).not.toBeNull();

    act(() => hook.current.reset());
    expect(hook.current.attempt).toBeNull();
    expect(hook.current.error).toBeNull();
    unmount();
  });
});
