-- ---------------------------------------------------------------------------
-- Two deck changes, both to what the seed deck asks rather than how it deals.
--
-- 1. Conjugation prompts stop naming the verb.
--
--    011 wrote "they will eat (comer)" on purpose: the drill was meant to be
--    the conjugation, not the vocabulary. In practice it makes the card half a
--    card. Recalling *which* verb is the other half of the skill, and the
--    infinitive in brackets gives it away before you have tried. So:
--
--        "I spoke (hablar, preterite)"   ->  "I spoke (preterite)"
--        "they will eat (comer)"         ->  "they will eat"
--
--    The tense label stays: English "I spoke" does not by itself say
--    preterite rather than imperfect, and that is disambiguation, not a clue.
--    The infinitive is still in the notes, which only show once the card is
--    turned over.
--
--    Dropping the infinitive makes 240 prompts collide in pairs, because
--    English has one verb where Spanish has two. `english` is unique (009),
--    and two cards with one prompt would be unanswerable anyway, so each pair
--    gets a *sense* instead of a name — the same split the infinitive cards
--    already make ("to be (permanent — ...)" / "to be (temporary — ...)"):
--
--        ser / estar          (permanent) / (temporary)
--        haber / tener        (auxiliary) / (possession)
--        saber / conocer      (a fact) / (a person or place)
--        entender / comprender   understand / comprehend
--
--    The last pair are true synonyms with no sense to split on, so comprender
--    takes the English its infinitive card already uses.
--
--    This is an UPDATE in place, not a delete and re-insert: card ids are what
--    `card_reviews` and `card_state` hang off, and a re-insert would throw
--    away both of our histories on three thousand cards. Scoped to cards the
--    seed made (`created_by is null`) whose prompt still ends in their own
--    infinitive, so a card either of us has since edited is left alone. A
--    rename that would collide with a card added since is skipped, not forced.
--
--    011 itself is not regenerated: it has shipped, and editing it would
--    change the local database and never the remote (docs/deploying.md §3a).
--
-- 2. Chunks: 136 common multi-word expressions.
--
--    The deck so far maps words to words. A lot of everyday Spanish does not
--    decompose that way — "me di cuenta" is not "me" + "gave" + "account" —
--    and is learned faster as one unit. These are the high-frequency set:
--    darse cuenta, hacer falta, se puede, hace + time, llevar + time, the
--    periphrases (acabar de, dejar de, volver a, soler, ponerse a), the
--    tener/dar/hacer feeling idioms, the accidental se, the discourse glue
--    (o sea, lo que pasa es que, por cierto, de hecho) and the stock replies.
--    Spain-first where the two differ, like the rest of the deck; the notes
--    give the Latin American form.
--
--    Translations cross-checked against spanishgrammar.co.uk's verbal-phrase
--    list, FluentU's intermediate phrases, Lawless/Kwiziq on hace + time, and
--    Yourspanishguide on darse cuenta, echar de menos and tener ganas.
--
--    Their phonemes come in 018 (`npm run db:phones -- --missing=018_...`),
--    because the G2P that produces them is TypeScript and runs against the
--    database this migration leaves behind.
-- ---------------------------------------------------------------------------

-- --- 1. prompts without the infinitive ---------------------------------------

with parsed as (
  select c.id,
         split_part(c.notes, ' · ', 1) as inf,
         -- [1] the English predicate, [2] the bracketed infinitive,
         -- [3] the tense label, when there is one.
         regexp_match(c.english, '^(.*) \(([^,()]+)(?:, (preterite|imperfect))?\)$') as m
    from public.cards c
   where c.created_by is null
     and c.notes like '% · %'
),
sense (inf, qualifier) as (
  values ('ser', 'permanent'),   ('estar', 'temporary'),
         ('haber', 'auxiliary'), ('tener', 'possession'),
         ('saber', 'a fact'),    ('conocer', 'a person or place')
),
renamed as (
  select p.id,
         case p.inf
           -- 'understand' also covers 'understands'; 'understood' goes first
           -- because it does not contain 'understand'.
           when 'comprender' then replace(replace(p.m[1], 'understood', 'comprehended'),
                                          'understand', 'comprehend')
           else p.m[1]
         end
         || coalesce(' (' || nullif(concat_ws(', ', s.qualifier, p.m[3]), '') || ')', '')
           as english
    from parsed p
    left join sense s using (inf)
   where p.m is not null
     and p.m[2] = p.inf
)
update public.cards c
   set english = r.english
  from renamed r
 where c.id = r.id
   and not exists (select 1 from public.cards o where o.english = r.english and o.id <> c.id);

