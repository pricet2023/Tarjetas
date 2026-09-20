/**
 * Which of the two `AcousticModel` implementations this device should use.
 *
 * The hybrid is the whole design (§19.1): the laptop keeps the on-device path
 * and the property that made the feature worth building, and a phone that
 * cannot hold 197 MB resident gets a working feature instead of a killed tab.
 * Both satisfy the same interface, so this file is the only place that knows
 * there is a choice at all.
 *
 * Three ways the choice gets made, in order:
 *
 *   1. **An explicit preference**, stored per device. A setting, because the
 *      heuristic below cannot see everything — an old iPhone reports no memory
 *      at all — and because "why is this slow on my laptop" deserves an answer
 *      the learner can act on.
 *   2. **`navigator.deviceMemory`**, when the browser has it. Chrome and the
 *      Android WebView do; Safari and Firefox do not, and report `undefined`.
 *      So this catches the Samsung and misses the old iPhone, which is why
 *      (3) exists.
 *   3. **Failure.** Either path failing falls through to the other, because a
 *      slow verdict beats an absent one. The one exception is the device the
 *      heuristic positively identified as too small — see `routeBackend`.
 *
 * With no scorer configured (`VITE_SCORER_URL` unset) every branch collapses
 * to the device path, which is exactly the behaviour before §19.
 */

import { loadAcousticModel, type AcousticModel, type LoadOptions } from "./model";
import { loadRemoteAcousticModel, type RemoteOptions } from "./remote";

export type Backend = "device" | "scorer";

/**
 * Why a backend was chosen, which is what decides whether the *other* one is
 * worth trying when it fails.
 *
 * Only `small-device` is a real verdict about capability: the browser said
 * this machine has 4 GB or less, and §19.6's ~394 MB cold peak is what kills
 * that tab. Every other reason is a guess or a preference, and a guess that
 * has just been proved wrong should be retried the other way.
 */
export type RouteReason = "no-scorer" | "preference" | "small-device" | "default";

export interface Route {
  backend: Backend;
  reason: RouteReason;
}

/** Devices reporting this many GB or fewer are sent to the scorer. */
const SMALL_DEVICE_GB = 4;

const PREFERENCE_KEY = "flash-cards:acoustic-backend";

export interface BackendEnv {
  /** `VITE_SCORER_URL`, or "" when no scorer is configured. */
  scorerUrl?: string;
  /** `navigator.deviceMemory` in GB, `undefined` where the browser omits it. */
  deviceMemoryGb?: number;
  /** The stored preference, if the learner set one. */
  preference?: Backend | null;
}

export function readEnv(): BackendEnv {
  return {
    scorerUrl: import.meta.env.VITE_SCORER_URL ?? "",
    deviceMemoryGb: (navigator as { deviceMemory?: number }).deviceMemory,
    preference: readPreference(),
  };
}

export function readPreference(): Backend | null {
  try {
    const stored = localStorage.getItem(PREFERENCE_KEY);
    return stored === "device" || stored === "scorer" ? stored : null;
  } catch {
    // Private windows throw on access rather than returning null.
    return null;
  }
}

export function writePreference(backend: Backend | null): void {
  try {
    if (backend === null) localStorage.removeItem(PREFERENCE_KEY);
    else localStorage.setItem(PREFERENCE_KEY, backend);
  } catch {
    // Not being able to remember the choice is not a reason to refuse it.
  }
}

/** Rules 1 and 2, with the reason kept. Rule 3 lives in `loadAcousticBackend`. */
export function routeBackend(env: BackendEnv): Route {
  if (!env.scorerUrl) return { backend: "device", reason: "no-scorer" };
  if (env.preference) return { backend: env.preference, reason: "preference" };
  if (env.deviceMemoryGb !== undefined && env.deviceMemoryGb <= SMALL_DEVICE_GB) {
    return { backend: "scorer", reason: "small-device" };
  }
  return { backend: "device", reason: "default" };
}

/** Just the verdict, for callers that do not care why. */
export function chooseBackend(env: BackendEnv): Backend {
  return routeBackend(env).backend;
}

