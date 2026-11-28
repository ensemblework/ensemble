/**
 * Does a node's reply say it sent something into the chat that did not reach it? (docs/35 §6.1, the
 * delivery check.) "Here is the screenshot", "I've attached the report", "the video is below": each such
 * claim needs a picture, video or file that reaches the chat with this turn (the turn's media, a capture
 * held for its owner's preview card, or a link to a saved file in the reply). Only the node's own word is a
 * claim: said with I or we, or with no subject ("Sent you the screenshots", "Here is …"), never what someone
 * else did or said, and never words in quotes or code. English and Spanish words only, from a short list for
 * each, no model call. A claim with nothing behind it goes back to the model once; if it stays, it is taken out
 * of the reply and a plain note, in the claim's language, says what was not attached.
 */

export type ClaimKind = "screenshot" | "picture" | "video" | "file";
/** The languages whose claims the check reads. */
export type ClaimLanguage = "en" | "es";

/** One claim in a reply: what it says was sent, the sentence that says it, and where that sentence is. */
export type DeliveryClaim = {
  kind: ClaimKind;
  /** The thing named, as written ("screenshots", "report.md", "capturas de pantalla"). */
  noun: string;
  sentence: string;
  start: number;
  end: number;
  /** The sentence says nothing but the claim, so it can go without losing anything. */
  whole: boolean;
  /** The language of its words: the note that replaces it is written in it. */
  language: ClaimLanguage;
};

/** What reached the chat with this turn, by class. */
export type Delivered = { pictures: number; videos: number; files: number };

const EXTENSIONS = "md|markdown|txt|pdf|csv|tsv|json|ya?ml|html?|docx?|xlsx?|pptx?|zip|log|png|jpe?g|gif|webp|mp4|webm|mov";

const NOUNS: Record<ClaimKind, string> = {
  screenshot: String.raw`screen ?shots?|screen ?grabs?|screen ?captures?`,
  picture: String.raw`pictures?|images?|photos?|photographs?`,
  video: String.raw`screen ?recordings?|recordings?|videos?|screencasts?`,
  file: String.raw`[\w-]+\.(?:${EXTENSIONS})|files?|reports?|documents?|pdfs?|spreadsheets?|csvs?|archives?|summar(?:y|ies)`,
};
/** Text within one sentence: a dot inside a name ("report.md", "example.com") does not end it. */
const SAME = String.raw`(?:[^.!?\n]|\.(?=\S))`;
const DET = String.raw`(?:the|a|an|your|my|this|that|these|those|both|all|\d+|one|two|three|four|five|six|seven|eight|nine|ten)`;
const BETWEEN = String.raw`(?:[\w’'-]+(?:\.[\w’'-]+)*\s+){0,4}?`;
const NOT_YOURS = String.raw`(?<!\byou\s)(?<!\byou['’]ve\s)(?<!\byou have\s)`;

/** The English claims for one kind of thing: pictures and videos may be "here", a file must be attached or sent. `acts`: a verb whose subject is checked. */
function english(kind: ClaimKind): Array<{ pattern: RegExp; acts: boolean }> {
  const noun = `(?<noun>${NOUNS[kind]})`;
  const shown = kind === "file" ? "attached|included" : "attached|included|below|above";
  const list = [
    // "the screenshot of the page is attached", "the screenshots are below"
    String.raw`\b${noun}\b${SAME}{0,60}?\b(?:is|are)\s+(?:now\s+)?(?:${shown})\b`,
    // "**Screenshot:** attached below"
    String.raw`\b${noun}\b\s*[:*]+\s*(?:\*+\s*)?(?:attached|${kind === "file" ? "included" : "below|above"})\b`,
    // "attached is the report", "attached are the pictures"
    String.raw`\battached\s+(?:is|are|below|above|here)\b${SAME}{0,40}?\b${noun}\b`,
    // "see the attached file", "see the screenshot below"
    String.raw`\bsee\s+(?:the\s+)?attached\s+${BETWEEN}${noun}\b`,
    String.raw`\bsee\s+(?:the\s+)?${noun}\s+(?:below|above|attached)\b`,
  ];
  // "here is the screenshot": a picture or video cannot be written in the reply itself; a report or file can.
  if (kind !== "file") list.unshift(String.raw`\bhere(?:['’]s|\s+is|\s+are)\s+(?:${DET}\s+)?${BETWEEN}${noun}\b`);
  // "I've attached the report", "sent you the screenshots", "created and shared the summary": whoever did it is checked.
  const acts = String.raw`${NOT_YOURS}\b(?:attached|sent|shared|posted|uploaded)\s+(?:you\s+)?(?:${DET}\s+)?${BETWEEN}${noun}\b`;
  return [...list.map((source) => ({ pattern: new RegExp(source, "gi"), acts: false })), { pattern: new RegExp(acts, "gi"), acts: true }];
}

