#!/usr/bin/env python3
"""Regenerate supabase/migrations/011_seed_cards.sql — the starter deck.

Two kinds of card:

1. **Conjugation drills.** 100 verbs x (5 simple tenses x 6 persons + the
   infinitive) = 3,100 cards. The Spanish forms come from `verbecc`, whose
   Spanish tables are template data rather than derived endings, so irregulars
   are looked up and not guessed. Nothing here reaches the ML fallback: any
   verb not in verbecc's dictionary would raise, and CHECKS below is a tripwire
   of forms verified by hand against the RAE paradigms.

2. **Vocabulary.** ~300 hand-written common words and phrases, nouns carrying
   their article so gender is learned with the word.

GENERATED FILE — do not edit the migration by hand. Regenerate with:
    python3 -m venv .venv && .venv/bin/pip install wordfreq verbecc
    .venv/bin/python scripts/gen-seed-cards.py

## Which 100 verbs

Ranked by corpus frequency: for every one of verbecc's 9,732 infinitives, the
summed `wordfreq` frequency of its imperfect, preterite, future and conditional
forms. Those endings are what make the ranking usable — scoring the present
tense too puts `parar` second ("para" is a preposition), `casar` nineteenth
("casa" is a house) and `nadar` twentieth ("nada" is nothing).

The top of that ranking is then curated, and the deviations are deliberate:

* Three ranking artefacts dropped: `asir` (from "así"), `veer` and `garantir`
  (misparsed variants).
* Ten news-register verbs (publicar, anunciar, declarar, informar, afirmar,
  señalar, celebrar, participar, iniciar, lanzar) traded for everyday ones the
  corpus under-counts: comer, beber, dormir, oír, andar, correr, cerrar,
  romper, levantar, comprender. Subtitle and newswire Spanish is not kitchen
  Spanish.
* `gustar` and `nacer` are excluded from the drills and appear in the
  vocabulary instead. Conjugating them through six persons teaches the wrong
  thing: "yo gusto" is not "I like", it's "I am pleasing" (gustar agrees with
  the thing liked, hence the me/te/le phrases below), and "I am born" is not a
  sentence anyone needs. `aceptar` and `compartir` take their slots.

## Card shape

Prompt side carries the verb and, for the two past tenses, the tense:

    "I spoke (hablar, preterite)"   ->  "yo hablé"
    "I used to speak (hablar, imperfect)"  ->  "yo hablaba"

The infinitive is in the prompt on purpose: the skill being drilled is the
conjugation, not the vocabulary. The infinitive cards themselves are the other
way round ("to speak" -> "hablar"), so those glosses have to be unique on their
own — hence `inf_en` on ser/estar, saber/conocer and the rest of the pairs that
share an English word.

The Spanish keeps the subject pronoun ("yo hablo", not "hablo"). Spanish drops
it in speech, but the imperfect and conditional have identical yo and él forms,
and without the pronoun the Spanish->English direction would be asking you to
guess which one it wanted.

"you (plural)" is **vosotros**, the sixth distinct form. Latin America uses
ustedes with the ellos form, which every 2nd-person-plural card says in its
notes.
"""

from __future__ import annotations

from pathlib import Path

import verbecc

OUT = Path(__file__).resolve().parent.parent / "supabase" / "migrations" / "011_seed_cards.sql"
BATCH = 150

# --- the paradigm ----------------------------------------------------------

# (english subject, spanish pronoun, verbecc pronoun, notes label)
PERSONS = [
    ("I", "yo", "yo", "yo"),
    ("you", "tú", "tú", "tú"),
    ("he/she", "él", "él", "él/ella"),
    ("we", "nosotros", "nosotros", "nosotros"),
    ("you all", "vosotros", "vosotros", "vosotros"),
    ("they", "ellos", "ellos", "ellos/ellas"),
]

# (key, verbecc mood, verbecc tense, Spanish name, prompt label)
TENSES = [
    ("present", "indicativo", "presente", "presente", None),
    ("preterite", "indicativo", "pretérito-perfecto-simple", "pretérito perfecto simple", "preterite"),
    ("imperfect", "indicativo", "pretérito-imperfecto", "pretérito imperfecto", "imperfect"),
    ("future", "indicativo", "futuro", "futuro simple", None),
    ("conditional", "condicional", "presente", "condicional simple", None),
]

# Tenses whose yo and él/ella forms are always identical.
SYNCRETIC = {"imperfect", "conditional"}

# --- the verbs -------------------------------------------------------------
# base / third person singular / simple past are the English forms the prompts
# are built from. `inf_en` overrides the infinitive card's gloss where "to " +
# base would collide with another verb's. `en` overrides the English predicate
# for a whole tense, six entries in PERSONS order, for the verbs English
# handles with an auxiliary rather than an inflection.

BE_PRESENT = ["am", "are", "is", "are", "are", "are"]
BE_PAST = ["was", "were", "was", "were", "were", "were"]

