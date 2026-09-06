import { describe, expect, it } from "vitest";

import { readFixtureWav } from "@/app/lib/acoustic/fixtures/read";

import { decodeWav } from "./wav";

interface WavSpec {
  samples: number[];
  channels?: number;
  sampleRate?: number;
  bits?: number;
  format?: number;
  /** A chunk to slip between `fmt ` and `data`, as real files do. */
  extra?: { id: string; body: number[] };
}

/** Assemble a WAV byte for byte, so the decoder is tested against a file and not itself. */
function wavFile({
  samples,
  channels = 1,
  sampleRate = 16000,
  bits = 16,
  format = 1,
  extra,
}: WavSpec): Uint8Array {
  const width = bits / 8;
  const dataSize = samples.length * width;
  const extraSize = extra ? 8 + extra.body.length + (extra.body.length % 2) : 0;
  const bytes = new Uint8Array(44 + extraSize + dataSize);
  const view = new DataView(bytes.buffer);
  const tag = (at: number, text: string): void => {
    for (let i = 0; i < 4; i += 1) view.setUint8(at + i, text.charCodeAt(i));
  };

  tag(0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  tag(8, "WAVE");

  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, format, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * width, true);
  view.setUint16(32, channels * width, true);
  view.setUint16(34, bits, true);

  let at = 36;
  if (extra) {
    tag(at, extra.id);
    view.setUint32(at + 4, extra.body.length, true);
    bytes.set(extra.body, at + 8);
    at += 8 + extra.body.length + (extra.body.length % 2);
  }

  tag(at, "data");
  view.setUint32(at + 4, dataSize, true);
  samples.forEach((x, i) => {
    const o = at + 8 + i * width;
    if (format === 3) view.setFloat32(o, x, true);
    else view.setInt16(o, Math.round(x * 0x8000), true);
  });
  return bytes;
}

describe("decodeWav", () => {
  it("reads 16-bit PCM back to floats", () => {
    const { samples, sampleRate, channels } = decodeWav(wavFile({ samples: [0, 0.5, -0.5, 0.25] }));
    expect(sampleRate).toBe(16000);
    expect(channels).toBe(1);
    expect([...samples]).toHaveLength(4);
    expect(samples[1]).toBeCloseTo(0.5, 4);
    expect(samples[2]).toBeCloseTo(-0.5, 4);
  });

  it("downmixes to mono by averaging", () => {
    // Interleaved L R L R. The channels are the same voice, so an average is
    // the right thing rather than dropping one.
    const { samples, channels } = decodeWav(
      wavFile({ samples: [0.5, -0.5, 0.25, 0.75], channels: 2 }),
    );
    expect(channels).toBe(2);
    expect([...samples]).toHaveLength(2);
    expect(samples[0]).toBeCloseTo(0, 4);
    expect(samples[1]).toBeCloseTo(0.5, 4);
  });

  it("reads 32-bit float, values untouched", () => {
    const { samples } = decodeWav(wavFile({ samples: [1.5, -0.25], bits: 32, format: 3 }));
    expect(samples[0]).toBeCloseTo(1.5, 6);
    expect(samples[1]).toBeCloseTo(-0.25, 6);
  });

  it("walks past metadata between fmt and data", () => {
    // Commons and Common Voice files carry LIST/INFO chunks, so the payload
    // is not at byte 44. Assuming it is works until it silently doesn't.
    const { samples } = decodeWav(
      wavFile({ samples: [0.5, -0.5], extra: { id: "LIST", body: [1, 2, 3] } }),
    );
    expect(samples[0]).toBeCloseTo(0.5, 4);
    expect(samples[1]).toBeCloseTo(-0.5, 4);
  });

  it("refuses what it cannot read", () => {
    expect(() => decodeWav(new Uint8Array(64))).toThrow(/no RIFF\/WAVE header/);
    // 8-bit PCM and A-law are real WAV encodings we would read as noise.
    const eightBit = wavFile({ samples: [0.5] });
    new DataView(eightBit.buffer).setUint16(34, 8, true);
    expect(() => decodeWav(eightBit)).toThrow(/Unsupported WAV encoding/);
    expect(() => decodeWav(wavFile({ samples: [0], format: 6 }))).toThrow(/Unsupported WAV encoding/);
  });
});

describe("the committed fixture", () => {
  // Real native speech, and the one thing about it the pipeline depends on:
  // that it is already at the only rate the model accepts.
  it("is 16 kHz mono speech, not silence", () => {
    const { samples, sampleRate, channels } = readFixtureWav("es-perro.wav");
    expect(sampleRate).toBe(16000);
    expect(channels).toBe(1);
    expect(samples.length).toBe(9723);
    const peak = samples.reduce((a, b) => Math.max(a, Math.abs(b)), 0);
    expect(peak).toBeGreaterThan(0.05);
    expect(peak).toBeLessThanOrEqual(1);
  });
});