/** A word's edges in Spanish, where `\b` would split "está" or "vídeo" at its accented letter. */
const START = String.raw`(?<![\p{L}\p{N}_])`;
const END = String.raw`(?![\p{L}\p{N}_])`;
/** A file a reply cannot be written as; and a report or summary, which it can ("te dejo un resumen:" with the summary after it). */
const ES_FILES = String.raw`[\p{L}\p{N}_-]+\.(?:${EXTENSIONS})|archivos?|ficheros?|documentos?|pdfs?|hojas?\s+de\s+c[aá]lculo|csvs?`;
const ES_WRITTEN = String.raw`informes?|reportes?|res[uú]men(?:es)?`;
const ES_NOUNS: Record<ClaimKind, string> = {
  // "captura" alone is a screenshot, but not "captura de datos" (data capture).
  screenshot: String.raw`capturas?(?!\s+de\s+(?:datos|requisitos|leads|informaci[oó]n)${END})(?:\s+de\s+pantalla)?|pantallazos?|screenshots?`,
  picture: String.raw`im[aá]gen(?:es)?|fotos?|fotograf[ií]as?`,
  video: String.raw`grabaci(?:[oó]n|ones)(?:\s+de\s+(?:la\s+)?pantalla)?|v[ií]deos?|screencasts?`,
  file: `${ES_FILES}|${ES_WRITTEN}`,
};
const ES_DET = String.raw`(?:el|la|los|las|un|una|unos|unas|tu|tus|su|sus|mi|mis|nuestro|nuestra|nuestros|nuestras|este|esta|estos|estas|ese|esa|esos|esas|ambos|ambas|todos|todas|\d+|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)`;
const ES_BETWEEN = String.raw`(?:[\p{L}\p{N}’'-]+(?:\.[\p{L}\p{N}’'-]+)*\s+){0,4}?`;
const ES_ATTACHED = String.raw`adjunt[oa]s?|adjuntad[oa]s?|incluid[oa]s?`;
const ES_PLACE = String.raw`(?:m[aá]s\s+)?(?:abajo|debajo|arriba)|a\s+continuaci[oó]n`;
/** "te", "le", "os", "les": to whom it went. "Pasar" and "dejar" deliver only with one ("te paso", "te dejé"); "mando" and "paso" are nouns too. */
const TO = String.raw`(?:te|le|les|os)`;
/**
 * The node's own act in the first person, which the verb's form says. Done: "he adjuntado", "adjunté", "acabo de enviar".
 * Without its accent ("envie", "adjunte") the same word is a command or a wish ("que te envíe"), so it counts only after
 * "te" or "yo" and never after "que".
 */
const ES_DONE = [
  String.raw`(?:${TO}\s+)?(?:he|hemos)\s+(?:ya\s+)?(?:adjuntado|enviado|mandado|compartido|subido|publicado)`,
  String.raw`${TO}\s+(?:he|hemos)\s+(?:ya\s+)?(?:pasado|dejado)`,
  String.raw`(?:${TO}\s+)?(?:adjunté|envié|mandé|compart[ií]|sub[ií]|publiqué)`,
  String.raw`${TO}\s+(?:pasé|dejé)`,
  String.raw`(?<!(?:que|cuando|ojal[aá]|si|aunque|mientras)\s+)(?:yo\s+(?:${TO}\s+)?(?:adjunte|envie|mande|publique)|${TO}\s+(?:adjunte|envie|mande|publique|pase|deje))`,
  String.raw`(?:${TO}\s+)?acab(?:o|amos)\s+de\s+(?:adjuntar|enviar|mandar|compartir|subir|publicar|pasar|dejar)(?:te|le|les|os)?`,
].join("|");
/** Sending in the present ("te envío", "adjunto", "subimos"), which Spanish also says of a plan ("te envío el informe cuando termine"). */
const ES_SEND = String.raw`(?:${TO}\s+)?(?:adjunto|adjuntamos|env[ií]o|env[ií]amos|enviamos|mandamos|subo|subimos|publicamos)|${TO}\s+mando`;
/** Handing over in the present ("te dejo", "te paso", "comparto"), which also introduces text the reply gives itself, as English "here is" does. */
const ES_HAND = String.raw`(?:${TO}\s+)?(?:comparto|compartimos)|${TO}\s+(?:dejo|dejamos|paso|pasamos)`;

