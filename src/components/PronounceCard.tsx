/**
 * The pronunciation card: the English prompt, the Spanish to say, a
 * hold-to-talk button, and the per-phoneme verdict afterwards.
 *
 * **Both faces are shown, deliberately.** The other two directions hide the
 * answer because recall is the thing being tested; here it is not. A
 * pronunciation attempt you cannot start because you have forgotten the word
 * measures recall a second time and pronunciation not at all, so the target is
 * on screen, syllabified, with the stress marked — which is information the
 * learner needs anyway, since a misplaced stress is audible and G2P already
 * knows where it goes.
 *
 * **Hold to talk**, rather than click-to-start/click-to-stop (the decision
 * §14.5 left to this phase). An utterance is one or two seconds: a mode you
 * have to remember to leave is a worse fit than a button you hold, it makes
 * "I'm recording" unambiguous, and a release is a natural commit in the same
 * way the swipe is on `FlashCard`. The endpoint trim (§14.2) absorbs the slack
 * at both ends, so nobody has to be precise about it.
 *
 * The level meter follows `FlashCard`'s rule from `CLAUDE.md`: it moves 23
 * times a second, so it is written to the DOM from a `requestAnimationFrame`
 * loop and never through state.
 */

import { AlertTriangle, Check, Loader2, Mic, Play, RotateCcw, SkipForward } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { cn } from "@/app/lib/utils";
import { diagnose, headline, meterOf, type SyllableFeedback, type WordFeedback } from "@/app/lib/phonology/feedback";
import { PASS_SCORE, type PhoneScore } from "@/app/lib/phonology/gop";
import { prepare, type Attempt, type UsePronunciation } from "@/app/lib/pronounce/usePronunciation";
import type { Card } from "@/types/cards";

export interface PronounceCardProps {
  card: Card;
  isNew: boolean;
  retry: boolean;
  pronunciation: UsePronunciation;
  /** Called on "next": the verdict, and the attempt behind it when there was one. */
  onAnswer(knew: boolean, attempt: Attempt | null): void;
}

