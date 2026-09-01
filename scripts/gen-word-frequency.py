#!/usr/bin/env python3
"""Regenerate supabase/migrations/005_word_frequency.sql from wordfreq.

The frequency table is reference data baked into a migration rather than
fetched at runtime: it never changes, it's needed for every deck build, and a
network call in the middle of a query is not something we want.

Usage:
    python3 -m venv .venv && .venv/bin/pip install wordfreq
    .venv/bin/python scripts/gen-word-frequency.py
"""

import re
from pathlib import Path

import wordfreq
from wordfreq import zipf_frequency

# Top N by frequency. 30k reaches Zipf ~3.1, which covers essentially any word
# a learner would put on a card; rarer tokens fall through to ZIPF_FLOOR.
TOP_N = 30_000
BATCH = 1_000

# wordfreq's list includes digits, emoji and foreign fragments. Cards are
# Spanish words, so keep only the Spanish alphabet.
SPANISH = re.compile(r"^[a-záéíóúüñ]+$")

OUT = Path(__file__).resolve().parent.parent / "supabase" / "migrations" / "005_word_frequency.sql"

HEADER = """\
-- ---------------------------------------------------------------------------
-- Spanish word frequencies, used to weight the study deck towards vocabulary
-- that's actually worth knowing.
--
-- GENERATED FILE — do not edit by hand. Regenerate with:
--     scripts/gen-word-frequency.py
--
-- Values are Zipf frequencies from the `wordfreq` package: log10 of
-- occurrences per billion words, so 7 is a function word ("de", "la"), ~5 a
-- common noun ("casa"), ~3 something you'd meet in a novel ("murciélago").
-- The scale is logarithmic, which is what makes it usable directly as a
-- weight input rather than raw counts spanning six orders of magnitude.
--
-- Source: wordfreq (https://github.com/rspeer/wordfreq), MIT-licensed code
-- over corpora including OpenSubtitles and Wikipedia. Top {top_n} tokens.
-- ---------------------------------------------------------------------------

create table public.word_frequency (
  word text primary key,
  zipf real not null
);

-- Reference data, identical for every user: readable by any signed-in user,
-- writable by no one (the service role bypasses RLS for regeneration).
alter table public.word_frequency enable row level security;
create policy read_all on public.word_frequency
  for select to authenticated using (true);

"""

FOOTER = '''
-- Zipf score for a whole card side.
--
-- A phrase is as hard as its rarest content word: "el murciélago" scores 3.37
-- (murciélago), not the 5.41 you'd get by averaging in the "el". So we take the
-- minimum across tokens, which is why this is `min` and not `avg`.
--
-- Tokens outside the table are rarer than the generation cutoff, so they take
-- ZIPF_FLOOR rather than being skipped — otherwise a phrase made entirely of
-- rare words would score null and fall back to looking common.
create or replace function public.phrase_zipf(phrase text)
returns real
language sql
stable
parallel safe
as $$
  select coalesce(min(coalesce(wf.zipf, 3.0)), 3.0)
    from regexp_split_to_table(
           -- Fold to lowercase and turn anything that isn't a Spanish letter
           -- into a separator, so "¿Cómo estás?" tokenises cleanly.
           regexp_replace(lower(phrase), '[^a-záéíóúüñ]+', ' ', 'g'),
           '\\s+'
         ) as token
    left join public.word_frequency wf on wf.word = token
   where length(token) > 0;
$$;
'''


def main() -> None:
    words = [w for w in wordfreq.top_n_list("es", TOP_N) if SPANISH.match(w)]

    parts = [HEADER.format(top_n=f"{TOP_N:,}")]
    for start in range(0, len(words), BATCH):
        chunk = words[start : start + BATCH]
        values = ",".join(
            f"('{w}',{zipf_frequency(w, 'es'):.2f})" for w in chunk
        )
        parts.append(f"insert into public.word_frequency (word, zipf) values {values};\n")
    parts.append(FOOTER)

    OUT.write_text("".join(parts), encoding="utf-8")
    size_mb = OUT.stat().st_size / 1e6
    print(f"wrote {len(words):,} words to {OUT} ({size_mb:.2f} MB)")


if __name__ == "__main__":
    main()
