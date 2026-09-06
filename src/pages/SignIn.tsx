import { ArrowRight, Loader2, ScanLine, Shuffle, Waypoints } from "lucide-react";
import { useState } from "react";

import { useAuth } from "@/app/AuthProvider";
import { cn } from "@/app/lib/utils";
import { Backdrop } from "@/components/Backdrop";

const FEATURES = [
  {
    icon: <Waypoints className="h-4 w-4" />,
    title: "Weighted scheduling",
    body: "urgency × utility, sampled in SQL — the deck decides, not a queue",
  },
  {
    icon: <Shuffle className="h-4 w-4" />,
    title: "Both directions",
    body: "en → es and es → en are tracked as separate skills",
  },
  {
    icon: <ScanLine className="h-4 w-4" />,
    title: "Live translation",
    body: "type one side, the other arrives as a suggestion",
  },
];

export function SignIn() {
  const { signIn, signUp } = useAuth();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "signin") await signIn(email, password);
      else await signUp(email, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grain relative flex min-h-dvh items-center justify-center overflow-x-clip p-5 sm:p-8">
      <Backdrop />

      <div className="grid w-full max-w-5xl items-center gap-10 lg:grid-cols-[1.1fr_minmax(0,26rem)]">
        {/* Marque side — hidden on phones, where the form is the whole job. */}
        <section className="hidden lg:block">
          <Emblem />

          <h1 className="chrome mt-8 text-6xl font-bold uppercase leading-[0.95] tracking-[0.06em]">
            Tarjetas
          </h1>
          <p className="mt-4 max-w-md text-steel-400">
            A Spanish drill deck with the scheduler in the database and the
            gesture in your thumb.
          </p>

          <ul className="mt-9 space-y-3">
            {FEATURES.map((f, i) => (
              <li
                key={f.title}
                className="plate rim sheen flex animate-riseIn items-start gap-3 overflow-hidden p-3.5"
                style={{ animationDelay: `${140 + i * 110}ms` }}
              >
                <span className="mt-0.5 text-neon-cyan">{f.icon}</span>
                <span>
                  <span className="block text-sm font-semibold text-steel-100">{f.title}</span>
                  <span className="label mt-1 block normal-case tracking-[0.1em]">{f.body}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>

        {/* Form side. */}
        <section className="relative mx-auto w-full max-w-sm animate-riseIn lg:max-w-none">
          <div
            aria-hidden
            className="absolute -inset-1.5 -z-10 rounded-[24px] bg-gradient-to-br from-neon-cyan/30 via-neon-violet/20 to-neon-magenta/25 blur-2xl"
          />

          <form onSubmit={submit} className="plate rim p-6">
            <div className="mb-6 flex items-center justify-between gap-3 lg:hidden">
              <div>
                <h1 className="chrome text-2xl font-bold uppercase tracking-[0.16em]">Tarjetas</h1>
                <p className="label mt-1">es · en drill deck</p>
              </div>
              <Emblem compact />
            </div>

            <p className="label mb-5 hidden lg:block">
              {mode === "signin" ? "authenticate" : "provision account"}
            </p>

            <div className="space-y-4">
              <label className="block">
                <span className="label mb-1.5 block">Email</span>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                  className="input-metal"
                />
              </label>
              <label className="block">
                <span className="label mb-1.5 block">Password</span>
                <input
                  type="password"
                  required
                  minLength={6}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete={mode === "signin" ? "current-password" : "new-password"}
                  className="input-metal"
                />
              </label>
            </div>

            {error ? (
              <p
                role="alert"
                className="mt-4 animate-riseIn rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm font-medium text-rose-300"
              >
                {error}
              </p>
            ) : null}

            <button type="submit" disabled={busy} className="btn btn-primary sheen mt-5 w-full">
              {busy ? (
                <>
                  <span className="shimmer-band absolute inset-0 animate-shimmer opacity-60" />
                  <Loader2 className="relative h-4 w-4 animate-spin" />
                </>
              ) : null}
              <span className="relative">{mode === "signin" ? "Sign in" : "Create account"}</span>
              {!busy ? <ArrowRight className="relative h-4 w-4" /> : null}
            </button>

            <button
              type="button"
              onClick={() => {
                setMode(mode === "signin" ? "signup" : "signin");
                setError(null);
              }}
              className="label mt-4 w-full transition hover:text-neon-ice"
            >
              {mode === "signin" ? "no account? create one" : "already have an account? sign in"}
            </button>
          </form>
        </section>
      </div>
    </div>
  );
}

/** The brand mark: a machined plate inside two counter-rotating rings. */
function Emblem({ compact }: { compact?: boolean }) {
  return (
    <div className={cn("relative shrink-0", compact ? "h-14 w-14" : "h-24 w-24")}>
      <div className="absolute inset-0 animate-spinSlow rounded-full border border-dashed border-neon-cyan/40" />
      <div
        className="absolute inset-2 animate-spinSlow rounded-full border border-neon-violet/40"
        style={{ animationDirection: "reverse", animationDuration: "9s" }}
      />
      <div className="absolute inset-0 animate-pulseGlow rounded-full bg-neon-cyan/20 blur-xl" />
      <div className="plate plate-bright rim absolute inset-[22%] flex items-center justify-center rounded-2xl">
        <span className={cn("chrome-cyan font-mono font-bold", compact ? "text-lg" : "text-3xl")}>
          ñ
        </span>
      </div>
    </div>
  );
}