VERBS: list[dict] = [
    dict(inf="ser", base="be", third="is", past="was",
         inf_en="to be (permanent — identity, origin, qualities)",
         en={"present": BE_PRESENT, "preterite": BE_PAST},
         note="permanent qualities, identity, origin, time; cf. estar. Shares its preterite with ir"),
    dict(inf="ir", base="go", third="goes", past="went",
         note="ir a + infinitive is the everyday future: voy a comer. Shares its preterite with ser"),
    dict(inf="estar", base="be", third="is", past="was",
         inf_en="to be (temporary — state, location, mood)",
         en={"present": BE_PRESENT, "preterite": BE_PAST},
         note="states, location and moods; cf. ser"),
    dict(inf="haber", base="have", third="has", past="had",
         inf_en="to have (auxiliary)",
         note="auxiliary only: pairs with a participle — he comido = I have eaten. "
              "For 'have' as possession use tener; the impersonal 'there is/are' is hay"),
    dict(inf="tener", base="have", third="has", past="had", inf_en="to have (to possess)",
         note="tener que + infinitive = to have to; tener hambre/sed/años = to be hungry/thirsty/years old"),
    dict(inf="hacer", base="do", third="does", past="did", inf_en="to do / to make",
         note="also 'to make'; hace frío/calor = it's cold/hot"),
    dict(inf="decir", base="say", third="says", past="said"),
    dict(inf="poder", base="be able to", third="is able to", past="was able to",
         inf_en="to be able to (can)",
         en={"present": ["can"] * 6,
             "preterite": ["was able to", "were able to", "was able to",
                           "were able to", "were able to", "were able to"],
             "imperfect": ["used to be able to"] * 6,
             "future": ["will be able to"] * 6,
             "conditional": ["could"] * 6},
         note="podría (conditional) is the polite 'could': ¿podrías ayudarme?"),
    dict(inf="dar", base="give", third="gives", past="gave"),
    dict(inf="ver", base="see", third="sees", past="saw"),
    dict(inf="llegar", base="arrive", third="arrives", past="arrived"),
    dict(inf="querer", base="want", third="wants", past="wanted",
         note="querer a alguien = to love someone; quisiera is the polite 'I would like'"),
    dict(inf="encontrar", base="find", third="finds", past="found",
         note="encontrarse con = to run into someone"),
    dict(inf="dejar", base="leave", third="leaves", past="left",
         note="leave behind; also 'to let, to allow' — déjame = let me"),
    dict(inf="quedar", base="stay", third="stays", past="stayed",
         note="quedarse = to stay put; quedar con = to arrange to meet"),
    dict(inf="llevar", base="carry", third="carries", past="carried",
         note="also 'to take (along)' and 'to wear'"),
    dict(inf="poner", base="put", third="puts", past="put",
         note="ponerse = to put on (clothes), to become"),
    dict(inf="saber", base="know", third="knows", past="knew",
         inf_en="to know (a fact, how to do something)",
         note="facts and skills: sé nadar = I know how to swim; cf. conocer"),
    dict(inf="venir", base="come", third="comes", past="came"),
    dict(inf="salir", base="go out", third="goes out", past="went out",
         note="also 'to leave (a place)' and 'to go out (socially)'"),
    dict(inf="seguir", base="follow", third="follows", past="followed",
         note="also 'to keep on': sigue lloviendo = it's still raining"),
    dict(inf="pensar", base="think", third="thinks", past="thought",
         note="pensar en = to think about; pensar + infinitive = to plan to"),
    dict(inf="deber", base="have to", third="has to", past="had to",
         inf_en="to have to / should",
         en={"present": ["must"] * 6,
             "preterite": ["should have"] * 6,
             "imperfect": ["was supposed to", "were supposed to", "was supposed to",
                           "were supposed to", "were supposed to", "were supposed to"],
             "future": ["will have to"] * 6,
             "conditional": ["should"] * 6},
         note="obligation; debería = I should. Also 'to owe'"),
    dict(inf="empezar", base="start", third="starts", past="started",
         note="empezar a + infinitive = to start doing"),
    dict(inf="volver", base="return", third="returns", past="returned",
         note="also 'to do again': volver a llamar = to call again"),
    dict(inf="hablar", base="speak", third="speaks", past="spoke"),
    dict(inf="comenzar", base="begin", third="begins", past="began"),
    dict(inf="tomar", base="take", third="takes", past="took",
         note="also 'to drink' — the usual verb for it in Latin America"),
    dict(inf="recibir", base="receive", third="receives", past="received"),
    dict(inf="morir", base="die", third="dies", past="died"),
    dict(inf="necesitar", base="need", third="needs", past="needed"),
    dict(inf="perder", base="lose", third="loses", past="lost",
         note="also 'to miss (a train)'; perderse = to get lost"),
    dict(inf="pedir", base="ask for", third="asks for", past="asked for",
         note="request something; cf. preguntar (ask a question)"),
    dict(inf="llamar", base="call", third="calls", past="called",
         note="llamarse = to be called: me llamo Toby"),
    dict(inf="sentir", base="feel", third="feels", past="felt",
         note="sentirse = to feel (a way); lo siento = I'm sorry"),
    dict(inf="terminar", base="finish", third="finishes", past="finished"),
    dict(inf="vivir", base="live", third="lives", past="lived"),
    dict(inf="ganar", base="win", third="wins", past="won", note="also 'to earn'"),
    dict(inf="esperar", base="wait for", third="waits for", past="waited for",
         note="also 'to hope' and 'to expect'"),
    dict(inf="escribir", base="write", third="writes", past="wrote"),
    dict(inf="parecer", base="seem", third="seems", past="seemed",
         note="parecerse a = to look like"),
    dict(inf="decidir", base="decide", third="decides", past="decided"),
    dict(inf="conocer", base="know", third="knows", past="knew",
         inf_en="to know (a person or place)",
         note="people and places; in the preterite it means 'met': la conocí ayer"),
    dict(inf="contar", base="count", third="counts", past="counted",
         note="also 'to tell (a story)'; contar con = to rely on"),
    dict(inf="tratar", base="treat", third="treats", past="treated",
         note="tratar de + infinitive = to try to; tratarse de = to be about"),
    dict(inf="entrar", base="enter", third="enters", past="entered"),
    dict(inf="preguntar", base="ask", third="asks", past="asked",
         note="ask a question; cf. pedir (ask for something)"),
    dict(inf="trabajar", base="work", third="works", past="worked"),
    dict(inf="usar", base="use", third="uses", past="used"),
    dict(inf="convertir", base="convert", third="converts", past="converted",
         note="convertirse en = to turn into"),
    dict(inf="creer", base="believe", third="believes", past="believed",
         note="also 'to think': creo que sí = I think so"),
    dict(inf="acabar", base="end", third="ends", past="ended",
         note="acabar de + infinitive = to have just done something"),
    dict(inf="intentar", base="try", third="tries", past="tried"),
    dict(inf="traer", base="bring", third="brings", past="brought"),
    dict(inf="cambiar", base="change", third="changes", past="changed"),
    dict(inf="aceptar", base="accept", third="accepts", past="accepted"),
    dict(inf="caer", base="fall", third="falls", past="fell",
         note="caerse is the usual form for falling over"),
    dict(inf="sacar", base="take out", third="takes out", past="took out",
         note="also 'to take (a photo)' and 'to get (a mark)'"),
    dict(inf="buscar", base="look for", third="looks for", past="looked for"),
    dict(inf="aparecer", base="appear", third="appears", past="appeared"),
    dict(inf="compartir", base="share", third="shares", past="shared"),
    dict(inf="permitir", base="allow", third="allows", past="allowed"),
    dict(inf="ocurrir", base="happen", third="happens", past="happened",
         note="se me ocurrió = it occurred to me"),
    dict(inf="conseguir", base="get", third="gets", past="got",
         note="obtain; conseguir + infinitive = to manage to"),
    dict(inf="enviar", base="send", third="sends", past="sent",
         note="mandar is the more colloquial 'send'"),
    dict(inf="mostrar", base="show", third="shows", past="showed"),
    dict(inf="crear", base="create", third="creates", past="created"),
    dict(inf="abrir", base="open", third="opens", past="opened"),
    dict(inf="ayudar", base="help", third="helps", past="helped"),
    dict(inf="escuchar", base="listen to", third="listens to", past="listened to"),
    dict(inf="jugar", base="play", third="plays", past="played",
         note="games and sport; for instruments use tocar"),
    dict(inf="matar", base="kill", third="kills", past="killed"),
    dict(inf="comprar", base="buy", third="buys", past="bought"),
    dict(inf="entender", base="understand", third="understands", past="understood",
         inf_en="to understand"),
    dict(inf="pagar", base="pay", third="pays", past="paid"),
    dict(inf="continuar", base="continue", third="continues", past="continued"),
    dict(inf="responder", base="answer", third="answers", past="answered"),
    dict(inf="leer", base="read", third="reads", past="read"),
    dict(inf="descubrir", base="discover", third="discovers", past="discovered"),
    dict(inf="subir", base="go up", third="goes up", past="went up",
         note="also 'to raise', 'to upload' and 'to get on (a bus)'"),
    dict(inf="mantener", base="keep", third="keeps", past="kept",
         note="also 'to maintain'; conjugates like tener"),
    dict(inf="servir", base="serve", third="serves", past="served",
         note="servir para = to be used for"),
    dict(inf="explicar", base="explain", third="explains", past="explained"),
    dict(inf="aprender", base="learn", third="learns", past="learned"),
    dict(inf="ofrecer", base="offer", third="offers", past="offered"),
    dict(inf="mirar", base="look at", third="looks at", past="looked at",
         note="also 'to watch'"),
    dict(inf="tocar", base="touch", third="touches", past="touched",
         note="also 'to play (an instrument)' and 'to knock'"),
    dict(inf="olvidar", base="forget", third="forgets", past="forgot",
         note="olvidarse de is more common in speech"),
    dict(inf="recordar", base="remember", third="remembers", past="remembered",
         note="also 'to remind'"),
    dict(inf="presentar", base="introduce", third="introduces", past="introduced",
         note="introduce people; also 'to present'"),
    dict(inf="comer", base="eat", third="eats", past="ate"),
    dict(inf="beber", base="drink", third="drinks", past="drank",
         note="tomar is more common in Latin America"),
    dict(inf="dormir", base="sleep", third="sleeps", past="slept",
         note="dormirse = to fall asleep"),
    dict(inf="oír", base="hear", third="hears", past="heard",
         note="hearing, not listening; cf. escuchar"),
    dict(inf="andar", base="walk", third="walks", past="walked",
         note="also 'to go about, to be up to'; caminar is the plain 'walk'"),
    dict(inf="correr", base="run", third="runs", past="ran"),
    dict(inf="cerrar", base="close", third="closes", past="closed"),
    dict(inf="romper", base="break", third="breaks", past="broke"),
    dict(inf="levantar", base="lift", third="lifts", past="lifted",
         note="levantarse = to get up"),
    dict(inf="comprender", base="understand", third="understands", past="understood",
         inf_en="to comprehend", note="interchangeable with entender, a shade more formal"),
]

