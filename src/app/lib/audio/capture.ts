/**
 * The microphone, opened once and left running.
 *
 * Browser-only plumbing — `getUserMedia`, an `AudioContext` and the worklet —
 * with no arithmetic in it, exactly the way `worker.ts` is plumbing around
 * `session.ts`. `jsdom` has no `AudioContext` (§5), so nothing here is unit
 * tested; everything worth testing was pushed into `trim.ts` and
 * `recorder.ts`, and this module is small enough to read.
 *
 * **The mic stays open between attempts.** Arming costs a permission check and
 * a device start — hundreds of milliseconds during which the hardware is not
 * yet delivering samples — so opening it when the learner presses *record*
 * would clip the first phoneme off every card. It is opened when the
 * pronunciation deck is entered and closed when it is left; `recorder.ts`
 * decides which batches belong to an attempt. It also means the level meter
 * has something to show before recording starts, which is how a learner knows
 * the mic works.
 */

// The built worklet is 3.2 kB, under Vite's 4 kB inline threshold, so without
// `no-inline` it ships as a `data:` URL. Chrome's `addModule` does accept one
// (measured — see §14), but it puts the processor on an opaque origin, hides
// it from devtools, and leans on behaviour the other engines document less
// clearly. A real file is the same thing minus the doubt.
import workletUrl from "./recorder-worklet.js?url&no-inline";

/**
 * All three DSP stages off (§Phase 0a).
 *
 * Browser audio processing is tuned for voice calls. Noise suppression gates
 * quiet fricatives — /s/ and /x/, precisely what is being scored — and
 * automatic gain control moves the level around mid-utterance, which would put
 * a moving target under Phase 5's per-speaker calibration.
 */
export const MIC_CONSTRAINTS: MediaTrackConstraints = {
  channelCount: 1,
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
};

/** How many samples the worklet gathers before posting. ~43 ms at 48 kHz. */
const BATCH_SAMPLES = 2048;

export interface Batch {
  samples: Float32Array;
  /** Loudest magnitude in this batch, for the meter. Not clamped — §10.6 measured 1.1298. */
  peak: number;
  reason: "full" | "flush" | "stop";
}

export interface Microphone {
  /** The hardware rate. Almost never 16 kHz — `resample.ts` deals with that. */
  readonly sampleRate: number;
  /** What the device actually agreed to, per the readback below. */
  readonly settings: MediaTrackSettings;
  /** Constraints the device ignored. Diagnostic, not fatal. */
  readonly warnings: readonly string[];
  onBatch(listener: (batch: Batch) => void): () => void;
  /** Push the partial batch out now, and resolve once it has arrived. */
  flush(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Ask for the mic and start capturing.
 *
 * Throws an `Error` with a message a page can render, per the repo's API
 * convention — a rejected permission is a normal thing for a learner to do and
 * must not read as a crash.
 */
export async function openMicrophone(): Promise<Microphone> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    throw new Error("This browser can't record audio, or the page isn't on a secure origin.");
  }

  const stream = await requestStream();
  const track = stream.getAudioTracks()[0];
  if (!track) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error("The microphone opened without an audio track.");
  }

  const settings = track.getSettings();
  const warnings = constraintWarnings(settings);
  if (warnings.length > 0) console.warn("[audio]", warnings.join(" "));

  const context = new AudioContext({ latencyHint: "interactive" });
  try {
    // Created inside a click in practice, but a suspended context yields no
    // samples at all and the failure looks exactly like a silent room.
    if (context.state === "suspended") await context.resume();
    await context.audioWorklet.addModule(workletUrl);
  } catch (error) {
    stream.getTracks().forEach((t) => t.stop());
    await context.close();
    throw new Error(
      `Couldn't start the audio worklet: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const source = context.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(context, "recorder", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: { batchSamples: BATCH_SAMPLES },
  });

  const listeners = new Set<(batch: Batch) => void>();
  let awaitingFlush: (() => void) | null = null;

  node.port.onmessage = ({ data }: MessageEvent<Batch>) => {
    for (const listener of listeners) listener(data);
    if (data.reason !== "full" && awaitingFlush) {
      awaitingFlush();
      awaitingFlush = null;
    }
  };

  source.connect(node);
  // Chrome will not pull a worklet that reaches no sink (§10.6), so the node
  // has to be connected even though we only want its input. It is silent by
  // construction: `process` never writes to `outputs`.
  node.connect(context.destination);

  return {
    sampleRate: context.sampleRate,
    settings,
    warnings,
    onBatch(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    flush() {
      return new Promise<void>((resolve) => {
        awaitingFlush = resolve;
        node.port.postMessage("flush");
      });
    },
    async close() {
      node.port.postMessage("stop");
      listeners.clear();
      awaitingFlush = null;
      source.disconnect();
      node.disconnect();
      // The track has to be stopped explicitly or the browser's recording
      // indicator stays lit after the deck is left.
      stream.getTracks().forEach((t) => t.stop());
      await context.close();
    },
  };
}

async function requestStream(): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: MIC_CONSTRAINTS, video: false });
  } catch (error) {
    throw new Error(micErrorMessage(error));
  }
}

/** `DOMException.name` is the only reliable part of a `getUserMedia` failure. */
function micErrorMessage(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Microphone access was blocked. Allow it for this site and try again.";
    case "NotFoundError":
    case "OverconstrainedError":
      return "No microphone was found.";
    case "NotReadableError":
      return "The microphone is busy in another app.";
    default:
      return `Couldn't open the microphone: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Read the constraints back (§10.6).
 *
 * The spike found `channelCount: 1` silently ignored on Chrome's fake capture
 * device — the constraint object is a request, not a guarantee. None of these
 * is fatal (the worklet downmixes whatever arrives, and scoring still works
 * with AGC on), but a mysteriously bad score six weeks from now is much easier
 * to explain with this in the console. A setting the browser does not report
 * at all is left alone: absent is not the same as wrong.
 */
export function constraintWarnings(settings: MediaTrackSettings): string[] {
  const warnings: string[] = [];
  if (settings.channelCount !== undefined && settings.channelCount !== 1) {
    warnings.push(`Mic gave ${settings.channelCount} channels, not 1; downmixing.`);
  }
  for (const key of ["echoCancellation", "noiseSuppression", "autoGainControl"] as const) {
    if (settings[key] === true) warnings.push(`${key} is on despite being switched off.`);
  }
  return warnings;
}
