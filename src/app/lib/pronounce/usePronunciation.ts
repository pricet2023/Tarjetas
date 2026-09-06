/**
 * The one place Phases 1–5 are wired end to end.
 *
 * ```
 * card.spanish ──g2pPhrase──▶ phones ─┐
 * microphone ──useRecorder──▶ 16 kHz ─┴─model.score──▶ logProbs ──scoreUtterance──▶ PhoneScore[]
 * ```
 *
 * Everything below the hook is already pure and tested; this is the React
 * seam, and it exists to keep three awkward facts out of the page:
 *
 * 1. **The model is a 197 MB download** (§13.2). It must not be fetched
 *    because someone opened the study screen — only when they choose to
 *    pronounce something — and the first load is a ~200 s wait that needs a
 *    progress bar rather than a spinner.
 * 2. **The microphone is opened once and left open** (§14.1), so arming is a
 *    separate step from recording and both have to happen from a gesture.
 * 3. **G2P throws on a card it cannot pronounce** (§11), by design. A deck of
 *    3,479 seeded cards will contain something with a digit in it, and that is
 *    a card to skip, not a crash.
 *
 * Injectable, for the same reason `createRecorder` is: `jsdom` has neither
 * `Worker` nor `AudioContext`, and the sequencing here — what happens if you
 * release before the model is ready, what a failed attempt leaves behind — is
 * worth testing without a browser.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { loadAcousticModel, type AcousticModel, type LoadOptions } from "@/app/lib/acoustic/model";
import { type RecorderDeps, type Recording } from "@/app/lib/audio/recorder";
import { useRecorder, type UseRecorder } from "@/app/lib/audio/useRecorder";
import { g2pPhrase, type Pronunciation } from "@/app/lib/phonology/g2p";
import { groupByWord, type WordFeedback } from "@/app/lib/phonology/feedback";
import { scoreUtterance, summarise, type PhoneScore } from "@/app/lib/phonology/gop";

export type ModelState = "idle" | "loading" | "ready" | "failed";

export interface ModelStatus {
  state: ModelState;
  /** Bytes of the weights received and expected. Both 0 until the download starts. */
  received: number;
  total: number;
  error: string | null;
}

export interface Attempt {
  /** Every phone, in spoken order — what gets filed on the review row. */
  phones: PhoneScore[];
  /** The same scores folded back onto words and syllables, for the display. */
  words: WordFeedback[];
  /** `summarise().score`: share of phones clean, near misses half. */
  score: number;
  /** The weakest phone. What the headline talks about. */
  worst: PhoneScore | null;
  /** The untrimmed take, so the learner can hear what the model heard. */
  audio: Recording;
}

export interface UsePronunciation {
  model: ModelStatus;
  recorder: UseRecorder;
  /** True between the release and the score arriving — about a second (§13.2). */
  scoring: boolean;
  /** The last attempt, or `null` before the first one and after `reset`. */
  attempt: Attempt | null;
  /** Anything that went wrong, phrased for a learner. */
  error: string | null;
  /** Download the weights and open the mic. Call from a gesture; idempotent. */
  arm(): Promise<void>;
  start(): void;
  /** Release: stop recording, score against `spanish`, and return the attempt. */
  stop(spanish: string): Promise<Attempt | null>;
  /** Drop the current attempt, ready for the next card. */
  reset(): void;
}

export interface PronunciationDeps {
  load?: (options?: LoadOptions) => Promise<AcousticModel>;
  recorder?: Partial<RecorderDeps>;
}

/**
 * G2P for a card face, with the failure turned into a value.
 *
 * Exported because the page needs to know *before* offering the record button
 * whether this card can be scored at all — a card the aligner has no target
 * for should say so up front rather than after the learner has said it.
 */
