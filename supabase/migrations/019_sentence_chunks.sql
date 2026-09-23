-- ---------------------------------------------------------------------------
-- Sentence chunks: the pieces sentences are built from, not whole sentences.
--
-- 017 added phrases that stand on their own ("me di cuenta", "no pasa
-- nada"). These are the ones that don't: the multi-word frames that sit
-- *inside* a sentence and carry its structure — "a pesar de...", "lo que...",
-- "en cuanto...", "cerca de...", "pensar en...". Knowing one is being able to
-- map a stretch of a sentence you hear onto a meaning without parsing it word
-- by word, which is the whole reason to learn in chunks.
--
-- `...` marks the slot, as the older cards do ("me llamo..."). The notes
-- carry a short example, because a frame is only learned in use, and say what
-- it takes (subjunctive, infinitive, a particular preposition) where that is
-- the part people get wrong.
--
-- Where the deck already has the single word — cerca, antes, hasta, dentro,
-- un poco — the chunk is the multi-word form, and its English says so
-- ("near to...", "before (doing)...", "until... (+ clause)") so that no two
-- prompts collide and neither card answers the other.
--
-- Grouped: clause openers and connectors; time; place; noun-phrase frames
-- (lo que, el que, lo + adjective, quantities); impersonal frames; question
-- chunks; and verbs that take a fixed preposition.
--
-- Cross-checked against Clozemaster's transition-word list, Spanish
-- Academy's compound prepositions, SpanishDictionary's compound-preposition
-- list, and Kwiziq on ni siquiera. Spain-first, like the rest of the deck.
--
-- Phonemes are in 020 (`npm run db:phones -- --missing=020_...`).
-- ---------------------------------------------------------------------------

insert into public.cards (english, spanish, notes) values
  -- Clause openers
  ('as soon as...', 'en cuanto...', 'subjunctive for the future: en cuanto llegue, te llamo = as soon as I arrive, I''ll call you'),
  ('until... (+ clause)', 'hasta que...', 'subjunctive for the future: hasta que vuelvas = until you come back'),
  ('before (doing)...', 'antes de...', '+ infinitive: antes de salir = before leaving'),
  ('after (doing)...', 'después de...', '+ infinitive: después de comer = after eating'),
  ('before... (+ clause)', 'antes de que...', 'always subjunctive: antes de que te vayas = before you go'),
  ('so that...', 'para que...', 'always subjunctive: te lo digo para que lo sepas = I''m telling you so you know'),
  ('in order to...', 'para...', '+ infinitive: estudio para aprender = I study (in order) to learn'),
  ('despite... / in spite of...', 'a pesar de...', 'a pesar de la lluvia = despite the rain'),
  ('even though... / despite the fact that...', 'a pesar de que...', 'a pesar de que es tarde = even though it''s late'),
  ('although... / even if...', 'aunque...', 'indicative for a fact, subjunctive for a maybe: aunque llueva = even if it rains'),
  ('instead of...', 'en vez de...', 'also en lugar de; + infinitive: en vez de quejarte = instead of complaining'),
  ('whereas... (contrast)', 'mientras que...', 'yo trabajo mientras que él duerme; mientras alone = while (at the same time)'),
  ('meanwhile / in the meantime', 'mientras tanto', ''),
  ('ever since... (+ clause)', 'desde que...', 'present tense where English uses the perfect: desde que vivo aquí = since I''ve lived here'),
  ('since then', 'desde entonces', ''),
  ('it turns out that...', 'resulta que...', 'storytelling: resulta que no era verdad = it turns out it wasn''t true'),
  ('the fact that...', 'el hecho de que...', 'usually takes the subjunctive'),
  ('given that... / seeing as...', 'dado que...', 'a shade more formal than ya que'),
  ('as if...', 'como si...', 'imperfect subjunctive: como si fuera fácil = as if it were easy'),
  ('the more... the more...', 'cuanto más... más...', 'cuanto más practico, más aprendo = the more I practise, the more I learn'),
  ('not only... but also...', 'no solo... sino también...', ''),
  ('not X but (rather) Y', 'no... sino...', 'correcting a negative: no es rojo sino azul = it''s not red but blue'),
  ('either... or...', 'o... o...', 'o vienes o te quedas = either you come or you stay'),
  ('neither... nor...', 'ni... ni...', 'the verb still needs no in front: no tengo ni tiempo ni dinero'),
  ('as... as...', 'tan... como...', 'with an adjective or adverb: tan alto como tú = as tall as you'),
  ('as much as...', 'tanto como...', 'agrees with a noun: tantos libros como tú = as many books as you'),
  ('more than... (a number)', 'más de...', 'before numbers: más de diez = more than ten'),
  ('more than... (comparing)', 'más que...', 'es más alto que yo = he''s taller than me'),

  -- Connectors
  ('rather / if anything', 'más bien', 'correcting: no es tímido, más bien serio = he''s not shy, more serious'),
  ('not even...', 'ni siquiera...', 'ni siquiera me llamó = he didn''t even call me'),
  ('above all / especially', 'sobre todo', ''),
  ('apparently', 'por lo visto', 'hearsay: por lo visto se van a casar = apparently they''re getting married'),
  ('suddenly', 'de repente', 'also de pronto'),
  ('at last / finally', 'por fin', 'relief: ¡por fin! — cf. al final = in the end'),
  ('in general / usually', 'por lo general', ''),
  ('actually (in reality)', 'en realidad', 'actualmente is a false friend: it means ''currently'''),
  ('that is to say / in other words', 'es decir', ''),
  ('without a doubt', 'sin duda', ''),
  ('on the contrary', 'al contrario', ''),
  ('by contrast / instead', 'en cambio', 'yo soy alto; mi hermano, en cambio, es bajo'),
  ('even so', 'aun así', 'no accent: this aun means ''even'''),
  ('after all', 'al fin y al cabo', ''),
  ('in any case', 'en todo caso', ''),
  ('first of all', 'antes que nada', 'also primero que nada'),
  ('judging by...', 'a juzgar por...', ''),
  ('from... on / as of...', 'a partir de...', 'a partir del lunes = from Monday on'),
  ('from now on', 'a partir de ahora', 'also de ahora en adelante'),
  ('so far / until now', 'hasta ahora', 'also a goodbye: ''see you in a bit'''),
  ('through... / by means of...', 'a través de...', 'a través de la ventana; a través de un amigo'),
  ('throughout...', 'a lo largo de...', 'a lo largo del año = throughout the year; also ''along'''),
  ('because of... / due to...', 'debido a...', 'also a causa de'),
  ('because of... (someone''s fault)', 'por culpa de...', 'blame: llegué tarde por culpa del tráfico'),
  ('thanks to...', 'gracias a...', ''),
  ('as for... / regarding...', 'en cuanto a...', 'also respecto a; en cuanto on its own = as soon as'),
  ('about... (a topic)', 'acerca de...', 'also sobre: un libro sobre España'),
  ('according to...', 'según...', 'also ''depending on'': según el día'),
  ('in favour of...', 'a favor de...', ''),
  ('against... (opposed to)', 'en contra de...', 'estoy en contra = I''m against it'),
  ('apart from... / besides...', 'aparte de...', ''),
  ('together with... / along with...', 'junto con...', ''),

  -- Time
  ('in the morning', 'por la mañana', 'por for parts of the day: por la tarde, por la noche'),
  ('at night', 'por la noche', ''),
  ('at three o''clock', 'a las tres', 'a la una for one o''clock'),
  ('this morning', 'esta mañana', ''),
  ('tonight', 'esta noche', ''),
  ('tomorrow morning', 'mañana por la mañana', 'mañana twice, in both its meanings'),
  ('next week', 'la semana que viene', 'also la próxima semana'),
  ('last week', 'la semana pasada', ''),
  ('the day before yesterday', 'anteayer', 'also antes de ayer'),
  ('the day after tomorrow', 'pasado mañana', ''),
  ('once / one time', 'una vez', ''),
  ('twice', 'dos veces', ''),
  ('many times / often', 'muchas veces', ''),
  ('the first time', 'la primera vez', 'es la primera vez que vengo = it''s the first time I''ve come (present tense)'),
  ('the last time', 'la última vez', ''),
  ('this time', 'esta vez', ''),
  ('at the latest', 'como muy tarde', ''),
  ('a little while later', 'al rato', 'al rato llegó = a while later he arrived'),
  ('soon / before long', 'dentro de poco', ''),
  ('in two days (from now)', 'dentro de dos días', 'dentro de + time = in (time from now); hace + time = ago'),
  ('two hours later', 'dos horas después', 'also al cabo de dos horas'),
  ('nowadays', 'hoy en día', ''),
  ('no longer / not any more', 'ya no', 'ya no vivo allí = I don''t live there any more'),
  ('not yet', 'todavía no', 'also aún no'),
  ('I haven''t... in ages', 'hace mucho que no...', 'hace mucho que no lo veo = I haven''t seen him in ages'),
  ('I nearly... / I almost...', 'por poco...', 'present tense for a past near miss: por poco me caigo = I nearly fell'),

  -- Place
  ('next to...', 'al lado de...', ''),
  ('in front of...', 'delante de...', 'cf. enfrente de = opposite, across from'),
  ('opposite... / across from...', 'enfrente de...', ''),
  ('behind...', 'detrás de...', ''),
  ('on top of...', 'encima de...', ''),
  ('under... / underneath...', 'debajo de...', ''),
  ('inside (of)...', 'dentro de...', ''),
  ('outside (of)...', 'fuera de...', ''),
  ('near to... / close to...', 'cerca de...', 'cerca de aquí = near here'),
  ('far from...', 'lejos de...', ''),
  ('around... (surrounding)', 'alrededor de...', 'also ''about'' with numbers: alrededor de las cinco'),
  ('in the middle of...', 'en medio de...', ''),
  ('at home', 'en casa', 'no article: estoy en casa'),
  ('(going) home', 'a casa', 'with motion: voy a casa = I''m going home'),
  ('by car', 'en coche', 'en + transport: en tren, en avión. Latin America: en carro'),
  ('on foot', 'a pie', 'the exception to en + transport'),
  ('everywhere', 'en todas partes', 'also por todas partes'),
  ('somewhere', 'en algún sitio', 'also en alguna parte'),
  ('nowhere', 'en ninguna parte', 'the verb is negated too: no está en ninguna parte'),

  -- Noun-phrase frames
  ('what... (the thing that)', 'lo que...', 'lo que quiero = what I want; no es lo que dije = it''s not what I said'),
  ('everything that...', 'todo lo que...', 'todo lo que necesitas = everything you need'),
  ('the one who... / the one that...', 'el que...', 'agrees: la que, los que, las que. El que llegó tarde = the one who arrived late'),
  ('those who... / the ones that...', 'los que...', ''),
  ('the good thing is that...', 'lo bueno es que...', 'lo + adjective = the ... thing'),
  ('the worst thing is that...', 'lo peor es que...', ''),
  ('the most important thing', 'lo más importante', ''),
  ('the thing about... / that business with...', 'lo de...', 'lo de ayer = what happened yesterday'),
  ('a bit of...', 'un poco de...', 'un poco de agua'),
  ('lots of... (colloquial)', 'un montón de...', ''),
  ('a few...', 'unos cuantos...', 'unas cuantas with a feminine noun'),
  ('a couple of...', 'un par de...', 'un par de días'),
  ('each one', 'cada uno', 'cada una if feminine'),
  ('everyone else / the others', 'los demás', ''),
  ('the rest of...', 'el resto de...', ''),
  ('most of... / the majority of...', 'la mayoría de...', 'la mayoría de la gente = most people'),
  ('half of...', 'la mitad de...', ''),
  ('something else', 'otra cosa', ''),
  ('anything (at all)', 'cualquier cosa', ''),
  ('anything else?', '¿algo más?', ''),
  ('nothing else / that''s all', 'nada más', 'also nada más + infinitive = as soon as: nada más llegar'),
  ('nobody else', 'nadie más', ''),
  ('the same as...', 'igual que...', 'also lo mismo que'),
  ('not at all', 'para nada', 'also en absoluto'),
  ('whatever (it is)', 'lo que sea', ''),
  ('whenever you like', 'cuando quieras', ''),
  ('however you like', 'como quieras', ''),
  ('wherever', 'donde sea', ''),

  -- Impersonal frames
  ('there was / there were', 'había', 'impersonal haber, imperfect; hubo for a one-off event'),
  ('there will be', 'habrá', 'impersonal haber, future'),
  ('there has to be...', 'tiene que haber...', ''),
  ('it seems that...', 'parece que...', 'parece que va a llover = it looks like it''s going to rain'),
  ('it''s clear that...', 'está claro que...', ''),
  ('it''s possible that...', 'es posible que...', 'takes the subjunctive'),
  ('it''s better to...', 'es mejor...', '+ infinitive; es mejor que + subjunctive'),
  ('better not', 'mejor no', ''),
  ('I''m used to...', 'estoy acostumbrado a...', '+ infinitive or noun; acostumbrada if feminine'),
  ('I''m interested in...', 'me interesa...', 'works like gustar: me interesan los idiomas'),
  ('if I were you', 'yo que tú', 'colloquial, mainly Spain; also si yo fuera tú'),

  -- Question chunks
  ('what if...?', '¿y si...?', ''),
  ('how about...? / shall we...?', '¿qué tal si...?', '¿qué tal si vamos al cine?'),
  ('what for?', '¿para qué?', ''),
  ('why not?', '¿por qué no?', ''),
  ('since when?', '¿desde cuándo?', ''),
  ('how often?', '¿cada cuánto?', 'also ¿con qué frecuencia?'),
  ('how many times?', '¿cuántas veces?', ''),
  ('what kind of...?', '¿qué tipo de...?', ''),
  ('whose...?', '¿de quién...?', '¿de quién es? = whose is it?'),
  ('where from?', '¿de dónde?', '¿de dónde eres? = where are you from?'),
  ('do you remember...?', '¿te acuerdas de...?', 'acordarse de; recordar takes no preposition'),

  -- Verbs with a fixed preposition
  ('to think about...', 'pensar en...', 'en, not sobre: pienso en ti'),
  ('to dream of...', 'soñar con...', 'con, not de'),
  ('to depend on...', 'depender de...', ''),
  ('to fall in love with...', 'enamorarse de...', 'de, not con'),
  ('to get married to...', 'casarse con...', ''),
  ('to look like... (resemble)', 'parecerse a...', 'te pareces a tu madre = you look like your mother'),
  ('to try to...', 'tratar de...', 'also intentar + infinitive'),
  ('to count on...', 'contar con...', ''),
  ('to insist on...', 'insistir en...', ''),
  ('to forget about...', 'olvidarse de...', 'me olvidé de ti; olvidar takes no preposition'),
  ('to complain about...', 'quejarse de...', ''),
  ('to get used to...', 'acostumbrarse a...', ''),
  ('to worry about...', 'preocuparse por...', ''),
  ('to ask after... / ask about...', 'preguntar por...', 'me preguntó por ti = he asked after you'),
  ('to laugh at...', 'reírse de...', ''),
  ('to say goodbye to...', 'despedirse de...', ''),
  ('to leave... (a place)', 'salir de...', 'salgo de casa a las ocho'),
  ('to go into...', 'entrar en...', 'Latin America: entrar a'),
  ('to arrange to meet...', 'quedar con...', 'Spain: he quedado con Ana'),
  ('to agree to... (arrange)', 'quedar en...', 'quedamos en vernos = we agreed to meet'),
  ('to take care of... / be in charge of...', 'encargarse de...', ''),
  ('to get on well with...', 'llevarse bien con...', ''),
  ('to fall asleep', 'quedarse dormido', '')
on conflict (english) do nothing;