export function PronounceCard({ card, isNew, retry, pronunciation, onAnswer }: PronounceCardProps) {
  const { model, recorder, scoring, attempt, error, arm, start, stop, reset } = pronunciation;

  // G2P is pure and cheap, but it throws on a card it cannot pronounce (§11),
  // and that has to be known *before* the record button is offered.
  const [target, setTarget] = useState(() => prepare(card.spanish));
  const held = useRef(false);

  useEffect(() => {
    setTarget(prepare(card.spanish));
    reset();
    held.current = false;
  }, [card.id, card.spanish, reset]);

  const armed = recorder.state === "ready" || recorder.state === "recording";
  const recording = recorder.state === "recording";
  const busy = scoring || recorder.state === "processing";
  const blocked = target.error !== null || model.state === "failed";

  const release = useCallback(() => {
    if (!held.current) return;
    held.current = false;
    if (recorder.state === "recording") void stop(card.spanish);
  }, [card.spanish, recorder.state, stop]);

  const press = useCallback(() => {
    if (held.current || blocked || busy) return;
    held.current = true;
    if (armed) start();
    else void arm().then(() => held.current && start());
  }, [armed, arm, blocked, busy, start]);

  /**
   * Every way a press can end, bound to the window rather than to the button.
   *
   * Three of these are not paranoia:
   *
   * - `pointerup` on the window, because the mic button is a spinner while the
   *   device opens, and a learner who taps and lets go during that would
   *   otherwise never release — the recording would run to its 15-second cap.
   * - `blur`, because a held key produces no `keyup` once the window has lost
   *   focus, which is what happens if the browser raises its own microphone
   *   permission prompt on the very first attempt.
   * - `repeat`, because auto-repeat on a held key would restart the recording
   *   about thirty times a second.
   */
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.repeat) return;
      if (event.target instanceof HTMLElement && event.target.tagName === "INPUT") return;
      event.preventDefault();
      press();
    };
    const up = (event: KeyboardEvent) => {
      if (event.code !== "Space") return;
      event.preventDefault();
      release();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      window.removeEventListener("blur", release);
    };
  }, [press, release]);

  const passed = attempt !== null && attempt.score >= PASS_SCORE;

  return (
    <div className="mx-auto w-full max-w-lg animate-cardIn">
      <div className="plate rim relative overflow-hidden p-6 sm:p-8">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-2">
          <span className="label">say it in spanish</span>
          <span className="flex gap-1.5">
            {isNew ? <span className="chip border-emerald-400/30 text-neon-mint">new</span> : null}
            {retry ? <span className="chip border-amber-400/30 text-neon-amber">retry</span> : null}
          </span>
        </div>

        <p className="mb-6 text-center text-xl font-medium text-steel-300 sm:text-2xl">
          {card.english}
        </p>

        <Target words={target.words} feedback={attempt?.words ?? null} />

        {card.notes ? (
          <p className="mt-4 text-center text-xs text-steel-500">{card.notes}</p>
        ) : null}

        <div className="mt-7">
          {blocked ? (
            <Blocked message={target.error ?? model.error ?? "Something went wrong."} />
          ) : attempt ? (
            <Verdict attempt={attempt} passed={passed} />
          ) : busy ? (
            <Working label={scoring ? "scoring" : "processing"} />
          ) : model.state === "loading" ? (
            <Downloading received={model.received} total={model.total} />
          ) : (
            <TalkButton
              level={recorder.level}
              recording={recording}
              arming={recorder.state === "arming"}
              onPress={press}
            />
          )}
        </div>

        {error && !blocked ? (
          <p
            role="alert"
            className="mt-4 animate-riseIn rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-center text-sm font-medium text-rose-300"
          >
            {error}
          </p>
        ) : null}
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
        {attempt ? (
          <>
            <button onClick={reset} className="btn btn-steel sheen">
              <RotateCcw className="h-4 w-4" />
              Try again
            </button>
            <button
              onClick={() => onAnswer(passed, attempt)}
              className={cn("btn sheen", passed ? "btn-primary" : "btn-steel")}
            >
              {passed ? <Check className="h-4 w-4" /> : <SkipForward className="h-4 w-4" />}
              Next card
            </button>
          </>
        ) : (
          <button onClick={() => onAnswer(false, null)} className="btn btn-steel sheen">
            <SkipForward className="h-4 w-4" />
            Skip
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * The Spanish, split into syllables, with the stressed one lit.
 *
 * Once an attempt has been scored the same syllables become the meters — the
 * §Phase 7 brief's "a `.well` track per syllable with the GOP z-score as a lit
 * meter". Keeping them in one component means the text does not move between
 * the prompt and the result: the feedback lands on the syllable the learner
 * was already looking at.
 */
function Target({ words, feedback }: { words: { word: string; syllables: { phones: string[]; stressed: boolean }[] }[]; feedback: WordFeedback[] | null }) {
  return (
    <div className="flex flex-wrap items-end justify-center gap-x-5 gap-y-4">
      {words.map((word, w) => (
        <div key={`${word.word}:${w}`} className="flex items-end gap-1.5">
          {word.syllables.map((syllable, s) => (
            <SyllableCell
              key={s}
              text={syllable.phones.join("")}
              stressed={syllable.stressed}
              scored={feedback?.[w]?.syllables[s] ?? null}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function SyllableCell({
  text,
  stressed,
  scored,
}: {
  text: string;
  stressed: boolean;
  scored: SyllableFeedback | null;
}) {
  const worst = scored?.worst ?? null;
  const tone = toneOf(worst);

  return (
    <div className="flex flex-col items-center gap-1.5">
      <span
        className={cn(
          "font-mono tracking-tight transition-colors duration-500 ease-metal",
          stressed ? "text-2xl font-bold sm:text-3xl" : "text-xl font-medium sm:text-2xl",
          worst ? tone.text : stressed ? "chrome-cyan" : "text-steel-300",
        )}
      >
        {text}
      </span>
      {/* The meter track exists from the start, empty, so the layout doesn't
          jump when the result arrives. */}
      <span className="well h-1.5 w-full min-w-[2.25rem] overflow-hidden rounded-full">
        {worst ? (
          <span
            className={cn("block h-full rounded-full transition-[width] duration-700 ease-metal", tone.fill)}
            style={{ width: `${Math.round(meterOf(worst) * 100)}%` }}
          />
        ) : null}
      </span>
    </div>
  );
}

/** The scored result: a headline, then every phone that has something to say. */
function Verdict({ attempt, passed }: { attempt: Attempt; passed: boolean }) {
  const flagged = attempt.phones.filter((p) => p.verdict !== "good");
  const audio = usePlayback(attempt);

  return (
    <div className="animate-riseIn space-y-4">
      <div className="flex items-center gap-4">
        <div
          className={cn(
            "flex h-14 w-14 shrink-0 items-center justify-center rounded-full font-mono text-lg font-bold",
            passed ? "text-neon-mint shadow-mint" : "text-neon-amber shadow-rose",
          )}
        >
          {Math.round(attempt.score * 100)}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-steel-100">
            {headline(attempt.worst, attempt.score)}
          </p>
          <button
            onClick={audio.play}
            disabled={audio.playing}
            className="mt-1 inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-steel-500 transition-colors hover:text-neon-ice disabled:opacity-50"
          >
            <Play className="h-3 w-3" />
            {audio.playing ? "playing" : "hear what it heard"}
          </button>
        </div>
      </div>

      {flagged.length > 0 ? (
        <ul className="space-y-2">
          {flagged.map((phone, i) => (
            <PhoneNote key={`${phone.phone}:${phone.start}:${i}`} score={phone} index={i} />
          ))}
        </ul>
      ) : null}

      {attempt.phones.some((p) => !p.calibrated) ? (
        // Honesty about the calibration: a phone falling back to the pooled
        // distribution is being judged against every sound at once (§4.6).
        <p className="text-center text-[10px] uppercase tracking-[0.16em] text-steel-600">
          some sounds have no native baseline yet
        </p>
      ) : null}
    </div>
  );
}

function PhoneNote({ score, index }: { score: PhoneScore; index: number }) {
  const { message, hint } = diagnose(score);
  const tone = toneOf(score);

  return (
    <li
      className="well animate-riseIn px-3 py-2.5"
      style={{ animationDelay: `${index * 80}ms` }}
    >
      <div className="flex items-center gap-2">
        <span className={cn("chip shrink-0", tone.chip)}>/{score.phone}/</span>
        <span className="min-w-0 flex-1 text-xs text-steel-200">{message}</span>
        {score.z !== null ? (
          <span className="shrink-0 font-mono text-[10px] text-steel-500">
            {score.z >= 0 ? "+" : ""}
            {score.z.toFixed(1)}σ
          </span>
        ) : null}
      </div>
      {hint ? <p className="mt-1.5 text-[11px] leading-snug text-steel-400">{hint}</p> : null}
    </li>
  );
}

/**
 * Hold to talk. The release is handled by the window listener in
 * `PronounceCard`, not here, and the button is deliberately never `disabled`:
 * a disabled element fires no `pointerup`, so disabling it while the mic opens
 * would strand a short press in the recording state.
 */
function TalkButton({
  level,
  recording,
  arming,
  onPress,
}: {
  level: { current: number };
  recording: boolean;
  arming: boolean;
  onPress(): void;
}) {
  const ring = useRef<HTMLSpanElement>(null);

  // The meter, per `CLAUDE.md`: read the ref in rAF, write the DOM once a
  // frame. A `setState` here would re-render the card 23 times a second while
  // the learner is mid-word.
  useEffect(() => {
    if (!recording) return;
    let frame = 0;
    let shown = 0;
    const tick = () => {
      // Ease towards the reading rather than tracking it exactly: the raw peak
      // is per-batch and jitters hard enough to look broken.
      shown += (Math.min(1, level.current * 2.2) - shown) * 0.25;
      if (ring.current) ring.current.style.transform = `scale(${(1 + shown * 0.85).toFixed(3)})`;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [level, recording]);

  return (
    <div className="flex flex-col items-center gap-3">
      <div className="relative">
        <span
          ref={ring}
          aria-hidden
          className={cn(
            "absolute inset-0 rounded-full bg-neon-cyan/25 blur-md transition-opacity duration-300",
            recording ? "opacity-100" : "opacity-0",
          )}
        />
        <button
          type="button"
          onPointerDown={(event) => {
            // Keep the pointer with the button, so dragging off it while
            // speaking doesn't silently drop the release.
            event.currentTarget.setPointerCapture(event.pointerId);
            onPress();
          }}
          aria-label={recording ? "Release to score" : "Hold to speak"}
          className={cn(
            "relative flex h-20 w-20 select-none items-center justify-center rounded-full",
            "border transition duration-200 ease-metal",
            recording
              ? "border-neon-cyan/60 bg-gradient-to-b from-neon-ice to-cyan-600 text-ink-950 shadow-cyan"
              : "border-white/10 bg-gradient-to-b from-steel-700 to-steel-900 text-steel-200 hover:from-steel-600 hover:text-steel-50",
          )}
          style={{ touchAction: "none" }}
        >
          {arming ? (
            <Loader2 className="h-7 w-7 animate-spinFast" />
          ) : (
            <Mic className={cn("h-7 w-7", recording && "animate-pulseGlow")} />
          )}
        </button>
      </div>
      <p className="label">
        {arming ? "opening the mic" : recording ? "listening — release when done" : "hold to speak"}
      </p>
    </div>
  );
}

/**
 * The first-load wait, which is a real ~200 s on a fresh cache (§13.2) — hence
 * a progress bar with megabytes on it rather than a spinner that looks hung.
 */
function Downloading({ received, total }: { received: number; total: number }) {
  const fraction = total > 0 ? received / total : 0;
  const mb = (bytes: number) => (bytes / 1_000_000).toFixed(0);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="label">fetching the voice model</span>
        <span className="font-mono text-[10px] text-steel-400">
          {total > 0 ? `${mb(received)} / ${mb(total)} MB` : "starting"}
        </span>
      </div>
      <div className="well h-2 overflow-hidden rounded-full">
        <div
          className="h-full rounded-full bg-gradient-to-r from-neon-cyan to-neon-ice shadow-cyan transition-[width] duration-300 ease-metal"
          style={{ width: `${Math.round(fraction * 100)}%` }}
        />
      </div>
      <p className="text-center text-[11px] text-steel-500">
        Once, then it&rsquo;s cached — everything after this runs offline on your machine.
      </p>
    </div>
  );
}

/** Inference is ~0.9x realtime (§13.2), so this is a second or so, not a flicker. */
function Working({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-2">
      <div className="relative h-12 w-12">
        <div className="absolute inset-0 animate-spinFast rounded-full border-2 border-neon-cyan/25 border-t-neon-cyan" />
      </div>
      <p className="label animate-ticker">{label}</p>
    </div>
  );
}

function Blocked({ message }: { message: string }) {
  return (
    <div className="well flex items-start gap-2.5 px-3 py-3">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-neon-amber" />
      <p className="text-xs text-steel-300">{message}</p>
    </div>
  );
}

/**
 * Play back the untrimmed take, so "it didn't hear you" is checkable.
 *
 * The recording is a bare `Float32Array`, so there is nothing to hand an
 * `<audio>` element — it goes back through an `AudioContext` the same way it
 * came out of one. Created lazily and per attempt: a context per card would
 * exhaust the browser's handful of them in a long session.
 */
function usePlayback(attempt: Attempt) {
  const [playing, setPlaying] = useState(false);
  const context = useRef<AudioContext | null>(null);

  useEffect(
    () => () => {
      void context.current?.close();
      context.current = null;
    },
    [],
  );

  useEffect(() => setPlaying(false), [attempt]);

  const play = useCallback(() => {
    const { full, sampleRate } = attempt.audio;
    if (full.length === 0) return;
    context.current ??= new AudioContext();
    const ctx = context.current;
    void ctx.resume();

    const buffer = ctx.createBuffer(1, full.length, sampleRate);
    buffer.getChannelData(0).set(full);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.onended = () => setPlaying(false);
    setPlaying(true);
    source.start();
  }, [attempt]);

  return { play, playing };
}

/** One place deciding what a verdict looks like, so the meter and the chip agree. */
function toneOf(score: PhoneScore | null): { text: string; fill: string; chip: string } {
  switch (score?.verdict) {
    case "off":
      return {
        text: "text-rose-300",
        fill: "bg-gradient-to-r from-rose-500 to-rose-300",
        chip: "border-rose-400/40 text-rose-300",
      };
    case "close":
      return {
        text: "text-neon-amber",
        fill: "bg-gradient-to-r from-amber-500 to-neon-amber",
        chip: "border-amber-400/40 text-neon-amber",
      };
    default:
      return {
        text: "text-neon-mint",
        fill: "bg-gradient-to-r from-emerald-500 to-neon-mint",
        chip: "border-emerald-400/40 text-neon-mint",
      };
  }
}
