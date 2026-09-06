/**
 * The capture worklet: it runs on the audio render thread, batches the render
 * quanta it is handed, and posts them to the main thread.
 *
 * Plain JavaScript, and it must stay that way. `capture.ts` loads it with
 * Vite's `?url`, which emits the file as an asset *verbatim* — no transpile
 * step and no bundling, because `audioWorklet.addModule` fetches a URL rather
 * than importing a module into the app's graph. A `.ts` file here would ship
 * TypeScript to the browser and fail at the first type annotation.
 *
 * **Why batches over `postMessage` and not a `SharedArrayBuffer` ring.** The
 * textbook answer is a lock-free ring in shared memory, and it is unavailable
 * here for the same reason ORT runs single-threaded (§13.4): `SharedArrayBuffer`
 * needs the page cross-origin isolated (`COOP`/`COEP`), which the Vite dev
 * server does not send. So the ring is *inside* this processor — a fixed
 * buffer that fills and is posted — and the transfer replaces the shared
 * memory. At 2048 samples that is one message every ~43 ms at 48 kHz, which
 * is nothing next to the 197 MB model.
 *
 * Messages in: "flush" (post the partial buffer), "stop" (post it and end).
 * Messages out: `{ samples, peak, reason }`, where `reason` is "full",
 * "flush" or "stop". The main thread needs to tell a spontaneous batch from
 * the answer to its own flush, or it would take a buffer that happened to
 * fill first as the tail of the recording and drop the rest.
 */

class RecorderProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { batchSamples = 2048 } = options.processorOptions || {};
    this.buffer = new Float32Array(batchSamples);
    this.at = 0;
    this.peak = 0;
    this.running = true;
    this.port.onmessage = (event) => {
      if (event.data === "flush") {
        this.flush("flush");
      } else if (event.data === "stop") {
        this.flush("stop");
        this.running = false;
      }
    };
  }

  flush(reason) {
    const samples = this.buffer.slice(0, this.at);
    const peak = this.peak;
    this.at = 0;
    this.peak = 0;
    this.port.postMessage({ samples, peak, reason }, [samples.buffer]);
  }

  process(inputs) {
    const input = inputs[0];
    // An input with no channels is a disconnected node, not an error — and it
    // must not end the processor, or reconnecting would go silent.
    if (!input || input.length === 0 || !input[0]) return this.running;

    const channels = input.length;
    const block = input[0].length;

    for (let i = 0; i < block; i += 1) {
      // Downmix here rather than trusting `channelCount: 1`: §10.6 measured
      // the constraint being silently ignored (two channels came back), and
      // taking only channel 0 would then throw away half the room.
      let sum = 0;
      for (let c = 0; c < channels; c += 1) sum += input[c][i];
      const value = sum / channels;

      const magnitude = value < 0 ? -value : value;
      if (magnitude > this.peak) this.peak = magnitude;

      this.buffer[this.at] = value;
      this.at += 1;
      if (this.at === this.buffer.length) this.flush("full");
    }

    return this.running;
  }
}

registerProcessor("recorder", RecorderProcessor);
