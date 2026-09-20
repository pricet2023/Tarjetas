import { describe, expect, it, vi } from "vitest";

import { ACOUSTIC_SOURCE, FRAMES_HEADER, VOCAB_HEADER } from "./protocol";
import { loadRemoteAcousticModel } from "./remote";

/**
 * A scorer made of nothing.
 *
 * Same idea as `model.test.ts`'s `FakePort`: the part worth testing is not
 * ONNX, it is the plumbing — the shape assertions that stop a mismatched
 * server scoring against the wrong calibration, and the failures turned into
 * sentences a page can render (repo convention).
 */
const LABELS = ["<pad>", "p", "e", "r", "o"];

const info = (over: Record<string, unknown> = {}) => ({
  id: ACOUSTIC_SOURCE.id,
  labels: LABELS,
  blank: 0,
  vocabSize: LABELS.length,
  sampleRate: 16_000,
  ...over,
});

const matrix = (frames: number, vocabSize = LABELS.length) =>
  new Response(new Float32Array(frames * vocabSize).buffer, {
    status: 200,
    headers: { [FRAMES_HEADER]: String(frames), [VOCAB_HEADER]: String(vocabSize) },
  });

/** A fetch that answers `/model` from `described` and `/score` from `scored`. */
function fakeFetch(described: unknown, scored: () => Response | Promise<Response>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/model")) {
      return described instanceof Response
        ? described
        : new Response(JSON.stringify(described), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
    }
    return scored();
  }) as unknown as typeof fetch;
}

const audio = (n = 800): Float32Array => Float32Array.from({ length: n }, (_, i) => i / n);

describe("loadRemoteAcousticModel", () => {
  it("scores, and reports the matrix the server sent", async () => {
    const model = await loadRemoteAcousticModel({
      fetchImpl: fakeFetch(info(), () => matrix(30)),
    });

    expect(model.labels).toEqual(LABELS);
    expect(model.blank).toBe(0);

    const { logProbs, labels, blank } = await model.score(audio());
    expect(logProbs.frames).toBe(30);
    expect(logProbs.vocabSize).toBe(LABELS.length);
    expect(logProbs.data).toHaveLength(30 * LABELS.length);
    expect(labels).toEqual(LABELS);
    expect(blank).toBe(0);
  });

  it("sends the audio as a float32 body, and the sample rate in the query", async () => {
    const fetchImpl = fakeFetch(info(), () => matrix(4));
    const model = await loadRemoteAcousticModel({ fetchImpl });
    await model.score(audio(400));

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(String(url)).toContain("rate=16000");
    expect((init.body as Float32Array).byteLength).toBe(400 * 4);
  });

  it("refuses a server running a different build", async () => {
    // The failure this prevents is silent: a server on last month's weights
    // returns labels that align fine and score against the wrong native stats.
    await expect(
      loadRemoteAcousticModel({ fetchImpl: fakeFetch(info({ id: "something-else" }), () => matrix(4)) }),
    ).rejects.toThrow(/running "something-else"/);
  });

  it("refuses a blank outside the server's own labels", async () => {
    await expect(
      loadRemoteAcousticModel({ fetchImpl: fakeFetch(info({ blank: 99 }), () => matrix(4)) }),
    ).rejects.toThrow(/CTC blank at row 99/);
  });

  it("rejects a body that doesn't match the shape the headers promised", async () => {
    const short = () =>
      new Response(new Float32Array(3).buffer, {
        status: 200,
        headers: { [FRAMES_HEADER]: "30", [VOCAB_HEADER]: String(LABELS.length) },
      });
    const model = await loadRemoteAcousticModel({ fetchImpl: fakeFetch(info(), short) });
    await expect(model.score(audio())).rejects.toThrow(/30×5 log-probs and sent 12 bytes/);
  });

  it("rejects a matrix whose width disagrees with the label list", async () => {
    const model = await loadRemoteAcousticModel({
      fetchImpl: fakeFetch(info(), () => matrix(10, 7)),
    });
    await expect(model.score(audio())).rejects.toThrow(/do not belong together/);
  });

  it("refuses to resample", async () => {
    const model = await loadRemoteAcousticModel({ fetchImpl: fakeFetch(info(), () => matrix(4)) });
    await expect(model.score(audio(), 44_100)).rejects.toThrow(/Resample before scoring/);
  });

  it("turns a 401 into something a learner can act on", async () => {
    const model = await loadRemoteAcousticModel({
      fetchImpl: fakeFetch(info(), () => new Response("", { status: 401 })),
    });
    await expect(model.score(audio())).rejects.toThrow(/signed in/);
  });

  it("prefers the server's own message over the status line", async () => {
    const explained = () =>
      new Response(JSON.stringify({ error: "That was too quiet to score." }), { status: 422 });
    const model = await loadRemoteAcousticModel({ fetchImpl: fakeFetch(info(), explained) });
    await expect(model.score(audio())).rejects.toThrow("That was too quiet to score.");
  });

  it("attaches a bearer token when one is available", async () => {
    const fetchImpl = fakeFetch(info(), () => matrix(4));
    const model = await loadRemoteAcousticModel({
      fetchImpl,
      authorization: async () => "token-abc",
    });
    await model.score(audio());

    for (const [, init] of (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls) {
      expect((init.headers as Headers).get("Authorization")).toBe("Bearer token-abc");
    }
  });

  it("asks for a fresh token per request, because sessions outlive them", async () => {
    const authorization = vi.fn().mockResolvedValueOnce("first").mockResolvedValue("second");
    const fetchImpl = fakeFetch(info(), () => matrix(4));
    const model = await loadRemoteAcousticModel({ fetchImpl, authorization });
    await model.score(audio());
    await model.score(audio());
    expect(authorization).toHaveBeenCalledTimes(3);
  });

  it("does not neuter the caller's audio — Phase 7 plays it back", async () => {
    const model = await loadRemoteAcousticModel({ fetchImpl: fakeFetch(info(), () => matrix(4)) });
    const samples = audio();
    await model.score(samples);
    expect(samples).toHaveLength(800);
    expect(samples[10]).toBeCloseTo(10 / 800);
  });

  it("stops in-flight work when closed", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/model")) {
        return new Response(JSON.stringify(info()), { status: 200 });
      }
      // A real `fetch` rejects immediately on an already-aborted signal, and
      // that is the case under test: `close()` lands while `score` is still
      // awaiting its bearer token, so the signal is aborted before the
      // request is ever issued.
      const abort = () => new DOMException("aborted", "AbortError");
      if (init?.signal?.aborted) throw abort();
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(abort()));
      });
    }) as unknown as typeof fetch;

    const model = await loadRemoteAcousticModel({ fetchImpl });
    const pending = model.score(audio());
    model.close();
    await expect(pending).rejects.toThrow(/closed/);
  });
});