/** A Spanish claim's patterns, as in English. `acts`: the words before it must name no one but the node. `present`: a time still to come makes it a plan. */
function spanish(kind: ClaimKind): Array<{ pattern: RegExp; acts: boolean; present: boolean }> {
  const noun = `(?<noun>${ES_NOUNS[kind]})`;
  const shown = kind === "file" ? ES_ATTACHED : `${ES_ATTACHED}|${ES_PLACE}`;
  const said = [
    // "la captura de la página está adjunta", "las fotos están más abajo", "el informe va adjunto"
    String.raw`${START}${noun}${END}${SAME}{0,60}?${START}(?:est[aá]n?|van?|quedan?|(?:se\s+)?encuentran?|aparecen?|(?:l[oa]s?\s+)?tienes)\s+(?:ya\s+)?(?:${shown})${END}`,
    // "**Captura de pantalla:** adjunta"
    String.raw`${START}${noun}${END}\s*[:*]+\s*(?:\*+\s*)?(?:${shown})${END}`,
    // "adjunto encontrarás el informe", "adjunta va la captura", "abajo tienes las fotos"
    String.raw`${START}(?:${kind === "file" ? "adjunt[oa]s?" : `adjunt[oa]s?|${ES_PLACE}`})\s*,?\s+(?:${TO}\s+)?(?:est[aá]n?|van?|tienes?|ten[eé]is|tienen|encontrar[aá]s|encontrar[aá]n|encontrar[eé]is|ver[aá]s|ver[aá]n|ver[eé]is|env[ií]o|enviamos|mando|mandamos|paso|pasamos|dejo|dejamos|comparto|compartimos)${END}${SAME}{0,40}?${START}${noun}${END}`,
  ];
  // "aquí está la captura", "aquí tienes las fotos": as in English, a report or summary can be written in the reply itself.
  if (kind !== "file") said.unshift(String.raw`${START}(?:aqu[ií]|ac[aá]|ah[ií])\s+(?:${TO}\s+)?(?:est[aá]n?|tienes?|ten[eé]is|tienen|van?)\s+(?:${ES_DET}\s+)?${ES_BETWEEN}${noun}${END}`);
  const handed = kind === "file" ? `(?<noun>${ES_FILES})` : noun;
  const acts = [
    // "consulta el informe adjunto", "verás la captura abajo": in Spanish the second person's command is also the third person's act ("Mira revisa …").
    { source: String.raw`${START}(?:ver|v[eé]ase|consulta|consulte|revisa|revise|mira|puedes\s+ver|puede\s+ver|ver[aá]s|ver[aá]n)\s+(?:${ES_DET}\s+)?${noun}${END}(?:\s+\p{L}+){0,2}?\s+(?:${kind === "file" ? ES_ATTACHED : `${ES_ATTACHED}|(?:de\s+)?(?:m[aá]s\s+)?(?:abajo|debajo|arriba)`})${END}` },
    // "he adjuntado el informe", "te envié las capturas"
    { source: String.raw`${START}(?:${ES_DONE})\s+(?:${ES_DET}\s+)?${ES_BETWEEN}${noun}${END}` },
    // "adjunto el archivo", "te envío el informe"
    { source: String.raw`${START}(?:${ES_SEND})\s+(?:${ES_DET}\s+)?${ES_BETWEEN}${noun}${END}`, present: true },
    // "te paso el vídeo", "te dejo el PDF"; not "te dejo un resumen:"
    { source: String.raw`${START}(?:${ES_HAND})\s+(?:${ES_DET}\s+)?${ES_BETWEEN}${handed}${END}`, present: true },
  ];
  return [
    ...said.map((source) => ({ pattern: new RegExp(source, "giu"), acts: false, present: false })),
    ...acts.map(({ source, present }) => ({ pattern: new RegExp(source, "giu"), acts: true, present: Boolean(present) })),
  ];
}

const KINDS = ["screenshot", "picture", "video", "file"] as const;
/** Every English reading comes first, so a sentence English claims is read as before. */
const PATTERNS = [
  ...KINDS.flatMap((kind) => english(kind).map((row) => ({ ...row, present: false, kind, language: "en" as const }))),
  ...KINDS.flatMap((kind) => spanish(kind).map((row) => ({ ...row, kind, language: "es" as const }))),
];

