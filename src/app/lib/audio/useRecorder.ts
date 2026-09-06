/**
 * `createRecorder` as a hook, and nothing more.
 *
 * All the behaviour is in `recorder.ts` — which is what lets it be tested
 * without a browser — so this is the React seam: one instance per mount, a
 * re-render when the state machine moves, the mic closed on unmount, and
 * errors turned into a string a page can render instead of an exception a
 * component has to catch mid-press.
 *
 * The level is deliberately *not* in state. It changes every ~43 ms, and a
 * re-render at that rate during a recording is the mistake `FlashCard`
 * documents at length: read `level` from a `requestAnimationFrame` loop and
 * write the meter's style directly.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { createRecorder, type Recorder, type RecorderDeps, type Recording, type RecorderState } from "./recorder";

export interface UseRecorder {
  state: RecorderState;
  /** The last failure, already phrased for a learner. Cleared when the next attempt starts. */
  error: string | null;
  /** Live input peak, 0..~1. Read it in rAF, never in render. */
  level: { current: number };
  /** Constraints the device ignored (§10.6). Worth surfacing in a debug corner, not in the UI. */
  warnings: readonly string[];
  arm(): Promise<void>;
  start(): void;
  /** `null` when the attempt failed — the reason is in `error`. */
  stop(): Promise<Recording | null>;
  cancel(): void;
}

export function useRecorder(deps: Partial<RecorderDeps> = {}): UseRecorder {
  // One recorder per mount, created lazily so that merely rendering a page
  // does not touch Web Audio. `deps` is read once on purpose: swapping the
  // microphone under a live recorder is not a thing that should typecheck.
  const held = useRef<Recorder | null>(null);
  held.current ??= createRecorder(deps);
  const recorder = held.current;

  const [error, setError] = useState<string | null>(null);

  const subscribe = useCallback((notify: () => void) => recorder.onStateChange(notify), [recorder]);
  const state = useSyncExternalStore(subscribe, () => recorder.state);

  useEffect(
    () => () => {
      // `StrictMode` runs this on the throwaway first mount too. Harmless:
      // nothing is open until `arm()`, which only ever happens from a press,
      // and closing an unarmed recorder is a no-op.
      void recorder.close();
    },
    [recorder],
  );

  const report = useCallback((thrown: unknown): null => {
    setError(thrown instanceof Error ? thrown.message : "The microphone stopped working.");
    return null;
  }, []);

  return {
    state,
    error,
    level: recorder.level,
    warnings: recorder.warnings,

    arm: useCallback(async () => {
      setError(null);
      try {
        await recorder.arm();
      } catch (thrown) {
        report(thrown);
      }
    }, [recorder, report]),

    start: useCallback(() => {
      setError(null);
      try {
        recorder.start();
      } catch (thrown) {
        report(thrown);
      }
    }, [recorder, report]),

    stop: useCallback(async () => {
      try {
        return await recorder.stop();
      } catch (thrown) {
        return report(thrown);
      }
    }, [recorder, report]),

    cancel: useCallback(() => {
      setError(null);
      recorder.cancel();
    }, [recorder]),
  };
}
