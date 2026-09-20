import { describe, expect, it, vi } from "vitest";

import { chooseBackend, loadAcousticBackend, routeBackend, type BackendEnv } from "./backend";
import { type AcousticModel } from "./model";

const SCORER = "https://scorer.example";

const env = (over: Partial<BackendEnv> = {}): BackendEnv => ({
  scorerUrl: SCORER,
  deviceMemoryGb: 16,
  preference: null,
  ...over,
});

const fakeModel = (): AcousticModel => ({
  labels: ["<pad>"],
  blank: 0,
  sampleRate: 16_000,
  score: async () => {
    throw new Error("not used");
  },
  close: () => {},
});

describe("chooseBackend", () => {
  it("stays on the device when no scorer is configured", () => {
    // The pre-§19 behaviour, and what an unconfigured checkout gets.
    expect(chooseBackend(env({ scorerUrl: "", deviceMemoryGb: 2 }))).toBe("device");
    expect(chooseBackend(env({ scorerUrl: "", preference: "scorer" }))).toBe("device");
  });

  it("sends a small device to the scorer", () => {
    expect(chooseBackend(env({ deviceMemoryGb: 4 }))).toBe("scorer");
    expect(chooseBackend(env({ deviceMemoryGb: 2 }))).toBe("scorer");
  });

  it("keeps a roomy device on-device", () => {
    expect(chooseBackend(env({ deviceMemoryGb: 8 }))).toBe("device");
  });

  it("stays on the device when the browser won't say — Safari and Firefox don't", () => {
    // This is the case rule 3 exists to catch: an old iPhone looks identical
    // to a new laptop from here, so the fallback has to happen on failure.
    expect(chooseBackend(env({ deviceMemoryGb: undefined }))).toBe("device");
  });

  it("lets an explicit preference beat the heuristic, both ways", () => {
    expect(chooseBackend(env({ deviceMemoryGb: 16, preference: "scorer" }))).toBe("scorer");
    expect(chooseBackend(env({ deviceMemoryGb: 2, preference: "device" }))).toBe("device");
  });
});

describe("loadAcousticBackend", () => {
  it("falls back to the scorer when the device can't load the model", async () => {
    const loadDevice = vi.fn().mockRejectedValue(new Error("Out of memory"));
    const loadScorer = vi.fn().mockResolvedValue(fakeModel());
    const onBackend = vi.fn();

    await loadAcousticBackend({ env: env(), loadDevice, loadScorer, onBackend });

    expect(loadDevice).toHaveBeenCalled();
    expect(loadScorer).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: SCORER }));
    expect(onBackend.mock.calls.map(([b]) => b)).toEqual(["device", "scorer"]);
  });

  it("rethrows the device's failure when there is no scorer to fall back to", async () => {
    const loadDevice = vi.fn().mockRejectedValue(new Error("Out of memory"));
    const loadScorer = vi.fn();

    await expect(
      loadAcousticBackend({ env: env({ scorerUrl: "" }), loadDevice, loadScorer }),
    ).rejects.toThrow("Out of memory");
    expect(loadScorer).not.toHaveBeenCalled();
  });

  it("doesn't touch the device path at all on a small device", async () => {
    const loadDevice = vi.fn();
    const loadScorer = vi.fn().mockResolvedValue(fakeModel());

    await loadAcousticBackend({ env: env({ deviceMemoryGb: 3 }), loadDevice, loadScorer });

    // The whole point: no 197 MB download is even attempted on a phone that
    // cannot hold it.
    expect(loadDevice).not.toHaveBeenCalled();
    expect(loadScorer).toHaveBeenCalled();
  });
});

describe("routeBackend", () => {
  it("records why, because that decides what happens when it fails", () => {
    expect(routeBackend(env({ scorerUrl: "" }))).toEqual({
      backend: "device",
      reason: "no-scorer",
    });
    expect(routeBackend(env({ deviceMemoryGb: 3 }))).toEqual({
      backend: "scorer",
      reason: "small-device",
    });
    expect(routeBackend(env({ preference: "scorer" }))).toEqual({
      backend: "scorer",
      reason: "preference",
    });
    expect(routeBackend(env({ deviceMemoryGb: undefined }))).toEqual({
      backend: "device",
      reason: "default",
    });
  });
});

describe("loadAcousticBackend when the box is down", () => {
  const down = () => new Error("Couldn't reach the pronunciation scorer.");

  it("falls back to the device when the scorer was only a preference", async () => {
    // The Oracle box is Always Free and behind a tunnel; §19.6 says one box,
    // no failover. A laptop that opted in should not lose the feature with it.
    const loadDevice = vi.fn().mockResolvedValue(fakeModel());
    const loadScorer = vi.fn().mockRejectedValue(down());
    const onBackend = vi.fn();

    await loadAcousticBackend({
      env: env({ preference: "scorer" }),
      loadDevice,
      loadScorer,
      onBackend,
    });

    expect(loadScorer).toHaveBeenCalled();
    expect(loadDevice).toHaveBeenCalled();
    expect(onBackend.mock.calls.map(([b]) => b)).toEqual(["scorer", "device"]);
  });

  it("does not hand 197 MB to a device the browser already called too small", async () => {
    // The asymmetry that survives: attempting the cold download here does not
    // fail politely, it takes the tab (§19.6).
    const loadDevice = vi.fn();
    const loadScorer = vi.fn().mockRejectedValue(down());

    await expect(
      loadAcousticBackend({ env: env({ deviceMemoryGb: 3 }), loadDevice, loadScorer }),
    ).rejects.toThrow(/doesn't have the memory/);

    expect(loadDevice).not.toHaveBeenCalled();
  });

  it("says so plainly when neither path works", async () => {
    const loadDevice = vi.fn().mockRejectedValue(new Error("Out of memory"));
    const loadScorer = vi.fn().mockRejectedValue(down());

    await expect(
      loadAcousticBackend({ env: env({ preference: "scorer" }), loadDevice, loadScorer }),
    ).rejects.toThrow(/Pronunciation is unavailable/);
  });
});