-- --- 2. chunks ---------------------------------------------------------------

insert into public.cards (english, spanish, notes) values
  -- Realising, remembering, forgetting
  ('I realised', 'me di cuenta', 'darse cuenta (de), preterite — me di cuenta de que... = I realised that...'),
  ('I didn''t realise', 'no me di cuenta', 'darse cuenta, preterite'),
  ('to realise', 'darse cuenta', 'always reflexive; takes de before a noun or que-clause'),
  ('are you aware? / do you see?', '¿te das cuenta?', 'darse cuenta, present'),
  ('I can''t think of anything', 'no se me ocurre nada', 'ocurrirse: the idea is the subject and happens to you'),
  ('it occurred to me that...', 'se me ocurrió que...', 'ocurrirse, preterite'),
  ('I forgot (it slipped my mind)', 'se me olvidó', 'accidental se: it forgot itself on me. Spain often says se me ha olvidado'),
  ('I dropped it', 'se me cayó', 'accidental se — the thing fell, you were just there'),
  ('as far as I know', 'que yo sepa', 'subjunctive of saber; a fixed chunk'),

  -- Need, possibility, permission
  ('it''s needed / we need', 'hace falta', 'hacer falta; hacen falta with a plural: hacen falta huevos'),
  ('there''s no need', 'no hace falta', 'also ''it''s not necessary'''),
  ('one has to... / you have to...', 'hay que...', 'impersonal obligation: hay que + infinitive. Cf. tener que for a person'),
  ('you can''t... / it''s not allowed', 'no se puede...', 'impersonal se: no se puede fumar aquí'),
  ('can I...? / is it OK to...?', '¿se puede...?', 'also on its own at a door: ¿se puede? = may I come in?'),
  ('it can''t be!', '¡no puede ser!', 'disbelief'),
  ('it doesn''t matter', 'no importa', ''),
  ('I don''t care / it''s all the same to me', 'me da igual', 'dar igual; also ''either is fine'''),
  ('what does it matter?', '¿qué más da?', 'rhetorical'),
  ('it''s worth it', 'vale la pena', 'valer la pena; merece la pena in Spain too'),
  ('it''s not worth it', 'no vale la pena', 'valer la pena'),
  ('it depends', 'depende', 'depende de = it depends on'),

  -- hace + time, llevar + time
  ('recently / not long ago', 'hace poco', 'hace + time = ago'),
  ('two years ago', 'hace dos años', 'hace + time = ago; with a past tense: lo vi hace dos años'),
  ('a few years ago', 'hace unos años', 'hace + time = ago'),
  ('a long time ago', 'hace mucho tiempo', 'hace + time = ago'),
  ('how long ago?', '¿hace cuánto?', 'also ¿cuánto hace?'),
  ('for a long time (and still)', 'desde hace mucho tiempo', 'desde hace + time with the present: vivo aquí desde hace mucho tiempo'),
  ('I''ve been learning Spanish for a year', 'llevo un año aprendiendo español', 'llevar + time + gerund = have been doing for'),
  ('how long have you been here?', '¿cuánto tiempo llevas aquí?', 'llevar + time'),
  ('it takes me an hour', 'tardo una hora', 'tardar = to take (time); ¿cuánto tardas? = how long does it take you?'),
  ('it''s getting late', 'se hace tarde', 'hacerse = to become'),

  -- Other time chunks
  ('from time to time', 'de vez en cuando', ''),
  ('for now', 'por ahora', 'also de momento'),
  ('at first', 'al principio', ''),
  ('in the end', 'al final', ''),
  ('at the end of the month', 'a finales de mes', 'a finales de = at the end of (a period)'),
  ('at the beginning of the year', 'a principios de año', 'a principios de = at the start of (a period)'),
  ('more and more', 'cada vez más', 'cada vez menos = less and less'),
  ('every time that... / whenever...', 'cada vez que...', ''),
  ('little by little', 'poco a poco', ''),
  ('at the same time', 'al mismo tiempo', ''),
  ('on time', 'a tiempo', ''),
  ('again', 'otra vez', 'also de nuevo'),
  ('the next day', 'al día siguiente', ''),
  ('as soon as possible', 'lo antes posible', 'also cuanto antes'),
  ('straight away', 'enseguida', 'one word'),
  ('as always', 'como siempre', ''),

  -- Verb + verb (periphrasis)
  ('I''m going to...', 'voy a...', 'ir a + infinitive: the everyday future'),
  ('I''ve just eaten', 'acabo de comer', 'acabar de + infinitive = to have just done'),
  ('I''ve just arrived', 'acabo de llegar', 'acabar de + infinitive'),
  ('I stopped smoking', 'dejé de fumar', 'dejar de + infinitive = to stop doing'),
  ('stop doing that!', '¡deja de hacer eso!', 'dejar de + infinitive, imperative'),
  ('I called again', 'volví a llamar', 'volver a + infinitive = to do again'),
  ('I''m about to leave', 'estoy a punto de salir', 'estar a punto de + infinitive'),
  ('I usually get up early', 'suelo levantarme temprano', 'soler + infinitive = to usually do'),
  ('I started crying', 'me puse a llorar', 'ponerse a + infinitive = to start (suddenly)'),
  ('I''m still thinking about it', 'sigo pensándolo', 'seguir + gerund = to still be doing'),
  ('I managed to finish it', 'logré terminarlo', 'lograr + infinitive; also conseguir'),

  -- tener ...
  ('I feel like it', 'tengo ganas', 'tener ganas de + infinitive'),
  ('I feel like going out', 'tengo ganas de salir', 'tener ganas de + infinitive'),
  ('I don''t feel like it', 'no tengo ganas', 'tener ganas'),
  ('you''re right', 'tienes razón', 'tener razón — never ser/estar'),
  ('I''m scared', 'tengo miedo', 'tener miedo (de)'),
  ('I''m in a hurry', 'tengo prisa', 'Latin America: tengo apuro / estoy apurado'),
  ('I''m sleepy', 'tengo sueño', 'el sueño is also ''the dream'''),
  ('I''m lucky', 'tengo suerte', ''),
  ('be careful!', '¡ten cuidado!', 'tener cuidado, imperative'),
  ('I have no idea', 'no tengo ni idea', 'ni = not even'),
  ('it has nothing to do with...', 'no tiene nada que ver con...', 'tener que ver con = to have to do with'),

  -- dar / hacer / echar ...
  ('it scares me', 'me da miedo', 'dar miedo; the scary thing is the subject'),
  ('it embarrasses me', 'me da vergüenza', 'dar vergüenza'),
  ('it makes me sad / I feel sorry', 'me da pena', 'dar pena'),
  ('it disgusts me', 'me da asco', 'dar asco'),
  ('I''m looking forward to it', 'me hace ilusión', 'hacer ilusión; mainly Spain'),
  ('it''s funny to me / it amuses me', 'me hace gracia', 'hacer gracia'),
  ('listen to me! (pay attention)', '¡hazme caso!', 'hacer caso = to pay attention to, to heed'),
  ('I miss you', 'te echo de menos', 'echar de menos, Spain; Latin America: te extraño'),
  ('can you give me a hand?', '¿me echas una mano?', 'echar una mano = to help'),
  ('to take a look', 'echar un vistazo', 'le echo un vistazo = I''ll take a look at it'),
  ('to put your foot in it', 'meter la pata', 'literally ''to put the paw in'''),
  ('it hurts (me)', 'me duele', 'doler works like gustar: me duele la cabeza'),

  -- estar ...
  ('I agree', 'estoy de acuerdo', 'estar de acuerdo (con)'),
  ('I don''t agree', 'no estoy de acuerdo', 'estar de acuerdo'),
  ('I''m sure', 'estoy seguro', 'segura if feminine'),
  ('I''m fed up', 'estoy harto', 'harta if feminine; estoy harto de... = I''m sick of...'),
  ('I''m in a good mood', 'estoy de buen humor', 'de mal humor = in a bad mood'),
  ('I''m exhausted', 'estoy hecho polvo', 'literally ''made dust''; hecha polvo if feminine'),

  -- Opinions and reactions
  ('I think that... / it seems to me that...', 'me parece que...', 'parecer works like gustar'),
  ('I think so', 'creo que sí', ''),
  ('I don''t think so', 'creo que no', ''),
  ('I hope so', 'ojalá', 'ojalá + subjunctive = I hope that...'),
  ('I love it', 'me encanta', 'encantar works like gustar, only stronger'),
  ('I''d love to', 'me encantaría', 'conditional of encantar'),
  ('count me in', 'me apunto', 'apuntarse = to sign up'),
  ('it looks good', 'tiene buena pinta', 'of food or a plan; mainly Spain'),
  ('what a shame!', '¡qué pena!', 'also ¡qué lástima!'),
  ('really? / seriously?', '¿en serio?', ''),
  ('you don''t say! / no way!', '¡no me digas!', 'literally ''don''t tell me'''),
  ('no way! / not at all', '¡qué va!', 'emphatic denial, Spain'),
  ('it is what it is', 'es lo que hay', ''),
  ('no worries / it''s nothing', 'no pasa nada', 'literally ''nothing happens'''),
  ('it''s fine / OK', 'está bien', ''),
  ('OK (Spain)', 'vale', 'the Spanish ''OK''; Latin America: está bien, dale, órale'),
  ('that''s it / exactly', 'eso es', ''),
  ('me too', 'yo también', ''),
  ('me neither', 'yo tampoco', 'also ni yo'),
  ('the same to you', 'igualmente', 'reply to a wish: ¡buen fin de semana! — ¡igualmente!'),
  ('the same thing', 'lo mismo', ''),

  -- Conversation glue
  ('I mean... / that is...', 'o sea...', 'filler and clarifier'),
  ('the thing is...', 'lo que pasa es que...', 'introduces an explanation'),
  ('let''s see', 'a ver', 'two words — not haber'),
  ('by the way', 'por cierto', ''),
  ('in fact / actually', 'de hecho', 'not actualmente, which means ''currently'''),
  ('anyway', 'de todos modos', 'also en fin, de todas formas'),
  ('however', 'sin embargo', ''),
  ('that''s why', 'por eso', ''),
  ('so... (therefore)', 'así que...', ''),
  ('since... (because)', 'ya que...', ''),
  ('at least', 'por lo menos', 'also al menos'),
  ('more or less', 'más o menos', ''),
  ('for example', 'por ejemplo', ''),
  ('on the other hand', 'por otro lado', ''),
  ('maybe (casual)', 'a lo mejor', 'takes the indicative: a lo mejor viene'),

  -- Questions and stock phrases
  ('what''s up? / how''s it going?', '¿qué tal?', '¿qué tal el viaje? = how was the trip?'),
  ('what''s going on? / what''s wrong?', '¿qué pasa?', ''),
  ('what''s happened?', '¿qué ha pasado?', 'Spain; Latin America: ¿qué pasó?'),
  ('what do you mean?', '¿qué quieres decir?', 'querer decir = to mean'),
  ('what does ... mean?', '¿qué significa...?', 'also ¿qué quiere decir...?'),
  ('how do you say...?', '¿cómo se dice...?', 'impersonal se'),
  ('what do you do (for a living)?', '¿a qué te dedicas?', 'dedicarse a = to do for a living'),
  ('I''m from...', 'soy de...', 'ser de = origin'),
  ('I''m off / I''m leaving', 'me voy', 'irse = to leave'),
  ('have a good time!', '¡que lo pases bien!', 'que + subjunctive: a wish'),
  ('enjoy your meal!', '¡que aproveche!', 'que + subjunctive: a wish'),
  ('get well soon!', '¡que te mejores!', 'que + subjunctive: a wish'),
  ('take care', 'cuídate', 'cuidarse, imperative')
on conflict (english) do nothing;
