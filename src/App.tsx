import { Layers, LogOut, Sparkles } from "lucide-react";
import { Navigate, NavLink, Route, Routes } from "react-router-dom";

import { useAuth } from "@/app/AuthProvider";
import { Cards } from "@/pages/Cards";
import { SignIn } from "@/pages/SignIn";
import { Study } from "@/pages/Study";

export function App() {
  const { user, loading, signOut } = useAuth();

  // Render nothing until the persisted session is known, so an authenticated
  // reload doesn't flash the sign-in screen.
  if (loading) return null;
  if (!user) return <SignIn />;

  return (
    <div className="mx-auto flex min-h-dvh max-w-2xl flex-col px-4 pb-10 pt-5">
      <header className="mb-5 flex items-center justify-between">
        <h1 className="text-lg font-bold tracking-tight">Tarjetas</h1>
        <nav className="flex items-center gap-1">
          <Tab to="/study" icon={<Sparkles className="h-4 w-4" />} label="Study" />
          <Tab to="/cards" icon={<Layers className="h-4 w-4" />} label="Cards" />
          <button
            onClick={() => void signOut()}
            aria-label="Sign out"
            className="ml-1 rounded-lg p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </nav>
      </header>

      <main className="flex-1">
        <Routes>
          <Route path="/study" element={<Study />} />
          <Route path="/cards" element={<Cards />} />
          <Route path="*" element={<Navigate to="/study" replace />} />
        </Routes>
      </main>
    </div>
  );
}

function Tab({ to, icon, label }: { to: string; icon: React.ReactNode; label: string }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        isActive
          ? "inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white"
          : "inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold text-slate-500 transition hover:bg-slate-100"
      }
    >
      {icon}
      {label}
    </NavLink>
  );
}
