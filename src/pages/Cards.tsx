import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { createCard, deleteCard, listCards, updateCard } from "@/api/cards";
import { CardForm } from "@/components/CardForm";
import type { Card } from "@/types/cards";

export function Cards() {
  const [cards, setCards] = useState<Card[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Card | null>(null);

  const refresh = useCallback(async () => {
    try {
      setCards(await listCards());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load cards");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const remove = async (card: Card) => {
    if (!window.confirm(`Delete "${card.english}"? This can't be undone.`)) return;
    // Optimistic: put the row back if the delete is rejected.
    const previous = cards;
    setCards((c) => c.filter((x) => x.id !== card.id));
    try {
      await deleteCard(card.id);
    } catch (err) {
      setCards(previous);
      setError(err instanceof Error ? err.message : "Failed to delete card");
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold tracking-tight">
          Your cards <span className="font-normal text-slate-400">{cards.length}</span>
        </h2>
        {!adding && !editing ? (
          <button
            onClick={() => setAdding(true)}
            className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-3.5 py-2 text-sm font-semibold text-white transition hover:bg-indigo-700"
          >
            <Plus className="h-4 w-4" />
            Add card
          </button>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="rounded-xl bg-rose-50 px-3 py-2 text-sm font-medium text-rose-700">
          {error}
        </p>
      ) : null}

      {adding ? (
        <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <h3 className="mb-3 font-semibold">New card</h3>
          <CardForm
            onSubmit={async (input) => {
              const created = await createCard(input);
              setCards((c) => [created, ...c]);
            }}
            onCancel={() => setAdding(false)}
          />
        </section>
      ) : null}

      {editing ? (
        <section className="rounded-2xl border border-indigo-200 bg-white p-4 shadow-sm">
          <h3 className="mb-3 font-semibold">Edit card</h3>
          <CardForm
            card={editing}
            onSubmit={async (input) => {
              const saved = await updateCard(editing.id, input);
              setCards((c) => c.map((x) => (x.id === saved.id ? saved : x)));
              setEditing(null);
            }}
            onCancel={() => setEditing(null)}
          />
        </section>
      ) : null}

      {cards.length === 0 && !adding ? (
        <p className="rounded-2xl border border-dashed border-slate-300 px-4 py-12 text-center text-slate-500">
          No cards yet. Add your first one to start studying.
        </p>
      ) : null}

      <ul className="space-y-2">
        {cards.map((card) => (
          <li
            key={card.id}
            className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold">{card.english}</p>
              <p className="truncate text-slate-500">{card.spanish}</p>
              {card.timesSeen > 0 ? (
                <p className="mt-0.5 text-xs text-slate-400">
                  {card.timesKnown}/{card.timesSeen} known
                </p>
              ) : null}
            </div>
            <button
              onClick={() => {
                setAdding(false);
                setEditing(card);
              }}
              aria-label={`Edit ${card.english}`}
              className="rounded-lg p-2 text-slate-400 transition hover:bg-slate-100 hover:text-indigo-600"
            >
              <Pencil className="h-4 w-4" />
            </button>
            <button
              onClick={() => remove(card)}
              aria-label={`Delete ${card.english}`}
              className="rounded-lg p-2 text-slate-400 transition hover:bg-rose-50 hover:text-rose-600"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