# verbecc puts the impersonal "hay" in haber's 3rd-singular present slot. The
# paradigm form is "ha" (él ha comido); "hay" is a separate vocabulary card.
FORM_OVERRIDES = {("haber", "present", "él"): "ha"}

# --- tripwire --------------------------------------------------------------
# Forms checked by hand against the RAE paradigms, covering every shape of
# irregularity in the list: strong preterites, irregular future stems, the
# g/zc/j consonant changes, e->ie / o->ue / e->i stem changes, the
# orthographic c->qu / g->gu / z->c shifts, i->y in -eer/-oír, and the
# accented -iar/-uar verbs. If a verbecc upgrade moves any of these, the
# generator stops rather than writing a deck of plausible-looking nonsense.
CHECKS: dict[tuple[str, str, str], str] = {
    ("ser", "present", "yo"): "soy",
    ("ser", "present", "vosotros"): "sois",
    ("ser", "preterite", "yo"): "fui",
    ("ser", "imperfect", "yo"): "era",
    ("ir", "present", "yo"): "voy",
    ("ir", "present", "nosotros"): "vamos",
    ("ir", "preterite", "él"): "fue",
    ("ir", "imperfect", "yo"): "iba",
    ("estar", "present", "yo"): "estoy",
    ("estar", "present", "tú"): "estás",
    ("estar", "preterite", "yo"): "estuve",
    ("haber", "present", "yo"): "he",
    ("haber", "present", "él"): "ha",
    ("haber", "preterite", "él"): "hubo",
    ("tener", "present", "yo"): "tengo",
    ("tener", "preterite", "yo"): "tuve",
    ("tener", "future", "yo"): "tendré",
    ("hacer", "present", "yo"): "hago",
    ("hacer", "preterite", "él"): "hizo",
    ("hacer", "future", "yo"): "haré",
    ("decir", "present", "yo"): "digo",
    ("decir", "preterite", "ellos"): "dijeron",
    ("decir", "future", "yo"): "diré",
    ("poder", "present", "yo"): "puedo",
    ("poder", "preterite", "yo"): "pude",
    ("poder", "conditional", "yo"): "podría",
    ("poner", "preterite", "yo"): "puse",
    ("poner", "future", "yo"): "pondré",
    ("dar", "present", "yo"): "doy",
    ("dar", "preterite", "yo"): "di",
    ("dar", "preterite", "él"): "dio",
    ("ver", "present", "yo"): "veo",
    ("ver", "preterite", "él"): "vio",
    ("ver", "imperfect", "yo"): "veía",
    ("saber", "present", "yo"): "sé",
    ("saber", "preterite", "yo"): "supe",
    ("saber", "future", "yo"): "sabré",
    ("querer", "present", "yo"): "quiero",
    ("querer", "preterite", "yo"): "quise",
    ("querer", "future", "yo"): "querré",
    ("venir", "present", "yo"): "vengo",
    ("venir", "preterite", "él"): "vino",
    ("venir", "future", "yo"): "vendré",
    ("salir", "present", "yo"): "salgo",
    ("salir", "future", "yo"): "saldré",
    ("traer", "present", "yo"): "traigo",
    ("traer", "preterite", "yo"): "traje",
    ("andar", "preterite", "yo"): "anduve",
    ("caer", "present", "yo"): "caigo",
    ("caer", "preterite", "él"): "cayó",
    ("oír", "present", "yo"): "oigo",
    ("oír", "present", "tú"): "oyes",
    ("oír", "preterite", "él"): "oyó",
    ("leer", "preterite", "él"): "leyó",
    ("creer", "preterite", "él"): "creyó",
    ("conocer", "present", "yo"): "conozco",
    ("parecer", "present", "yo"): "parezco",
    ("ofrecer", "present", "yo"): "ofrezco",
    ("dormir", "present", "yo"): "duermo",
    ("dormir", "preterite", "él"): "durmió",
    ("morir", "preterite", "él"): "murió",
    ("sentir", "present", "yo"): "siento",
    ("sentir", "preterite", "él"): "sintió",
    ("pedir", "present", "yo"): "pido",
    ("pedir", "preterite", "él"): "pidió",
    ("seguir", "present", "yo"): "sigo",
    ("seguir", "preterite", "él"): "siguió",
    ("servir", "present", "yo"): "sirvo",
    ("pensar", "present", "yo"): "pienso",
    ("perder", "present", "yo"): "pierdo",
    ("cerrar", "present", "yo"): "cierro",
    ("entender", "present", "yo"): "entiendo",
    ("volver", "present", "yo"): "vuelvo",
    ("contar", "present", "yo"): "cuento",
    ("mostrar", "present", "yo"): "muestro",
    ("encontrar", "present", "yo"): "encuentro",
    ("recordar", "present", "yo"): "recuerdo",
    ("jugar", "present", "yo"): "juego",
    ("jugar", "preterite", "yo"): "jugué",
    ("empezar", "present", "yo"): "empiezo",
    ("empezar", "preterite", "yo"): "empecé",
    ("comenzar", "preterite", "yo"): "comencé",
    ("llegar", "preterite", "yo"): "llegué",
    ("pagar", "preterite", "yo"): "pagué",
    ("buscar", "preterite", "yo"): "busqué",
    ("sacar", "preterite", "yo"): "saqué",
    ("tocar", "preterite", "yo"): "toqué",
    ("explicar", "preterite", "yo"): "expliqué",
    ("enviar", "present", "yo"): "envío",
    ("continuar", "present", "yo"): "continúo",
    ("conseguir", "present", "yo"): "consigo",
    ("convertir", "present", "yo"): "convierto",
    ("mantener", "preterite", "yo"): "mantuve",
    ("mantener", "future", "yo"): "mantendré",
    ("hablar", "present", "yo"): "hablo",
    ("hablar", "imperfect", "él"): "hablaba",
    ("hablar", "conditional", "vosotros"): "hablaríais",
    ("comer", "present", "vosotros"): "coméis",
    ("vivir", "present", "nosotros"): "vivimos",
}

