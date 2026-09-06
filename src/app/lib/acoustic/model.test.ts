import { describe, expect, it, vi } from "vitest";

import { loadAcousticModel } from "./model";
import { type AcousticPort, type AcousticRequest, type AcousticResponse } from "./protocol";

/**
 * A worker made of nothing.
 *
 * `jsdom` has no `Worker`, and the part worth testing is not ONNX — it is the
 * plumbing: replies matched to the attempt that asked, failures raised as
 * `Error`s a page can render (repo convention), and the caller's audio buffer
 * surviving the transfer.
 */
class FakePort implements AcousticPort {
  sent: AcousticRequest[] = [];
  transfers: (Transferable[] | undefined)[] = [];
  terminated = false;
  private onMessage: ((event: MessageEvent<AcousticResponse>) => void)[] = [];
  private onError: ((event: unknown) => void)[] = [];

  postMessage(message: AcousticRequest, transfer?: Transferable[]): void {
    this.sent.push(message);
    this.transfers.push(transfer);
  }

  addEventListener(type: "message", listener: (event: MessageEvent<AcousticResponse>) => void): void;
  addEventListener(type: "error", listener: (event: unknown) => void): void;
  addEventListener(type: "message" | "error", listener: (event: any) => void): void {
    if (type === "message") this.onMessage.push(listener);
    else this.onError.push(listener);
  }

  terminate(): void {
    this.terminated = true;
  }

  reply(response: AcousticResponse): void {
    for (const listener of this.onMessage) listener({ data: response } as MessageEvent<AcousticResponse>);
  }

  crash(): void {
    for (const listener of this.onError) listener(new Error("worker died"));
  }
}

const LABELS = ["<pad>", "p", "e", "r", "o"];

/** Load a model against a fake worker that reports itself ready. */
async function loaded(port = new FakePort(), onProgress?: (r: number, t: number) => void) {
  const pending = loadAcousticModel({ port, onProgress });
  port.reply({ kind: "ready", labels: LABELS, blank: 0, vocabSize: LABELS.length });
  return { port, model: await pending };
}

const audio = (n = 800): Float32Array => Float32Array.from({ length: n }, (_, i) => i / n);

const scored = (id: number, frames: number): AcousticResponse => ({
  kind: "scored",
  id,
  logProbs: new Float32Array(frames * LABELS.length),
  frames,
  vocabSize: LABELS.length,
});

describe("loadAcousticModel", () => {
  it("asks the worker to load, then reports the labels and the blank", async () => {
    const port = new FakePort();
    const pending = loadAcousticModel({ port });
    expect(port.sent[0].kind).toBe("load");

    port.reply({ kind: "ready", labels: LABELS, blank: 0, vocabSize: LABELS.length });
    const model = await pending;

    expect(model.labels).toEqual(LABELS);
    expect(model.blank).toBe(0);
    expect(model.sampleRate).toBe(16000);
  });

  it("reports download progress", async () => {
    const onProgress = vi.fn();
    const port = new FakePort();
    const pending = loadAcousticModel({ port, onProgress });
    port.reply({ kind: "progress", received: 50, total: 200 });
    port.reply({ kind: "ready", labels: LABELS, blank: 0, vocabSize: LABELS.length });
    await pending;
    expect(onProgress).toHaveBeenCalledWith(50, 200);
  });

  it("hands back the posterior matrix with the labels to read it", async () => {
    const { port, model } = await loaded();
    const pending = model.score(audio());
    port.reply(scored(1, 30));

    const { logProbs, labels, blank } = await pending;
    expect(logProbs.frames).toBe(30);
    expect(logProbs.vocabSize).toBe(LABELS.length);
    expect(logProbs.data.length).toBe(30 * LABELS.length);
    // The two arguments the aligner needs, from one call — the §Phase 3
    // deliverable.
    expect(labels).toEqual(LABELS);
    expect(blank).toBe(0);
  });

  it("copies the caller's audio rather than transferring it away", async () => {
    // Phase 7 wants to play the attempt back, so neutering the buffer the UI
    // still holds would be a nasty bug to find later.
    const { port, model } = await loaded();
    const samples = audio();
    void model.score(samples);

    const request = port.sent.at(-1);
    expect(request?.kind).toBe("score");
    expect(samples.length).toBe(800);
    if (request?.kind === "score") {
      expect(request.samples).not.toBe(samples);
      expect(port.transfers.at(-1)).toEqual([request.samples.buffer]);
    }
  });

  it("matches replies to attempts, whatever order they come back in", async () => {
    const { port, model } = await loaded();
    const first = model.score(audio());
    const second = model.score(audio());

    port.reply(scored(2, 99));
    port.reply(scored(1, 30));

    expect((await first).logProbs.frames).toBe(30);
    expect((await second).logProbs.frames).toBe(99);
  });

  it("passes the sample rate through so the worker can refuse the wrong one", async () => {
    const { port, model } = await loaded();
    void model.score(audio(), 44100);
    const request = port.sent.at(-1);
    expect(request?.kind === "score" && request.sampleRate).toBe(44100);
  });

  it("raises a scoring failure on the attempt that failed, and only that one", async () => {
    const { port, model } = await loaded();
    const doomed = model.score(audio());
    const fine = model.score(audio());

    port.reply({ kind: "failed", id: 1, message: "The recording was too short to score." });
    port.reply(scored(2, 40));

    await expect(doomed).rejects.toThrow(/too short to score/);
    expect((await fine).logProbs.frames).toBe(40);
  });

  it("raises a load failure as an error the page can render", async () => {
    // `id: null` means nothing will ever work — no attempt to blame.
    const port = new FakePort();
    const pending = loadAcousticModel({ port });
    port.reply({ kind: "failed", id: null, message: "Couldn't download the pronunciation model (404 Not Found)." });
    await expect(pending).rejects.toThrow(/Couldn't download the pronunciation model/);
  });

  it("raises a worker crash", async () => {
    const port = new FakePort();
    const pending = loadAcousticModel({ port });
    port.crash();
    await expect(pending).rejects.toThrow(/crashed/);
  });

  it("terminates the worker on close, and gives up on anything in flight", async () => {
    const { port, model } = await loaded();
    const abandoned = model.score(audio());
    model.close();

    expect(port.terminated).toBe(true);
    await expect(abandoned).rejects.toThrow(/closed/);
  });
});