/** A sentence that says something was not sent, or asks, or makes it depend on something else: not a claim. */
const NEGATED = /\b(?:no|not|never|nothing|none|cannot|unable|without|failed)\b|n['’]t\b/i;
const CONDITIONAL = /^\W*(?:if|once|when|after|before|as soon as|unless)\b/i;
/** Something the owner sent: "the PDF you attached". */
const THEIRS = /\byou(?:['’]ve| have)?\s+(?:attached|sent|shared|uploaded|posted)\b/i;
/** Where a claim says it went, when that is the chat itself. */
const CHAT = /^(?:you|yourself|here|this chat|the chat|this conversation|our chat|this thread|the thread|this message|this reply|my reply)\b/i;
/** Somewhere else: "to the task", "into your Drive", "with Mira", "with the team", "in the Jira ticket". */
const TO_SOMEONE = /\b(?:to|into|onto)\s+((?:the|your|a|an|my|our|their|his|her)\b[^,.;:!?\n]{0,40}|[A-Z@#][^,.;:!?\n]{0,40})|\bwith\s+((?:the|your|our)\s+team\b|everyone\b|them\b|him\b|her\b|[A-Z@#][^,.;:!?\n]{0,40})/g;
const IN_APP =
  /\b(?:in|on)\s+(?:the\s+|your\s+|a\s+|an\s+|my\s+|our\s+)?(?:task|ticket|issue|card|page|doc|google|drive|dropbox|onedrive|sharepoint|notion|slack|teams|jira|linear|github|gitlab|confluence|email|inbox|calendar|event|meeting|project|board|folder|repo|repository|channel|ensemble files|files)\b|\b(?:in|on)\s+[#@][\w-]+|\b(?:by|via|over|through)\s+(?:e-?mail|mail|slack|teams|text|sms|whatsapp|telegram|discord)\b/i;

function elsewhere(rest: string): boolean {
  for (const match of rest.matchAll(TO_SOMEONE)) if (!CHAT.test((match[1] ?? match[2] ?? "").trim())) return true;
  return IN_APP.test(rest);
}

/** The same in Spanish: "no he adjuntado", "¿te lo envío?", "si termina, te envío", "el PDF que adjuntaste", "te lo envío más tarde". */
const ES_NEGATED = /(?<![\p{L}])(?:no|ni|nunca|jam[aá]s|nada|ningún|ningun[oa]?|tampoco|sin|imposible)(?![\p{L}])/iu;
const ES_CONDITIONAL = /^[^\p{L}\p{N}]*(?:si|cuando|en\s+cuanto|una\s+vez\s+que|tan\s+pronto\s+como|apenas|a\s+menos\s+que|salvo\s+que|hasta\s+que|antes\s+de\s+que)(?![\p{L}])/iu;
const ES_THEIRS = /(?<![\p{L}])(?:adjuntaste|enviaste|mandaste|compartiste|subiste|pasaste|dejaste|has\s+(?:ya\s+)?(?:adjuntado|enviado|mandado|compartido|subido|pasado|dejado)|usted\s+(?:adjuntó|envió|mandó|compartió|subió))(?![\p{L}])/iu;
/**
 * Spanish says a plan in the present ("te envío el informe cuando termine", "te paso las capturas después de la reunión"): a time
 * still to come, or a condition, anywhere in the sentence makes one. Not a time something is from ("la captura de cuando falló",
 * "el informe del lunes") or "por si" (in case).
 */
const ES_LATER =
  /(?<![\p{L}])(?<!de\s+)(?:(?<!por\s+)si|cuando|en\s+cuanto|apenas|tan\s+pronto\s+como|una\s+vez\s+que|hasta\s+que|al\s+(?:terminar|acabar)|luego|despu[eé]s|m[aá]s\s+tarde|mañana|pronto|en\s+breve|en\s+un\s+(?:rato|momento|minuto)|en\s+unos\s+minutos|lo\s+antes\s+posible|esta\s+(?:tarde|noche)|este\s+fin\s+de\s+semana|(?:el|este|el\s+pr[oó]ximo)\s+(?:lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)|(?:la\s+)?pr[oó]xima\s+semana|la\s+semana\s+que\s+viene)(?![\p{L}])/iu;
/** Words someone else said: "Mira dice que …", "según el cliente". Accents kept where the word without one is the first person ("comento"). */
const ES_REPORTED = /(?<![\p{L}])(?:dice|dicen|dijo|dijeron|dec[ií]a|comenta|comentó|escribe|escribió|escribieron|afirma|afirmó|confirma|confirmó|menciona|mencionó|contó|asegura|aseguró|responde|respondió|contesta|contestó|preguntó|cree|creen|cre[ií]a|piensa|pensaba|seg[uú]n)(?![\p{L}])/iu;
const ES_CHAT = /^(?:este chat|esta conversaci[oó]n|este hilo|este mensaje|esta respuesta|mi respuesta|el chat|la conversaci[oó]n|el hilo|nuestro chat|chat|hilo|aqu[ií])(?![\p{L}])/iu;
/** "a Mira", "a la tarea", "al repositorio", "con Mira", "con el equipo". */
const ES_TO_SOMEONE =
  /(?<![\p{L}])(?:a|hacia)\s+((?:la|el|los|las|tu|tus|su|sus|mi|mis|nuestro|nuestra|nuestros|nuestras|un|una|este|esta|ese|esa)(?![\p{L}])[^,.;:!?\n]{0,40}|[\p{Lu}@#][^,.;:!?\n]{0,40})|(?<![\p{L}])al\s+([^,.;:!?\n]{1,40})|(?<![\p{L}])con\s+((?:el|tu|su|nuestro)\s+equipo(?![\p{L}])|todos(?![\p{L}])|todas(?![\p{L}])|ellos(?![\p{L}])|ellas(?![\p{L}])|él(?![\p{L}])|ella(?![\p{L}])|[\p{Lu}@#][^,.;:!?\n]{0,40})/gu;
const ES_IN_APP =
  /(?<![\p{L}])(?:en|a|al)\s+(?:(?:la|el|tu|su|mi|nuestro|nuestra|un|una)\s+)?(?:tarea|ticket|incidencia|issue|tarjeta|p[aá]gina|documento|doc|google|drive|dropbox|onedrive|sharepoint|notion|slack|teams|jira|linear|github|gitlab|confluence|correo|e-?mail|bandeja|calendario|evento|reuni[oó]n|proyecto|tablero|carpeta|repo|repositorio|canal|archivos)(?![\p{L}])|(?<![\p{L}])(?:en|a)\s+[#@][\w-]+|(?<![\p{L}])(?:por|v[ií]a|mediante)\s+(?:e-?mail|correo|mail|slack|teams|sms|whatsapp|telegram|discord|mensaje\s+de\s+texto)(?![\p{L}])/iu;

function elsewhereEs(rest: string): boolean {
  for (const match of rest.matchAll(ES_TO_SOMEONE)) if (!ES_CHAT.test((match[1] ?? match[2] ?? match[3] ?? "").trim())) return true;
  return ES_IN_APP.test(rest);
}

/** What stands in, at the same length, for text the reply quotes or shows as code: no letter, space or sentence end. */
const BLANK = "\u2063";
const FENCED = /```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g;
const QUOTED = /``[^\n]*?``|`[^`\n]*`|"[^"\n]*"|“[^”\n]*”|«[^»\n]*»|^[ \t]*>[^\n]*/gm;
const blanked = (found: string) => found.replace(/[^\n]/g, BLANK);

/**
 * The reply with what it quotes, its code and its block quotes blanked, at the same length: words there are not the
 * node's claims. A quoted sentence keeps its own end ("Thanks.") so the sentence after the quote is one of its own.
 */
function unquoted(text: string): string {
  return text.replace(FENCED, blanked).replace(QUOTED, (found) => {
    const end = /[.!?]+(?=["”»]$)/.exec(found);
    const blank = blanked(found);
    return end ? `${blank.slice(0, end.index)}${end[0]}${blank.slice(end.index + end[0].length)}` : blank;
  });
}

/** Abbreviations whose dot ends no sentence ("U.S.", "e.g.", "i.e.", "etc.", "vs.", "Dr. Rao", "Dra. Ruiz", "9 a.m."): a line break after one still does. */
const ABBREVIATION = /(?:^|[^\p{L}\p{N}])(?:\p{L}(?:\.\p{L})+|etc|vs|mr|mrs|ms|dr|prof|sr|jr|st|approx|inc|ltd|co|corp|fig|cf|al|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec|sra|srta|dra|ud|uds|p[aá]g|n[uú]m)$/iu;
/** Spanish abbreviations in two parts ("p. ej.", "EE. UU.", "9 a. m."), up to the second dot: neither dot ends a sentence. */
const PAIRED = /(?:^|[^\p{L}\p{N}])(?:p\.\s?ej|ee\.\s?uu|[ap]\.\s?m)$/iu;

/**
 * Whether a sentence ends at `index`: a line break, "!" or "?", or a dot followed by a space, a closing mark or the end,
 * but not the dot in "report.md" or "4.99", after an abbreviation, or after a list item's number ("1. Here is …").
 */
const stops = (text: string, index: number): boolean => {
  const char = text[index]!;
  if (char === "\n" || char === "!" || char === "?") return true;
  if (char !== ".") return false;
  if (index + 1 >= text.length || text[index + 1] === "\n") return true;
  if (!/[\s)"'’\]*_\u2063]/.test(text[index + 1]!)) return false;
  const before = text.slice(Math.max(0, index - 12), index);
  const next = /^\s?\p{L}+(?=\.)/u.exec(text.slice(index + 1, index + 6))?.[0];
  if (PAIRED.test(before) || (next && PAIRED.test(`${before}.${next}`))) return false;
  return !ABBREVIATION.test(before) && !/^[ \t]*\d{1,3}$/.test(text.slice(text.lastIndexOf("\n", index - 1) + 1, index));
};

/** The sentence around `index`: from the last stop before it to the next one after it. */
function sentenceAt(text: string, index: number): { start: number; end: number } {
  let start = index;
  while (start > 0 && !stops(text, start - 1)) start -= 1;
  let end = index;
  while (end < text.length && !stops(text, end)) end += 1;
  while (end < text.length && /[.!?]/.test(text[end]!)) end += 1;
  return { start, end };
}

const words = (text: string) => text.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
/** A clause's words, without list bullets, emphasis or quote marks. */
const tokens = (text: string) => text.match(/[\p{L}\p{N}][\p{L}\p{N}’'@#-]*/gu) ?? [];

/** The node itself: "I", "I've", "we". */
const SELF = /^(?:i|we)(?:['’](?:ve|d))?$/i;
/** Between a subject and its verb ("have just"), or opening a clause without naming anyone ("also", "done"). */
const FILLER = /^(?:have|has|had|just|also|now|already|then|finally|successfully|again|both|all|and|so|ok|okay|sure|done|great|yes|plus|next)$/i;
/** A word a clause that names no subject opens with: a verb in the past ("fixed it and sent…", "made it and shared…"). */
const VERB = /^(?:\p{L}+ed|made|took|ran|wrote|found|built|got|did|put|set|read|saw|sent|drew|began|brought|kept|left|gave|chose|caught|held|led|paid|went)$/iu;
/** Where one clause ends and the next begins; `and`, `then` and the like join a verb to the clause before. */
const CLAUSE = /([,;:()\n]|\s[-–]\s)|\b(and|but|so|then|because|while|since|although|though)\b/gi;
/** Someone said it: "Mira said here is …", "the client says the report is attached". */
const REPORTED = /\b(?:says|said|wrote|writes|mentions|mentioned|told|tells|thinks|thought|confirms|confirmed|claims|claimed|noted|according to|replies|replied|asks|asked)\b/i;

/** The last clause of `text`, what comes before it, and whether a conjunction joined it to that ("fixed it and sent"). */
function lastClause(text: string, clauses = CLAUSE): { clause: string; before: string; conjunction: boolean } {
  let last: RegExpExecArray | null = null;
  for (const match of text.matchAll(clauses)) last = match;
  if (!last) return { clause: text, before: "", conjunction: false };
  return { clause: text.slice(last.index + last[0].length), before: text.slice(0, last.index), conjunction: Boolean(last[2]) };
}

/** A clause's words without the fillers it opens with ("also", "done") or that stand before its verb ("have just"). */
function cleaned(clause: string): string[] {
  const words = tokens(clause);
  while (words.length && FILLER.test(words[0]!)) words.shift();
  while (words.length && FILLER.test(words.at(-1)!)) words.pop();
  return words;
}

/**
 * Whether the node itself did what an active claim says, from the words before its verb: "I've sent", "sent you",
 * "As requested, sent", "fixed it and attached", "I checked it and attached"; not "Mira sent", "the client has shared"
 * or "your manager checked it and attached". A verb joined by a conjunction has the subject of the clause before it.
 */
function nodeDid(lead: string): boolean {
  const { clause, before, conjunction } = lastClause(lead);
  const words = cleaned(clause);
  if (words.length) return words.length === 1 && SELF.test(words[0]!);
  if (!conjunction) return true;
  const earlier = cleaned(lastClause(before).clause);
  return !earlier.length || SELF.test(earlier[0]!) || VERB.test(earlier[0]!);
}

/** Words the claim's sentence has besides the claim, not counting who made it ("I've") or the marks it opens with. */
function besides(lead: string, tail: string): number {
  return tokens(lead).filter((word) => !SELF.test(word) && !FILLER.test(word)).length + words(tail);
}

const ES_SELF = /^(?:yo|nosotros|nosotras)$/i;
/** Words that name no one: "ya", "también", "listo", "hola", and the "te" or "lo" before a verb. */
const ES_FILLER = /^(?:ya|también|tambien|además|ademas|ahora|hoy|ayer|antes|recién|recien|finalmente|y|e|pues|bueno|bien|vale|listo|lista|hecho|hecha|perfecto|ok|okay|sí|claro|entonces|así|aquí|aqui|acá|aca|hola|te|le|les|os|lo|la|los|las)$/iu;
/** Where a Spanish clause begins: "corregí el error y te envié …", "te confirmo que he adjuntado …". */
const ES_CLAUSE = /([,;:()\n]|\s[-–]\s)|(?<![\p{L}])(y|e|pero|que|porque|pues|aunque|mientras|luego|entonces)(?![\p{L}])/giu;
/** What follows a colon is said besides the claim ("te envío la captura: el login falla en Safari"). */
const ES_AFTER_COLON = /[:;]\s*[\p{L}\p{N}]/u;

/** Whether the node itself did it: its verb says the first person, so its clause names no one else ("Mira y yo", "yo" or nothing). */
function nodeDidEs(lead: string): boolean {
  const words = tokens(lastClause(lead, ES_CLAUSE).clause).filter((word) => !ES_FILLER.test(word));
  return !words.length || (words.length === 1 && ES_SELF.test(words[0]!));
}

/** How each language reads a sentence a pattern found a claim in. */
const LANGUAGES: Record<
  ClaimLanguage,
  { excluded: (sentence: string, present: boolean) => boolean; here: RegExp; elsewhere: (rest: string) => boolean; own: (lead: string, acts: boolean) => boolean; besides: (lead: string, tail: string) => number }
> = {
  en: {
    excluded: (sentence) => sentence.endsWith("?") || NEGATED.test(sentence) || CONDITIONAL.test(sentence) || THEIRS.test(sentence),
    here: /^here/i,
    elsewhere,
    own: (lead, acts) => (acts ? nodeDid(lead) : !REPORTED.test(lastClause(lead).clause)),
    besides,
  },
  es: {
    excluded: (sentence, present) =>
      sentence.endsWith("?") || sentence.includes("¿") || ES_NEGATED.test(sentence) || ES_CONDITIONAL.test(sentence) || ES_THEIRS.test(sentence) || (present && ES_LATER.test(sentence)),
    here: /^(?:aqu[ií]|ac[aá]|ah[ií])/iu,
    elsewhere: elsewhereEs,
    own: (lead, acts) => !ES_REPORTED.test(lead) && (!acts || nodeDidEs(lead)),
    besides: (lead, tail) => (ES_AFTER_COLON.test(tail) ? Infinity : tokens(lead).filter((word) => !ES_SELF.test(word) && !ES_FILLER.test(word)).length + words(tail)),
  },
};

/**
 * The reply with each letter and its accent marks as one character where Unicode has one ("e" and "◌́" typed apart become
 * "é"), and where in the reply each of its characters starts, so a claim's span is in the reply's own characters.
 */
function composed(text: string): { flat: string; at: (index: number) => number } {
  if (text.normalize("NFC") === text) return { flat: text, at: (index) => index };
  let flat = "";
  const starts: number[] = [];
  for (const part of text.matchAll(/\P{M}\p{M}*|\p{M}+/gu)) {
    const one = part[0].normalize("NFC");
    for (let i = 0; i < one.length; i += 1) starts.push(part.index);
    flat += one;
  }
  starts.push(text.length);
  return { flat, at: (index) => starts[index]! };
}

/** The delivery claims a reply makes, one per sentence, in the order written. */
export function deliveryClaims(text: string): DeliveryClaim[] {
  const { flat, at } = composed(text);
  const plain = unquoted(flat);
  const found = new Map<number, DeliveryClaim>();
  for (const { kind, language, pattern, acts, present } of PATTERNS) {
    const reads = LANGUAGES[language];
    for (const match of plain.matchAll(pattern)) {
      const { start, end } = sentenceAt(plain, match.index);
      if (found.has(start) || match.index + match[0].length > end) continue;
      const sentence = plain.slice(start, end).trim();
      if (!sentence || reads.excluded(sentence, present)) continue;
      // "here is the screenshot" names its own place; anything else may name another one ("attached it to the task").
      if (!reads.here.test(match[0]) && reads.elsewhere(plain.slice(match.index, end))) continue;
      // Only the node's own word counts: never what someone else did or said.
      if (!reads.own(plain.slice(start, match.index), acts)) continue;
      const whole = reads.besides(flat.slice(start, match.index), flat.slice(match.index + match[0].length, end)) <= 4;
      found.set(start, { kind, noun: match.groups!.noun!, sentence: text.slice(at(start), at(end)).trim(), start: at(start), end: at(end), whole, language });
    }
  }
  return [...found.values()].sort((a, b) => a.start - b.start);
}

/** Captures a turn's tools kept but held for the owner's preview card: they reach the owner there (a tool result's `data.evidence`). */
export function heldCaptures(results: readonly unknown[]): Array<{ kind: string }> {
  const held: Array<{ kind: string }> = [];
  for (const result of results) {
    const list = (result as { data?: { evidence?: unknown } } | null)?.data?.evidence;
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const row = (item ?? {}) as { held?: unknown; kind?: unknown };
      if (row.held === true && typeof row.kind === "string") held.push({ kind: row.kind });
    }
  }
  return held;
}

/** What reached the chat: media and held captures by kind; a link to a file in the reply counts as a file. */
export function deliveredWith(media: ReadonlyArray<{ kind: string }>, text: string): Delivered {
  const pictures = media.filter((item) => item.kind === "screenshot" || item.kind === "image").length;
  const videos = media.filter((item) => item.kind === "video").length;
  const links = /ensemble:\/\/file\/[0-9a-f-]{36}|\]\(\s*(?:https?:\/\/|ensemble:\/\/|\/)[^)\s]+\)/i.test(text) ? 1 : 0;
  return { pictures, videos, files: media.length + links };
}

function backed(kind: ClaimKind, delivered: Delivered): boolean {
  if (kind === "video") return delivered.videos > 0;
  if (kind === "file") return delivered.files > 0;
  return delivered.pictures > 0;
}

const NOTES: Record<ClaimLanguage, Record<ClaimKind, string>> = {
  en: {
    screenshot: "No screenshot was attached.",
    picture: "No picture was attached.",
    video: "No video was attached.",
    file: "No file was attached.",
  },
  es: {
    screenshot: "No se adjuntó ninguna captura de pantalla.",
    picture: "No se adjuntó ninguna imagen.",
    video: "No se adjuntó ningún video.",
    file: "No se adjuntó ningún archivo.",
  },
};

const fileName = (noun: string) => /\.\w+$/.test(noun);
/** "screenshots", "capturas de pantalla", "informes": more than one. */
const plural = (claim: DeliveryClaim) => !fileName(claim.noun) && (claim.language === "en" ? /s$/i : /^\S+s(?=\s|$)/i).test(claim.noun);
/** What the feedback, which is in English, calls the thing: a file's name, the English noun as written, or for Spanish its kind ("the screenshot"). */
const named = (claim: DeliveryClaim) =>
  fileName(claim.noun) ? claim.noun : claim.language === "en" ? `the ${claim.noun.toLowerCase()}` : `the ${claim.kind}${plural(claim) ? "s" : ""}`;

/** The feedback for the one round that may fix it: what the reply said, and what to do. */
export function claimFeedback(claims: readonly DeliveryClaim[]): string {
  const nouns = [...new Set(claims.map(named))];
  const many = nouns.length > 1 || plural(claims[0]!);
  const what = nouns.length > 1 ? `${nouns.slice(0, -1).join(", ")} and ${nouns.at(-1)}` : nouns[0]!;
  return `You said ${what} ${many ? "are" : "is"} attached, but nothing reached the chat. Attach ${many ? "them" : "it"} with the right tool, or correct your reply.`;
}

/**
 * The reply without its false claims: a sentence that only made the claim goes, with its emphasis and, alone on its
 * line, with its line and bullet; any other stays. A plain note, in each claim's language, says what was not attached.
 */
export function withoutClaims(text: string, claims: readonly DeliveryClaim[]): string {
  let kept = text;
  for (const claim of claims.filter((row) => row.whole).sort((a, b) => b.start - a.start)) {
    let before = kept.slice(0, claim.start);
    let after = kept.slice(claim.end);
    // The emphasis the sentence opens with ("**Here is the screenshot.**") goes with it; when it holds more than the
    // sentence ("**Here is the screenshot. Prices are in.**"), what is left keeps it.
    const opened = /^\s*(?:[-*+]\s+|\d{1,3}[.)]\s+)?([*_~]+)(?=\S)/.exec(kept.slice(claim.start, claim.end))?.[1];
    if (opened) {
      const closing = [...opened].reverse().join("");
      after = after.startsWith(closing) ? after.slice(closing.length) : `${opened}${after.replace(/^[ \t]+/, "")}`;
    }
    const lineStart = before.lastIndexOf("\n") + 1;
    const lineBreak = after.indexOf("\n");
    const line = `${before.slice(lineStart)}${lineBreak < 0 ? after : after.slice(0, lineBreak)}`;
    if (/^[ \t]*(?:[-*+]|\d{1,3}[.)])?[ \t]*$/.test(line)) {
      // Nothing else on its line but a list bullet: the line goes.
      before = before.slice(0, lineStart);
      after = lineBreak < 0 ? "" : after.slice(lineBreak + 1);
      if (before.endsWith("\n\n") && after.startsWith("\n")) after = after.replace(/^\n+/, "");
    } else if (/^[ \t]*(?:[-*+]\s+|\d{1,3}[.)]\s+)?$/.test(before.slice(lineStart))) {
      // The claim began its line (after any bullet): the rest of the line moves up.
      after = after.replace(/^[ \t]+/, "");
    } else {
      // Within a line: what stays on either side, one space apart (a closing mark or stop needs none).
      before = before.replace(/[ \t]+$/, "");
      after = after.replace(/^[ \t]+/, "");
      if (after && !/^[\n.,;:!?)*_~]/.test(after)) after = ` ${after}`;
    }
    kept = `${before}${after}`;
  }
  kept = kept.trim();
  const notes = [...new Set(claims.map((claim) => NOTES[claim.language][claim.kind]))].join(" ");
  return kept ? `${kept}\n\n${notes}` : notes;
}

export type DeliveryCheck = { count: number; feedback: string; corrected: string };

/** The reply's delivery claims that nothing backs: null when every one holds. */
export function checkDelivery(text: string, delivered: Delivered): DeliveryCheck | null {
  const wrong = deliveryClaims(text).filter((claim) => !backed(claim.kind, delivered));
  if (!wrong.length) return null;
  return { count: wrong.length, feedback: claimFeedback(wrong), corrected: withoutClaims(text, wrong) };
}
