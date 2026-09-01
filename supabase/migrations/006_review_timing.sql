-- ---------------------------------------------------------------------------
-- How long the card was on screen before the swipe.
--
-- Recorded now even though the first version of the weighting ignores it:
-- response time is a strong secondary signal (answering correctly after five
-- seconds is much weaker than answering instantly) and, unlike every other
-- input to the algorithm, it cannot be reconstructed after the fact. Every
-- session run without it is signal thrown away.
--
-- Nullable because a review can be recorded without a reliable timing — a
-- backgrounded tab, or a client that doesn't send one.
-- ---------------------------------------------------------------------------

alter table public.card_reviews
  add column response_ms integer check (response_ms is null or response_ms >= 0);

comment on column public.card_reviews.response_ms is
  'Milliseconds from the card being shown to the swipe being committed.';