export function prepare(spanish: string): { words: Pronunciation[]; error: string | null } {
  try {
    const words = g2pPhrase(spanish);
    if (words.length === 0 || words.every((w) => w.phones.length === 0)) {
      return { words: [], error: "There's nothing here to pronounce." };
    }
    return { words, error: null };
  } catch (thrown) {
    return {
      words: [],
      error: thrown instanceof Error ? thrown.message : "This card can't be scored.",
    };
  }
}

export function usePronunciation(deps: PronunciationDeps = {}): UsePronunciation {
  const load = deps.load ?? loadAcousticModel;
  const recorder = useRecorder(deps.recorder ?? {});

  const [model, setModel] = useState<ModelStatus>({
    state: "idle",
    received: 0,
    total: 0,
    error: null,
  });
  const [scoring, setScoring] = useState(false);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The handle, and the in-flight load. Held in a ref rather than state
  // because nothing renders differently for *which* model is loaded, and
  // because `arm` has to be idempotent across the two calls StrictMode makes.
  const held = useRef<AcousticModel | null>(null);
  const loading = useRef<Promise<AcousticModel> | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      held.current?.close();
      held.current = null;
      loading.current = null;
    };
  }, []);

  const ensureModel = useCallback(async (): Promise<AcousticModel> => {
    if (held.current) return held.current;
    loading.current ??= (async () => {
      setModel({ state: "loading", received: 0, total: 0, error: null });
      try {
        const loaded = await load({
          onProgress: (received, total) => {
            if (alive.current) setModel({ state: "loading", received, total, error: null });
          },
        });
        // Unmounted mid-download: the weights are cached either way, but this
        // worker has nobody to talk to.
        if (!alive.current) {
          loaded.close();
          throw new Error("Cancelled.");
        }
        held.current = loaded;
        setModel({ state: "ready", received: 0, total: 0, error: null });
        return loaded;
      } catch (thrown) {
        loading.current = null;
        const message =
          thrown instanceof Error ? thrown.message : "The pronunciation model wouldn't load.";
        if (alive.current) setModel({ state: "failed", received: 0, total: 0, error: message });
        throw new Error(message);
      }
    })();
    return loading.current;
  }, [load]);

  const arm = useCallback(async () => {
    setError(null);
    // In parallel: the mic prompt should appear while the weights download,
    // not after 200 seconds of it.
    const [modelResult] = await Promise.allSettled([ensureModel(), recorder.arm()]);
    if (modelResult.status === "rejected") {
      setError(modelResult.reason instanceof Error ? modelResult.reason.message : String(modelResult.reason));
    }
  }, [ensureModel, recorder]);

  const start = useCallback(() => {
    setError(null);
    setAttempt(null);
    recorder.start();
  }, [recorder]);

  const stop = useCallback(
    async (spanish: string): Promise<Attempt | null> => {
      const recording = await recorder.stop();
      // `useRecorder` has already put the reason in `recorder.error`; a null
      // here means "I didn't hear anything", which is its own message.
      if (!recording) return null;

      const { words, error: g2pError } = prepare(spanish);
      if (g2pError) {
        setError(g2pError);
        return null;
      }

      setScoring(true);
      try {
        const model = await ensureModel();
        const { logProbs, labels, blank } = await model.score(recording.samples);
        const phones = scoreUtterance(
          logProbs,
          words.flatMap((w) => w.phones),
          { labels, blank },
        );
        const { score, worst } = summarise(phones);
        const next: Attempt = { phones, words: groupByWord(words, phones), score, worst, audio: recording };
        if (alive.current) setAttempt(next);
        return next;
      } catch (thrown) {
        const message =
          thrown instanceof Error ? thrown.message : "That attempt couldn't be scored.";
        if (alive.current) setError(message);
        return null;
      } finally {
        if (alive.current) setScoring(false);
      }
    },
    [ensureModel, recorder],
  );

  const reset = useCallback(() => {
    setAttempt(null);
    setError(null);
  }, []);

  return {
    model,
    recorder,
    scoring,
    attempt,
    error: error ?? recorder.error,
    arm,
    start,
    stop,
    reset,
  };
}