export interface BackendOptions extends LoadOptions {
  env?: BackendEnv;
  /** Injected by tests, and by `usePronunciation`'s own dependency seam. */
  loadDevice?: (options?: LoadOptions) => Promise<AcousticModel>;
  loadScorer?: (options?: RemoteOptions) => Promise<AcousticModel>;
  /** Told which way it went, so the UI can say so. */
  onBackend?: (backend: Backend) => void;
}

/**
 * The default `load` for `usePronunciation`.
 *
 * Signature-compatible with `loadAcousticModel`, so swapping it in was a
 * one-word change at the call site.
 *
 * Failure falls through in *both* directions, which is the §19.6 "one box with
 * no failover" note taken seriously: the box is an Always Free instance behind
 * a tunnel, and when it is gone a device that can run the model itself should
 * just run the model itself. The asymmetry that remains is deliberate — a
 * device the browser reports as 4 GB or less is not offered the 197 MB it has
 * already been judged unable to hold, because attempting it does not fail
 * politely, it takes the tab.
 */
export async function loadAcousticBackend({
  env = readEnv(),
  loadDevice = loadAcousticModel,
  loadScorer = loadRemoteAcousticModel,
  onBackend,
  ...options
}: BackendOptions = {}): Promise<AcousticModel> {
  const route = routeBackend(env);

  const device = (): Promise<AcousticModel> => {
    onBackend?.("device");
    return loadDevice(options);
  };

  const remote = (): Promise<AcousticModel> => {
    onBackend?.("scorer");
    return loadScorer({
      baseUrl: env.scorerUrl,
      source: options.source,
      authorization: accessToken,
    });
  };

  if (route.backend === "device") {
    try {
      return await device();
    } catch (thrown) {
      if (route.reason === "no-scorer") throw thrown;
      // The device said no — out of memory, out of quota, or a wasm
      // instantiation that could not get its heap. Anything the scorer can
      // still answer is better than a dead feature, so try it before giving up.
      console.warn("[acoustic] the device couldn't load the model; using the scorer:", thrown);
      try {
        return await remote();
      } catch (remoteThrown) {
        throw new Error(bothFailed(thrown, remoteThrown));
      }
    }
  }

  try {
    return await remote();
  } catch (thrown) {
    if (route.reason === "small-device") {
      // The heuristic caught this one on purpose. Falling back here would
      // hand a 3 GB phone the ~394 MB cold peak that §19.6 says kills it, so
      // the honest answer is better than the crash.
      throw new Error(
        `${message(thrown)} This device doesn't have the memory to run the model itself, ` +
          "so pronunciation is unavailable until the scorer is back.",
      );
    }
    // Routed here by a preference or by a browser that wouldn't say how much
    // memory it has. Neither is evidence the device can't cope, so let it try.
    console.warn("[acoustic] the scorer didn't answer; trying the device:", thrown);
    try {
      return await device();
    } catch (deviceThrown) {
      throw new Error(bothFailed(deviceThrown, thrown));
    }
  }
}

/** Both paths are gone, which is the one case worth saying out loud. */
function bothFailed(deviceThrown: unknown, remoteThrown: unknown): string {
  return (
    "Pronunciation is unavailable: the scorer didn't answer and this device couldn't " +
    `load the model either (${message(remoteThrown)} ${message(deviceThrown)})`
  );
}

function message(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}

/**
 * The bearer token for the scorer, read per request.
 *
 * `getSession` refreshes an expired token rather than handing back the stale
 * one, which matters because a study session comfortably outlives an access
 * token and the failure would otherwise be a 401 twenty cards in.
 *
 * Imported here rather than at the top of the file on purpose. `supabase.ts`
 * throws at module scope when `VITE_SUPABASE_URL` is unset, so a static import
 * would make *loading* this module require a configured project — which is not
 * true of anything it does except this function, and which breaks any test
 * that reaches `usePronunciation` without an `.env`.
 */
async function accessToken(): Promise<string | null> {
  const { supabase } = await import("@/app/lib/supabase");
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}