# --- vocabulary ------------------------------------------------------------
# (english, spanish, notes). Nouns carry their article so the gender is learned
# with the word; where Spain and Latin America differ the notes say so.

WORDS: list[tuple[str, str, str]] = [
    # Greetings and everyday phrases
    ("hello", "hola", "greeting"),
    ("goodbye", "adiós", "greeting"),
    ("good morning", "buenos días", "greeting — plural in Spanish"),
    ("good afternoon", "buenas tardes", "greeting — from about 2pm"),
    ("good evening / good night", "buenas noches", "greeting and farewell"),
    ("see you later", "hasta luego", "the everyday goodbye, more common than adiós"),
    ("see you tomorrow", "hasta mañana", "farewell"),
    ("please", "por favor", ""),
    ("thank you", "gracias", ""),
    ("thank you very much", "muchas gracias", ""),
    ("you're welcome", "de nada", "literally 'of nothing'"),
    ("sorry", "lo siento", "literally 'I feel it'"),
    ("excuse me", "perdón", "also disculpe to get someone's attention"),
    ("how are you?", "¿cómo estás?", "informal; ¿cómo está usted? is formal"),
    ("nice to meet you", "mucho gusto", ""),
    ("what's your name?", "¿cómo te llamas?", "literally 'what do you call yourself?'"),
    ("my name is...", "me llamo...", "literally 'I call myself'"),
    ("yes", "sí", "with an accent — si without one means 'if'"),
    ("no", "no", ""),
    ("maybe", "quizás", "also tal vez"),
    ("of course", "por supuesto", "also claro"),
    ("I don't know", "no lo sé", ""),
    ("I don't understand", "no entiendo", ""),
    ("can you help me?", "¿me puedes ayudar?", ""),
    ("how much does it cost?", "¿cuánto cuesta?", ""),
    ("where is the bathroom?", "¿dónde está el baño?", ""),
    ("what time is it?", "¿qué hora es?", ""),
    ("I would like...", "me gustaría...", "the polite way to order or ask"),
    ("there is / there are", "hay", "impersonal form of haber — one word for both"),
    ("I have to...", "tengo que...", "tener que + infinitive"),
    ("let's go", "vamos", "also 'we go' — the present of ir"),
    ("right now", "ahora mismo", ""),
    ("every day", "todos los días", ""),
    ("I'm hungry", "tengo hambre", "literally 'I have hunger'"),
    ("I'm thirsty", "tengo sed", "literally 'I have thirst'"),
    ("I'm tired", "estoy cansado", "cansada if you're feminine — estar, not ser"),
    ("it's cold", "hace frío", "weather: hacer, not ser or estar"),
    ("it's hot", "hace calor", "weather"),
    ("how old are you?", "¿cuántos años tienes?", "literally 'how many years do you have?'"),
    ("I like it", "me gusta", "gustar agrees with the thing liked, not the liker: "
                              "me gusta el café, me gustan los libros"),
    ("you like it", "te gusta", "gustar takes an indirect object pronoun"),
    ("he/she likes it", "le gusta", "gustar takes an indirect object pronoun"),
    ("we like it", "nos gusta", "gustar takes an indirect object pronoun"),
    ("you all like it", "os gusta", "vosotros form; Latin America uses les gusta"),
    ("they like it", "les gusta", "gustar takes an indirect object pronoun"),
    ("to like", "gustar", "never conjugated through yo/tú: the thing liked is the subject"),
    ("to be born", "nacer", "mostly used in the preterite: nací en Londres = I was born in London"),
    # Question words
    ("what", "qué", "accented in questions"),
    ("who", "quién", "quiénes for plural"),
    ("where", "dónde", "adónde for 'to where'"),
    ("when", "cuándo", ""),
    ("why", "por qué", "two words; porque as one means 'because'"),
    ("because", "porque", "one word, no accent"),
    ("how", "cómo", ""),
    ("how much", "cuánto", "cuántos for 'how many'"),
    ("which", "cuál", "cuáles for plural"),
    # Pronouns and possessives
    ("I (pronoun)", "yo", "usually dropped — the verb ending says who"),
    ("you (informal)", "tú", "accented; tu without an accent means 'your'"),
    ("you (formal)", "usted", "takes the él/ella verb form"),
    ("he", "él", "accented; el without one is 'the'"),
    ("she", "ella", ""),
    ("we", "nosotros", "nosotras if the group is all feminine"),
    ("they", "ellos", "ellas if all feminine"),
    ("my", "mi", "mis before a plural noun"),
    ("your", "tu", "tus before a plural noun"),
    ("his / her / their", "su", "sus before a plural noun"),
    ("our", "nuestro", "agrees: nuestra casa, nuestros amigos"),
    ("with me", "conmigo", "one word; likewise contigo"),
    # Numbers
    ("zero", "cero", "number"),
    ("one", "uno", "number — un before a masculine noun, una before a feminine one"),
    ("two", "dos", "number"),
    ("three", "tres", "number"),
    ("four", "cuatro", "number"),
    ("five", "cinco", "number"),
    ("six", "seis", "number"),
    ("seven", "siete", "number"),
    ("eight", "ocho", "number"),
    ("nine", "nueve", "number"),
    ("ten", "diez", "number"),
    ("eleven", "once", "number"),
    ("twelve", "doce", "number"),
    ("thirteen", "trece", "number"),
    ("fourteen", "catorce", "number"),
    ("fifteen", "quince", "number"),
    ("sixteen", "dieciséis", "number — one word, accented"),
    ("seventeen", "diecisiete", "number"),
    ("eighteen", "dieciocho", "number"),
    ("nineteen", "diecinueve", "number"),
    ("twenty", "veinte", "number"),
    ("twenty-one", "veintiuno", "number — 21 to 29 are one word"),
    ("thirty", "treinta", "number"),
    ("forty", "cuarenta", "number"),
    ("fifty", "cincuenta", "number"),
    ("sixty", "sesenta", "number"),
    ("seventy", "setenta", "number"),
    ("eighty", "ochenta", "number"),
    ("ninety", "noventa", "number"),
    ("one hundred", "cien", "number — ciento before another number: ciento uno"),
    ("one thousand", "mil", "number"),
    ("first", "primero", "ordinal — primer before a masculine noun"),
    ("second (ordinal)", "segundo", "ordinal"),
    ("last", "último", ""),
    # Days and months
    ("Monday", "el lunes", "days are masculine and lowercase in Spanish"),
    ("Tuesday", "el martes", "day"),
    ("Wednesday", "el miércoles", "day"),
    ("Thursday", "el jueves", "day"),
    ("Friday", "el viernes", "day"),
    ("Saturday", "el sábado", "day"),
    ("Sunday", "el domingo", "day"),
    ("January", "enero", "months are lowercase in Spanish"),
    ("February", "febrero", "month"),
    ("March", "marzo", "month"),
    ("April", "abril", "month"),
    ("May", "mayo", "month"),
    ("June", "junio", "month"),
    ("July", "julio", "month"),
    ("August", "agosto", "month"),
    ("September", "septiembre", "month"),
    ("October", "octubre", "month"),
    ("November", "noviembre", "month"),
    ("December", "diciembre", "month"),
    # Time
    ("today", "hoy", ""),
    ("tomorrow", "mañana", "also 'morning' — la mañana"),
    ("yesterday", "ayer", ""),
    ("now", "ahora", ""),
    ("later", "más tarde", ""),
    ("always", "siempre", ""),
    ("never", "nunca", ""),
    ("sometimes", "a veces", ""),
    ("often", "a menudo", ""),
    ("early", "temprano", ""),
    ("late", "tarde", "also la tarde = the afternoon"),
    ("already", "ya", "also 'now' or 'enough' depending on tone"),
    ("still / yet", "todavía", "also aún"),
    ("the day", "el día", "noun, masculine despite the -a"),
    ("the week", "la semana", "noun, feminine"),
    ("the month", "el mes", "noun, masculine"),
    ("the year", "el año", "noun, masculine — el ano is something else entirely"),
    ("the hour", "la hora", "noun, feminine — also 'the time' as in what time"),
    ("the minute", "el minuto", "noun, masculine"),
    ("the morning", "la mañana", "noun, feminine"),
    ("the afternoon", "la tarde", "noun, feminine — until about 8pm"),
    ("the night", "la noche", "noun, feminine"),
    ("the weekend", "el fin de semana", "noun, masculine"),
    # People and family
    ("the man", "el hombre", "noun, masculine"),
    ("the woman", "la mujer", "noun, feminine — also 'wife'"),
    ("the person", "la persona", "noun, feminine, even for a man"),
    ("the people", "la gente", "noun, feminine and singular: la gente está"),
    ("the family", "la familia", "noun, feminine"),
    ("the mother", "la madre", "noun, feminine"),
    ("the father", "el padre", "noun, masculine"),
    ("the parents", "los padres", "noun, masculine plural — also 'the fathers'"),
    ("the son", "el hijo", "noun, masculine"),
    ("the daughter", "la hija", "noun, feminine"),
    ("the brother", "el hermano", "noun, masculine"),
    ("the sister", "la hermana", "noun, feminine"),
    ("the grandfather", "el abuelo", "noun, masculine"),
    ("the grandmother", "la abuela", "noun, feminine"),
    ("the husband", "el marido", "noun, masculine — also el esposo"),
    ("the wife", "la esposa", "noun, feminine — also la mujer"),
    ("the boyfriend", "el novio", "noun, masculine — also 'groom'"),
    ("the girlfriend", "la novia", "noun, feminine — also 'bride'"),
    ("the friend", "el amigo", "noun, masculine — la amiga if feminine"),
    ("the child", "el niño", "noun, masculine — la niña if feminine"),
    ("the baby", "el bebé", "noun, masculine"),
    ("the name", "el nombre", "noun, masculine"),
    # Food and drink
    ("the water", "el agua", "noun, feminine but takes el: el agua fría"),
    ("the bread", "el pan", "noun, masculine"),
    ("the milk", "la leche", "noun, feminine"),
    ("the coffee", "el café", "noun, masculine — also 'the café'"),
    ("the tea", "el té", "noun, masculine, accented"),
    ("the wine", "el vino", "noun, masculine — also 'he/she came'"),
    ("the beer", "la cerveza", "noun, feminine"),
    ("the meat", "la carne", "noun, feminine"),
    ("the chicken", "el pollo", "noun, masculine"),
    ("the fish", "el pescado", "noun, masculine — el pez is a live one"),
    ("the egg", "el huevo", "noun, masculine"),
    ("the cheese", "el queso", "noun, masculine"),
    ("the rice", "el arroz", "noun, masculine"),
    ("the fruit", "la fruta", "noun, feminine"),
    ("the apple", "la manzana", "noun, feminine"),
    ("the orange (fruit)", "la naranja", "noun, feminine"),
    ("the banana", "el plátano", "noun, masculine — la banana in parts of Latin America"),
    ("the vegetable", "la verdura", "noun, feminine, often plural: las verduras"),
    ("the potato", "la patata", "noun, feminine — la papa in Latin America"),
    ("the tomato", "el tomate", "noun, masculine"),
    ("the onion", "la cebolla", "noun, feminine"),
    ("the salt", "la sal", "noun, feminine"),
    ("the sugar", "el azúcar", "noun, masculine"),
    ("the oil", "el aceite", "noun, masculine"),
    ("the breakfast", "el desayuno", "noun, masculine"),
    ("the lunch", "el almuerzo", "noun, masculine — la comida in Spain"),
    ("the dinner", "la cena", "noun, feminine"),
    ("the food", "la comida", "noun, feminine — also 'the meal'"),
    ("the plate", "el plato", "noun, masculine — also 'the dish'"),
    ("the glass", "el vaso", "noun, masculine — la copa for wine"),
    ("the bill (restaurant)", "la cuenta", "noun, feminine — also 'the account'"),
    # House
    ("the house", "la casa", "noun, feminine"),
    ("the home", "el hogar", "noun, masculine"),
    ("the room", "la habitación", "noun, feminine"),
    ("the kitchen", "la cocina", "noun, feminine — also 'the cooker'"),
    ("the bathroom", "el baño", "noun, masculine"),
    ("the bedroom", "el dormitorio", "noun, masculine — also la habitación"),
    ("the living room", "el salón", "noun, masculine — also la sala de estar"),
    ("the door", "la puerta", "noun, feminine"),
    ("the window", "la ventana", "noun, feminine"),
    ("the table", "la mesa", "noun, feminine"),
    ("the chair", "la silla", "noun, feminine"),
    ("the bed", "la cama", "noun, feminine"),
    ("the floor", "el suelo", "noun, masculine — also 'the ground'"),
    ("the wall", "la pared", "noun, feminine"),
    ("the key", "la llave", "noun, feminine"),
    ("the light", "la luz", "noun, feminine"),
    ("the garden", "el jardín", "noun, masculine"),
    ("the mirror", "el espejo", "noun, masculine"),
    ("the clothes", "la ropa", "noun, feminine and singular in Spanish"),
    ("the towel", "la toalla", "noun, feminine"),
    # Body
    ("the head", "la cabeza", "noun, feminine"),
    ("the hand", "la mano", "noun, feminine despite the -o"),
    ("the eye", "el ojo", "noun, masculine"),
    ("the mouth", "la boca", "noun, feminine"),
    ("the hair", "el pelo", "noun, masculine, singular for a whole head of it"),
    ("the arm", "el brazo", "noun, masculine"),
    ("the leg", "la pierna", "noun, feminine"),
    ("the foot", "el pie", "noun, masculine"),
    ("the heart", "el corazón", "noun, masculine"),
    ("the face", "la cara", "noun, feminine"),
    ("the tooth", "el diente", "noun, masculine"),
    ("the ear", "la oreja", "noun, feminine — el oído is the inner ear"),
    ("the back", "la espalda", "noun, feminine"),
    ("the stomach", "el estómago", "noun, masculine"),
    # Colours and adjectives
    ("red", "rojo", "adjective — agrees: roja, rojos, rojas"),
    ("blue", "azul", "adjective — azules in the plural"),
    ("green", "verde", "adjective"),
    ("yellow", "amarillo", "adjective"),
    ("black", "negro", "adjective"),
    ("white", "blanco", "adjective"),
    ("grey", "gris", "adjective"),
    ("brown", "marrón", "adjective — café in much of Latin America"),
    ("orange (colour)", "naranja", "adjective, invariable"),
    ("pink", "rosa", "adjective, invariable"),
    ("purple", "morado", "adjective"),
    ("good", "bueno", "adjective — buen before a masculine noun"),
    ("bad", "malo", "adjective — mal before a masculine noun"),
    ("big", "grande", "adjective — gran before any singular noun"),
    ("small", "pequeño", "adjective"),
    ("new", "nuevo", "adjective"),
    ("old (thing)", "viejo", "adjective — antiguo for ancient"),
    ("young", "joven", "adjective — jóvenes in the plural"),
    ("hot (thing)", "caliente", "adjective — for weather use hace calor"),
    ("cold (thing)", "frío", "adjective — for weather use hace frío"),
    ("easy", "fácil", "adjective"),
    ("difficult", "difícil", "adjective"),
    ("happy", "feliz", "adjective — contento for a passing mood"),
    ("sad", "triste", "adjective"),
    ("tired", "cansado", "adjective — with estar"),
    ("beautiful", "bonito", "adjective — also hermoso, guapo for people"),
    ("ugly", "feo", "adjective"),
    ("long", "largo", "adjective — not 'large'"),
    ("short", "corto", "adjective — bajo for height"),
    ("fast", "rápido", "adjective and adverb"),
    ("slow", "lento", "adjective"),
    ("expensive", "caro", "adjective"),
    ("cheap", "barato", "adjective"),
    ("strong", "fuerte", "adjective"),
    ("weak", "débil", "adjective"),
    ("clean", "limpio", "adjective"),
    ("dirty", "sucio", "adjective"),
    ("full", "lleno", "adjective"),
    ("empty", "vacío", "adjective"),
    ("open (adjective)", "abierto", "adjective — also the participle of abrir"),
    ("closed", "cerrado", "adjective — also the participle of cerrar"),
    ("ready", "listo", "adjective — with estar; with ser it means clever"),
    ("right (correct)", "correcto", "adjective"),
    ("wrong", "equivocado", "adjective — estar equivocado = to be wrong"),
    ("sick", "enfermo", "adjective — with estar"),
    ("busy", "ocupado", "adjective — with estar"),
    ("important", "importante", "adjective"),
    ("true", "verdadero", "adjective — es verdad = it's true"),
    # Adverbs and connectors
    ("very", "muy", "before an adjective: muy grande"),
    ("a lot", "mucho", "after a verb: trabajo mucho"),
    ("a little", "un poco", ""),
    ("too much", "demasiado", ""),
    ("also", "también", ""),
    ("neither / not either", "tampoco", "the negative of también"),
    ("but", "pero", ""),
    ("if", "si", "no accent — sí with one means 'yes'"),
    ("then", "entonces", ""),
    ("well", "bien", "adverb — bueno is the adjective"),
    ("badly", "mal", "adverb — malo is the adjective"),
    ("more", "más", "accented"),
    ("less", "menos", ""),
    ("almost", "casi", ""),
    ("only", "solo", "also 'alone'; the accented sólo is no longer required"),
    ("together", "juntos", ""),
    ("here", "aquí", ""),
    ("there", "allí", "also ahí, a bit nearer"),
    ("near", "cerca", "cerca de = near to"),
    ("far", "lejos", "lejos de = far from"),
    ("up / above", "arriba", ""),
    ("down / below", "abajo", ""),
    ("inside", "dentro", ""),
    ("outside", "fuera", ""),
    ("before", "antes", "antes de = before doing something"),
    ("after", "después", "después de = after doing something"),
    ("during", "durante", ""),
    ("without", "sin", ""),
    ("with", "con", ""),
    ("between", "entre", ""),
    ("against", "contra", ""),
    ("until", "hasta", "also 'as far as'"),
    ("another", "otro", "no 'un' in front: otro café, not un otro café"),
    ("same", "mismo", ""),
    ("all / every", "todo", "todos los días = every day"),
    ("nothing", "nada", ""),
    ("something", "algo", ""),
    ("nobody", "nadie", ""),
    ("somebody", "alguien", ""),
    ("both", "ambos", "also los dos"),
    # Places and getting around
    ("the city", "la ciudad", "noun, feminine"),
    ("the town", "el pueblo", "noun, masculine — also 'the people' as a nation"),
    ("the street", "la calle", "noun, feminine"),
    ("the shop", "la tienda", "noun, feminine"),
    ("the market", "el mercado", "noun, masculine"),
    ("the restaurant", "el restaurante", "noun, masculine"),
    ("the hotel", "el hotel", "noun, masculine"),
    ("the airport", "el aeropuerto", "noun, masculine"),
    ("the station", "la estación", "noun, feminine — also 'the season'"),
    ("the beach", "la playa", "noun, feminine"),
    ("the mountain", "la montaña", "noun, feminine"),
    ("the country", "el país", "noun, masculine"),
    ("the world", "el mundo", "noun, masculine"),
    ("the car", "el coche", "noun, masculine — el carro or el auto in Latin America"),
    ("the train", "el tren", "noun, masculine"),
    ("the bus", "el autobús", "noun, masculine — el camión in Mexico, la guagua in the Caribbean"),
    ("the plane", "el avión", "noun, masculine"),
    ("the bicycle", "la bicicleta", "noun, feminine"),
    ("the road", "la carretera", "noun, feminine"),
    ("the way / path", "el camino", "noun, masculine"),
    ("the ticket", "el billete", "noun, masculine — el boleto in Latin America"),
    ("the suitcase", "la maleta", "noun, feminine"),
    # Work, school, things
    ("the work", "el trabajo", "noun, masculine — also 'the job'"),
    ("the office", "la oficina", "noun, feminine"),
    ("the school", "la escuela", "noun, feminine — el colegio for a secondary school"),
    ("the teacher", "el profesor", "noun, masculine — la profesora if feminine"),
    ("the student", "el estudiante", "noun, masculine — la estudiante if feminine"),
    ("the book", "el libro", "noun, masculine"),
    ("the pen", "el bolígrafo", "noun, masculine — often shortened to el boli"),
    ("the paper", "el papel", "noun, masculine — also 'the role'"),
    ("the money", "el dinero", "noun, masculine"),
    ("the price", "el precio", "noun, masculine"),
    ("the phone", "el teléfono", "noun, masculine — el móvil is the mobile"),
    ("the computer", "el ordenador", "noun, masculine — la computadora in Latin America"),
    ("the word", "la palabra", "noun, feminine"),
    ("the question", "la pregunta", "noun, feminine"),
    ("the answer", "la respuesta", "noun, feminine"),
    ("the problem", "el problema", "noun, masculine despite the -a"),
    ("the thing", "la cosa", "noun, feminine"),
    ("the place", "el lugar", "noun, masculine — also el sitio"),
    ("the time (occasion)", "la vez", "noun, feminine — otra vez = again"),
    ("the life", "la vida", "noun, feminine"),
    ("the love", "el amor", "noun, masculine"),
    ("the language", "el idioma", "noun, masculine despite the -a — la lengua also works"),
    # Weather and nature
    ("the weather", "el tiempo", "noun, masculine — also 'the time'"),
    ("the sun", "el sol", "noun, masculine"),
    ("the rain", "la lluvia", "noun, feminine"),
    ("the snow", "la nieve", "noun, feminine"),
    ("the wind", "el viento", "noun, masculine"),
    ("the cloud", "la nube", "noun, feminine"),
    ("the sky", "el cielo", "noun, masculine — also 'heaven'"),
    ("the sea", "el mar", "noun, masculine"),
    ("the river", "el río", "noun, masculine"),
    ("the tree", "el árbol", "noun, masculine"),
    ("the flower", "la flor", "noun, feminine"),
    ("the animal", "el animal", "noun, masculine"),
    ("the dog", "el perro", "noun, masculine — la perra if feminine"),
    ("the cat", "el gato", "noun, masculine — la gata if feminine"),
    ("the bird", "el pájaro", "noun, masculine"),
    ("the horse", "el caballo", "noun, masculine"),
]

