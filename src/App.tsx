import { Layers, LogOut, Sparkles } from "lucide-react";
import { Navigate, NavLink, Route, Routes, useLocation } from "react-router-dom";

import { useAuth } from "@/app/AuthProvider";
import { cn } from "@/app/lib/utils";
import { Backdrop } from "@/components/Backdrop";
import { Cards } from "@/pages/Cards";
import { SignIn } from "@/pages/SignIn";
import { Study } from "@/pages/Study";

export function App() {
  const { user, loading, signOut } = useAuth();
  const location = useLocation();

  // Render nothing until the persisted session is known, so an authenticated
  // reload doesn't flash the sign-in screen.
  if (loading) return null;
  if (!user) return <SignIn />;

  // The x axis is clipped: the card's glow and its fly-off both bleed past the
  // viewport, and neither should produce a sideways scroll.
  return (
    <div className="grain relative flex min-h-dvh flex-col overflow-x-clip">
      <Backdrop />

      <header className="sticky top-0 z-40">
        {/* Power rail: the lit hairline that runs along the top of the chassis. */}
        <div className="h-px w-full bg-gradient-to-r from-transparent via-neon-cyan/70 to-transparent" />
        <div className="border-b border-white/5 bg-ink-900/70 backdrop-blur-xl">
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
            <Brand />
            <nav className="flex items-center gap-2">
              <div className="plate rim flex items-center gap-1 rounded-2xl p-1">
                <Tab to="/study" icon={<Sparkles className="h-4 w-4" />} label="Study" />
                <Tab to="/cards" icon={<Layers className="h-4 w-4" />} label="Cards" />
              </div>
              <button onClick={() => void signOut()} aria-label="Sign out" className="btn-icon sheen">
                <LogOut className="h-4 w-4" />
              </button>
            </nav>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 pb-8 pt-6 sm:px-6">
        {/* Keyed on the path so every navigation replays the entrance. */}
        <div key={location.pathname} className="animate-riseIn">
          <Routes location={location}>
            <Route path="/study" element={<Study />} />
            <Route path="/cards" element={<Cards />} />
            <Route path="*" element={<Navigate to="/study" replace />} />
          </Routes>
        </div>
      </main>

      <footer className="mx-auto w-full max-w-6xl px-4 pb-5 sm:px-6">
        <div className="flex items-center justify-between gap-3 border-t border-white/5 pt-3 font-mono text-[10px] uppercase tracking-[0.18em] text-steel-500">
          <span className="flex items-center gap-2">
            <span className="h-1.5 w-1.5 animate-pulseGlow rounded-full bg-neon-mint shadow-mint" />
            local link established
          </span>
          <span className="truncate">{user.email}</span>
        </div>
      </footer>
    </div>
  );
}

function Brand() {
  return (
    <div className="flex items-center gap-3">
      <div className="relative h-9 w-9 shrink-0">
        <div className="absolute inset-0 animate-spinSlow rounded-[10px] bg-gradient-to-br from-neon-cyan via-neon-violet to-neon-magenta opacity-70 blur-[6px]" />
        <div className="plate plate-bright rim absolute inset-0 flex items-center justify-center rounded-[10px]">
          <span className="chrome-cyan font-mono text-sm font-bold">ñ</span>
        </div>
      </div>
      <div className="leading-none">
        <h1 className="chrome text-lg font-bold uppercase tracking-[0.18em]">Tarjetas</h1>
        <p className="label mt-1">es · en drill deck</p>
      </div>
    </div>
  );
}

function Tab({ to, icon, label }: { to: string; icon: React.ReactNode; label: string }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cn(
          "sheen relative inline-flex items-center gap-1.5 overflow-hidden rounded-xl px-3 py-2 text-sm font-semibold tracking-tight transition duration-200 ease-metal",
          isActive
            ? "text-ink-950 shadow-cyan"
            : "text-steel-400 hover:text-steel-100",
        )
      }
    >
      {({ isActive }) => (
        <>
          {isActive ? (
            <span
              aria-hidden
              className="absolute inset-0 -z-10 animate-popIn rounded-xl bg-gradient-to-b from-neon-ice via-neon-cyan to-cyan-600"
            />
          ) : null}
          {icon}
          {label}
        </>
      )}
    </NavLink>
  );
}
