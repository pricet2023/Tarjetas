/**
 * A WAV reader, for audio that arrives as a file rather than from a mic.
 *
 * Nothing in the app records WAVs — Phase 4's capture path hands the scorer a
 * `Float32Array` straight from an `OfflineAudioContext`, with no container
 * anywhere. This exists for the two places audio comes from disk instead: the
 * committed fixture that proves the pipeline against real speech, and Phase
 * 5's native-stats script, which will read a few thousand corpus clips in
 * Node. `jsdom` has no `AudioContext` to decode them with, and Node has no
 * Web Audio at all.
 *
 * Handles the two encodings those sources actually use — 16-bit PCM and 32-bit
 * float — and refuses everything else rather than reading noise.
 */

export interface Waveform {
  /** Mono, in [-1, 1] for PCM sources. */
  samples: Float32Array;
  sampleRate: number;
  /** How many channels the file had before the downmix. */
  channels: number;
}

const FORMAT_PCM = 1;
const FORMAT_FLOAT = 3;
const FORMAT_EXTENSIBLE = 0xfffe;

const ascii = (view: DataView, at: number): string =>
  String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));

/**
 * Decode a WAV file.
 *
 * The chunk walk is not decoration: real files from Commons and Common Voice
 * carry `LIST`/`INFO` metadata between `fmt ` and `data`, so the payload is
 * not at a fixed offset. Assuming byte 44 works right up until it silently
 * does not.
 */
export function decodeWav(bytes: ArrayBuffer | ArrayBufferView): Waveform {
  // `ArrayBuffer.isView` rather than `instanceof Uint8Array`: a Node `Buffer`
  // read under the `jsdom` test environment comes from a different realm than
  // the `Uint8Array` global there, so `instanceof` says no to a perfectly good
  // byte array.
  const view = ArrayBuffer.isView(bytes)
    ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : new DataView(bytes);

  if (view.byteLength < 12 || ascii(view, 0) !== "RIFF" || ascii(view, 8) !== "WAVE") {
    throw new Error("Not a WAV file: no RIFF/WAVE header.");
  }

  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let data: { at: number; length: number } | null = null;

  let at = 12;
  while (at + 8 <= view.byteLength) {
    const id = ascii(view, at);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === "fmt ") {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
      if (format === FORMAT_EXTENSIBLE && size >= 26) {
        // WAVE_FORMAT_EXTENSIBLE hides the real format in its GUID's first
        // two bytes.
        format = view.getUint16(body + 24, true);
      }
    } else if (id === "data") {
      data = { at: body, length: Math.min(size, view.byteLength - body) };
    }
    at = body + size + (size % 2); // chunks are word-aligned
  }

  if (!data) throw new Error("WAV file has no data chunk.");
  if (channels < 1 || sampleRate < 1) throw new Error("WAV file has no readable fmt chunk.");

  const read = reader(format, bits);
  const width = bits / 8;
  const total = Math.floor(data.length / width);
  const perChannel = Math.floor(total / channels);
  const samples = new Float32Array(perChannel);

  // Interleaved, so a stereo file is L R L R. Averaging is the right downmix
  // for speech: the channels are the same voice.
  for (let i = 0; i < perChannel; i += 1) {
    let sum = 0;
    for (let c = 0; c < channels; c += 1) sum += read(view, data.at + (i * channels + c) * width);
    samples[i] = sum / channels;
  }
  return { samples, sampleRate, channels };
}

function reader(format: number, bits: number): (view: DataView, at: number) => number {
  if (format === FORMAT_PCM && bits === 16) {
    return (view, at) => view.getInt16(at, true) / 0x8000;
  }
  if (format === FORMAT_FLOAT && bits === 32) {
    return (view, at) => view.getFloat32(at, true);
  }
  throw new Error(
    `Unsupported WAV encoding: format ${format}, ${bits}-bit. Convert to 16-bit PCM or 32-bit float.`,
  );
}