# --- generation ------------------------------------------------------------

HEADER = """\
-- ---------------------------------------------------------------------------
-- The starter deck: {verb_cards:,} conjugation cards over {verbs} verbs, plus {words}
-- common words and phrases. {total:,} cards in total.
--
-- GENERATED FILE — do not edit by hand. Regenerate with:
--     scripts/gen-seed-cards.py
--
-- The verbs are the top 100 by corpus frequency, scored over their imperfect,
-- preterite, future and conditional forms; the Spanish is looked up in
-- `verbecc`'s conjugation tables rather than derived, and the generator asserts
-- {checks} hand-verified forms before it will write this file. See the script's
-- docstring for the curation and for why gustar and nacer are vocabulary cards
-- rather than drills.
--
-- Each verb contributes 5 tenses x 6 persons + the infinitive = 31 cards:
--
--     "I spoke (hablar, preterite)"          ->  "yo hablé"
--     "he/she would speak (hablar)"          ->  "él hablaría"
--     "to speak"                             ->  "hablar"
--
-- `created_by` is null: these belong to the deck rather than to either of us.
-- `on conflict` so a card someone has already added by hand wins over the seed
-- instead of failing the migration.
-- ---------------------------------------------------------------------------

"""


def sql_str(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def bare_form(text: str) -> str:
    """verbecc returns forms with their pronoun attached ("yo soy")."""
    return text.split()[-1]


def conjugate(cg: verbecc.CompleteConjugator, inf: str) -> dict[tuple[str, str], str]:
    """{(tense key, verbecc pronoun): form} for the five simple tenses."""
    wanted = {p[2] for p in PERSONS}
    out: dict[tuple[str, str], str] = {}
    for key, mood, tense, _, _ in TENSES:
        table = cg.conjugate_mood(inf, mood).get_data()
        rows = next((v for t, v in table.items() if t.value == tense), None)
        if rows is None:
            raise SystemExit(f"{inf}: no {mood}/{tense} in verbecc")
        for row in rows:
            pronoun = row["pr"].value
            if pronoun in wanted:
                out[(key, pronoun)] = FORM_OVERRIDES.get(
                    (inf, key, pronoun), bare_form(row["c"][0])
                )
        for pronoun in wanted:
            if (key, pronoun) not in out:
                raise SystemExit(f"{inf}: no {key} form for {pronoun}")
    return out


def cards() -> list[tuple[str, str, str]]:
    cg = verbecc.CompleteConjugator(lang="es")
    known = set(cg.get_infinitives())
    rows: list[tuple[str, str, str]] = []

    for verb in VERBS:
        inf = verb["inf"]
        # Not in the dictionary would mean verbecc guessing a template with its
        # ML fallback, which is exactly what this deck must not contain.
        if inf not in known:
            raise SystemExit(f"{inf} is not in verbecc's dictionary")
        forms = conjugate(cg, inf)

        for key, _, _, tense_es, label in TENSES:
            english = verb.get("en", {}).get(key)
            for i, (subject, pronoun_es, pronoun_vb, person_label) in enumerate(PERSONS):
                if english is not None:
                    predicate = english[i]
                elif key == "present":
                    predicate = verb["third"] if i == 2 else verb["base"]
                elif key == "preterite":
                    predicate = verb["past"]
                elif key == "imperfect":
                    predicate = f"used to {verb['base']}"
                elif key == "future":
                    predicate = f"will {verb['base']}"
                else:
                    predicate = f"would {verb['base']}"

                qualifier = f"{inf}, {label}" if label else inf
                notes = [f"{inf} · {tense_es} · {person_label}"]
                if key in SYNCRETIC and person_label in ("yo", "él/ella"):
                    notes.append("the yo and él/ella forms are identical in this tense")
                if person_label == "él/ella":
                    notes.append("same form for usted")
                if person_label == "vosotros":
                    notes.append("vosotros is Spain; Latin America uses ustedes with the ellos form")
                if person_label == "ellos/ellas":
                    notes.append("same form for ustedes")
                if verb.get("note"):
                    notes.append(verb["note"])

                rows.append((
                    f"{subject} {predicate} ({qualifier})",
                    f"{pronoun_es} {forms[(key, pronoun_vb)]}",
                    "; ".join(notes),
                ))

        rows.append((
            verb.get("inf_en", f"to {verb['base']}"),
            inf,
            "; ".join(x for x in ["infinitive", verb.get("note", "")] if x),
        ))

    rows.extend(WORDS)

    # `english` is unique deck-wide (009), and a duplicate would also mean two
    # cards asking the same question.
    seen: dict[str, str] = {}
    for english, spanish, _ in rows:
        if english in seen:
            raise SystemExit(f"duplicate prompt {english!r}: {seen[english]} vs {spanish}")
        seen[english] = spanish
    return rows


def check(cg: verbecc.CompleteConjugator) -> None:
    pronoun_of = {p[3].split("/")[0]: p[2] for p in PERSONS}
    pronoun_of["él"] = "él"
    failures = []
    for (inf, tense, person), expected in CHECKS.items():
        forms = conjugate(cg, inf)
        got = forms[(tense, pronoun_of[person])]
        if got != expected:
            failures.append(f"  {inf} {tense} {person}: expected {expected}, got {got}")
    if failures:
        raise SystemExit("hand-verified forms have changed:\n" + "\n".join(failures))


def main() -> None:
    cg = verbecc.CompleteConjugator(lang="es")
    check(cg)

    rows = cards()
    verb_cards = len(rows) - len(WORDS)

    parts = [HEADER.format(
        verb_cards=verb_cards, verbs=len(VERBS), words=len(WORDS),
        total=len(rows), checks=len(CHECKS),
    )]
    for start in range(0, len(rows), BATCH):
        values = ",".join(
            f"({sql_str(e)},{sql_str(s)},{sql_str(n) if n else 'null'})"
            for e, s, n in rows[start : start + BATCH]
        )
        parts.append(
            "insert into public.cards (english, spanish, notes) values "
            f"{values} on conflict (english) do nothing;\n"
        )

    OUT.write_text("".join(parts), encoding="utf-8")
    print(f"wrote {len(rows):,} cards ({verb_cards:,} conjugations over {len(VERBS)} verbs, "
          f"{len(WORDS)} words) to {OUT} ({OUT.stat().st_size / 1e6:.2f} MB)")


if __name__ == "__main__":
    main()
