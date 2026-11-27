/**
 * The delivery check's English and Spanish phrase lists (node/delivery-claims.ts): which replies say that something
 * reached the chat, what backs each claim, and how a claim nothing backs is taken out of the reply.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { checkDelivery, claimFeedback, deliveredWith, deliveryClaims, heldCaptures } from "./delivery-claims.js";

const kinds = (text: string) => deliveryClaims(text).map((claim) => claim.kind);
const none = { pictures: 0, videos: 0, files: 0 };

test("a reply that says a picture, video or file is here, attached, sent or shared makes a claim", () => {
  assert.deepEqual(kinds("Here’s the screenshot of the status page."), ["screenshot"]);
  assert.deepEqual(kinds("The screenshot of example.com is attached."), ["screenshot"]);
  assert.deepEqual(kinds("**Screenshot:** attached below"), ["screenshot"]);
  assert.deepEqual(kinds("See the screenshot below."), ["screenshot"]);
  assert.deepEqual(kinds("I've sent you the screenshots."), ["screenshot"]);
  assert.deepEqual(kinds("Done. I added the task and here is a picture of the board."), ["picture"]);
  assert.deepEqual(kinds("Here's the recording of the calculator."), ["video"]);
  assert.deepEqual(kinds("The summary is attached."), ["file"]);
  assert.deepEqual(kinds("I've attached the report."), ["file"]);
  assert.deepEqual(kinds("I've shared the report with you."), ["file"]);
  assert.deepEqual(kinds("Created and shared the one-page Markdown summary of the field trial report."), ["file"]);
  assert.deepEqual(deliveryClaims("Attached is report.md with the numbers.").map((claim) => claim.noun), ["report.md"], "a file's name, dots and all");
  assert.deepEqual(kinds("7 × 6 = 42. I've attached the screenshot. The page shows 3 services."), ["screenshot"], "one claim, in its own sentence");
});

test("what is not a claim: a denial, a question, a plan, the owner's own file, another place, and text written in the reply", () => {
  for (const text of [
    "No screenshot is attached: the browser did not start.",
    "I couldn't attach the recording.",
    "Should I send you the file?",
    "If the build passes, I'll send the report.",
    "The PDF you attached says 42.",
    "I've attached the screenshot to the task.",
    "I've shared the doc with Mira.",
    "I've sent the report to Ben by email.",
    "I've uploaded the file to your Drive.",
    "I've posted the report in #general.",
    "Here is the report on Q3: revenue grew.",
    "Here's a summary of the meeting:",
    "Here are both.",
  ]) {
    assert.deepEqual(deliveryClaims(text), [], text);
  }
});

test("a claim holds when what it names reached the chat: a picture, a video, any file or a link to one; a capture held for the owner's card counts", () => {
  assert.equal(checkDelivery("Here is the screenshot.", deliveredWith([{ kind: "screenshot" }], "")), null);
  assert.equal(checkDelivery("Here is the screenshot.", deliveredWith(heldCaptures([{ data: { evidence: [{ id: "e1", kind: "screenshot", held: true }] } }]), "")), null, "held for the owner's preview card");
  assert.ok(checkDelivery("Here is the screenshot.", deliveredWith([{ kind: "report" }], "")), "a file is not a picture");
  assert.ok(checkDelivery("Here's the video.", deliveredWith([{ kind: "screenshot" }], "")), "a picture is not a video");
  assert.equal(checkDelivery("I've attached report.md.", deliveredWith([{ kind: "report" }], "")), null);
  const linked = "I've attached the report: [report.md](ensemble://file/0d7f6c2e-4a5b-4c3d-8e9f-0a1b2c3d4e5f).";
  assert.equal(checkDelivery(linked, deliveredWith([], linked)), null, "a link to the saved file");
  assert.equal(checkDelivery("I couldn't take the screenshot: the page did not load.", deliveredWith([], "")), null);
});

test("a claim nothing backs: one round of feedback, then the claim goes from the reply and a plain note says what was not attached", () => {
  const only = checkDelivery("Here are the screenshots.", none)!;
  assert.equal(only.count, 1);
  assert.equal(only.feedback, "You said the screenshots are attached, but nothing reached the chat. Attach them with the right tool, or correct your reply.");
  assert.equal(only.corrected, "No screenshot was attached.", "a sentence that only made the claim goes");

  const mixed = checkDelivery("7 × 6 = 42.\nHere is the screenshot.\nThe display shows 42.", none)!;
  assert.equal(mixed.corrected, "7 × 6 = 42.\nThe display shows 42.\n\nNo screenshot was attached.");

  const kept = checkDelivery("Here’s the screenshot of the status page: it shows 3 services up and 1 down.", none)!;
  assert.equal(kept.corrected, "Here’s the screenshot of the status page: it shows 3 services up and 1 down.\n\nNo screenshot was attached.", "a sentence that says more stays");

  const two = checkDelivery("I've attached report.md. Here's the recording.", none)!;
  assert.equal(two.count, 2);
  assert.equal(two.corrected, "No file was attached. No video was attached.");
  assert.equal(claimFeedback(deliveryClaims("I've attached report.md.")), "You said report.md is attached, but nothing reached the chat. Attach it with the right tool, or correct your reply.");
  for (const text of [only.feedback, only.corrected, mixed.corrected, two.corrected]) assert.doesNotMatch(text, /\u2014|--/, "no long dashes");
});

test("five replies: someone else's act and quoted or code text are no claims; a sentence ends after its abbreviations, and goes with its Markdown", () => {
  const corrected = (text: string) => checkDelivery(text, none)?.corrected ?? text;
  // Someone else did it: no claim of the node's own.
  const theirs = "Your manager sent the report on Friday, and the client shared the screenshots in their reply.";
  assert.equal(corrected(theirs), theirs);
  // Words in quotes or code are not the node's.
  const quoted = 'Your welcome email starts with "Here is the screenshot you asked for." and the CI bot posts `I\'ve attached the report.` after each run.';
  assert.equal(corrected(quoted), quoted);
  // "Dr." does not end the claim's sentence: all of it goes, and nothing of it is left behind.
  assert.equal(corrected("I've attached the report for Dr. Rao. It covers the U.S. and U.K. offices, e.g. Austin and Leeds."), "It covers the U.S. and U.K. offices, e.g. Austin and Leeds.\n\nNo file was attached.");
  // Neither does "e.g.": the whole sentence says more than the claim, so it stays, whole, with the note.
  assert.equal(corrected("Attached is the screenshot, e.g. the checkout page with 3 items at $4.99 each."), "Attached is the screenshot, e.g. the checkout page with 3 items at $4.99 each.\n\nNo screenshot was attached.");
  // A sentence goes with its emphasis and, alone on its line, with its bullet.
  assert.equal(
    corrected("Prices are in. **I've attached the screenshot.** Walmart is cheapest:\n\n- **Here is the screenshot.**\n- Walmart: $4.99\n- Target: $5.49"),
    "Prices are in. Walmart is cheapest:\n\n- Walmart: $4.99\n- Target: $5.49\n\nNo screenshot was attached.",
  );
});

test("whose act a claim is: the node's own, said with I or we or with no subject; never one someone else did or said", () => {
  for (const text of ["I've sent you the screenshots.", "Sent you the screenshots.", "Fixed the bug and sent you the screenshots.", "I checked the page, fixed the bug and attached the screenshot.", "Hi Mira, I've attached the report.", "As requested, sent you the report.", "Done: attached the report."]) {
    assert.equal(deliveryClaims(text).length, 1, text);
  }
  for (const text of ["Mira sent the screenshot yesterday.", "The client has already shared the report.", "Your manager checked the page and attached the screenshot.", "The client says the report is attached.", "Mira said here is the screenshot.", "> Here is the screenshot.", "```\nI've attached the report.\n```"]) {
    assert.deepEqual(deliveryClaims(text), [], text);
  }
  // A quoted sentence ends where its quote does: the claim after it is the node's.
  assert.deepEqual(kinds('Mira said "Thanks." Here is the screenshot.'), ["screenshot"]);
  // A list item's number is no sentence of its own.
  assert.equal(checkDelivery("Results:\n1. Here is the screenshot.\n2. Walmart has it for $4.99.", none)!.corrected, "Results:\n2. Walmart has it for $4.99.\n\nNo screenshot was attached.");
  // Emphasis that holds more than the claim keeps its marks.
  assert.equal(checkDelivery("**Prices are in. Here is the screenshot.**", none)!.corrected, "**Prices are in.**\n\nNo screenshot was attached.");
  assert.equal(checkDelivery("**Here is the screenshot. Prices are in.**", none)!.corrected, "**Prices are in.**\n\nNo screenshot was attached.");
});

// Spanish: the second language the check reads. The same claims, exclusions and corrections as in English.

test("in Spanish, a reply that says a screenshot, picture, video or file is here, attached, sent or shared makes a claim, with or without accents and a subject", () => {
  assert.deepEqual(kinds("Aquí está la captura de pantalla."), ["screenshot"]);
  assert.deepEqual(kinds("Aquí tienes las capturas de la página de estado."), ["screenshot"]);
  assert.deepEqual(kinds("La captura de pantalla está adjunta."), ["screenshot"]);
  assert.deepEqual(kinds("**Captura de pantalla:** adjunta"), ["screenshot"]);
  assert.deepEqual(kinds("Abajo tienes el pantallazo del pago."), ["screenshot"]);
  assert.deepEqual(kinds("Te he enviado las capturas."), ["screenshot"]);
  assert.deepEqual(kinds("Yo te envié la captura de pantalla."), ["screenshot"]);
  assert.deepEqual(kinds("Listo. Añadí la tarea y aquí está una imagen del tablero."), ["picture"]);
  assert.deepEqual(kinds("Las fotos están más abajo."), ["picture"]);
  assert.deepEqual(kinds("Aqui estan las imagenes del panel."), ["picture"], "without accents");
  assert.deepEqual(kinds("Aquí está la grabación de la calculadora."), ["video"]);
  assert.deepEqual(kinds("He enviado el vídeo a este chat."), ["video"]);
  assert.deepEqual(kinds("Te paso el video de la demo."), ["video"]);
  assert.deepEqual(kinds("He adjuntado el informe."), ["file"]);
  assert.deepEqual(kinds("Hemos adjuntado el informe."), ["file"]);
  assert.deepEqual(kinds("El resumen va adjunto."), ["file"]);
  assert.deepEqual(kinds("Adjunto el archivo con las cifras."), ["file"]);
  assert.deepEqual(kinds("Te acabo de enviar el PDF."), ["file"]);
  assert.deepEqual(kinds("Consulta el informe adjunto."), ["file"]);
  assert.deepEqual(deliveryClaims("Aquí están las capturas de pantalla.").map((claim) => claim.noun), ["capturas de pantalla"]);
  assert.deepEqual(deliveryClaims("Adjunto encontrarás informe_económico.pdf con las cifras.").map((claim) => claim.noun), ["informe_económico.pdf"], "a file's name, accents and all");
  assert.deepEqual(kinds("7 × 6 = 42. He adjuntado la captura. La página muestra 3 servicios."), ["screenshot"], "one claim, in its own sentence");
});

test("what is not a claim, in English and in Spanish: a denial, a question, a plan or condition, someone else's act, the owner's own file, another person or app, and quoted, code or block-quoted text", () => {
  const english = [
    "I haven't attached the report.",
    "Did I attach the report?",
    "If the build passes, I'll send the report.",
    "I'll send you the screenshot tomorrow.",
    "Mira attached the report.",
    "The PDF you attached says 42.",
    "I've sent the report to Mira by email.",
    'The bot replies "I\'ve attached the report." after each run.',
    "`I've attached the report.`",
    "> Here is the screenshot.",
    "```\nHere is the screenshot.\n```",
  ];
  const spanish = [
    // A denial.
    "No he adjuntado el informe.",
    "Todavía no te he enviado la captura.",
    "No pude adjuntar la captura de pantalla.",
    // A question.
    "¿He adjuntado el informe?",
    "¿Te envío el informe?",
    // A plan or a condition.
    "Si termina, enviaré el informe.",
    "Si termina, te envío el informe.",
    "Cuando acabe la prueba, te mando el vídeo.",
    "Te enviaré la captura mañana.",
    "Voy a adjuntar el informe.",
    "Te envío el informe más tarde.",
    // Someone else's act, or words someone else said.
    "Mira adjuntó el informe.",
    "Mira ha enviado las capturas.",
    "Mira revisa el informe adjunto cada lunes.",
    "El envío del informe tardó dos días.",
    "El cliente dice que el informe está adjunto.",
    "Mira dijo que aquí está la captura.",
    // The owner's own file.
    "El PDF que adjuntaste dice 42.",
    "Las fotos que me enviaste están abajo.",
    // Another person or app.
    "He enviado el informe a Mira por correo.",
    "He adjuntado la captura a la tarea.",
    "He subido el archivo a tu Drive.",
    "He publicado el informe en #general.",
    "He compartido el documento con Mira.",
    "He compartido el informe con el equipo.",
    // Quoted, code or block-quoted text.
    "Tu correo de bienvenida empieza con «Aquí está la captura que pediste».",
    'El bot responde "He adjuntado el informe." tras cada ejecución.',
    "`He adjuntado el informe.`",
    "> Aquí está la captura de pantalla.",
    "```\nHe adjuntado el informe.\n```",
    // Written in the reply itself, or no screenshot at all.
    "Aquí está el informe del tercer trimestre: los ingresos crecieron.",
    "La captura de datos está abajo en la lista de prioridades.",
    "Aquí tienes un resumen de la reunión:",
  ];
  for (const text of [...english, ...spanish]) assert.deepEqual(deliveryClaims(text), [], text);
});

test("in Spanish, a claim holds when what it names reached the chat; missing or the wrong kind, it does not", () => {
  assert.equal(checkDelivery("Aquí está la captura de pantalla.", deliveredWith([{ kind: "screenshot" }], "")), null);
  assert.equal(checkDelivery("Aquí está la captura.", deliveredWith(heldCaptures([{ data: { evidence: [{ id: "e1", kind: "screenshot", held: true }] } }]), "")), null, "held for the owner's preview card");
  assert.equal(checkDelivery("Te he enviado el vídeo.", deliveredWith([{ kind: "video" }], "")), null);
  assert.equal(checkDelivery("He adjuntado informe.md.", deliveredWith([{ kind: "report" }], "")), null);
  const linked = "He adjuntado el informe: [informe.md](ensemble://file/0d7f6c2e-4a5b-4c3d-8e9f-0a1b2c3d4e5f).";
  assert.equal(checkDelivery(linked, deliveredWith([], linked)), null, "a link to the saved file");
  assert.ok(checkDelivery("He adjuntado el informe.", none), "nothing reached the chat");
  assert.ok(checkDelivery("Aquí está la captura de pantalla.", deliveredWith([{ kind: "report" }], "")), "a file is not a picture");
  assert.ok(checkDelivery("Te he enviado el vídeo.", deliveredWith([{ kind: "screenshot" }], "")), "a picture is not a video");
  assert.ok(checkDelivery("Las fotos están más abajo.", deliveredWith([{ kind: "video" }], "")), "a video is not a picture");
});

test("in Spanish, a claim nothing backs: the feedback names it, then the claim goes from the reply and a note in Spanish says what was not attached, Unicode and Markdown kept", () => {
  const only = checkDelivery("Aquí están las capturas de pantalla.", none)!;
  assert.equal(only.count, 1);
  assert.equal(only.feedback, "You said the screenshots are attached, but nothing reached the chat. Attach them with the right tool, or correct your reply.");
  assert.equal(only.corrected, "No se adjuntó ninguna captura de pantalla.", "a sentence that only made the claim goes");
  assert.equal(checkDelivery("He adjuntado el informe.", none)!.feedback, "You said the file is attached, but nothing reached the chat. Attach it with the right tool, or correct your reply.");
  assert.equal(claimFeedback(deliveryClaims("He adjuntado informe.md.")), "You said informe.md is attached, but nothing reached the chat. Attach it with the right tool, or correct your reply.");

  const mixed = checkDelivery("7 × 6 = 42.\nAquí está la captura de pantalla de la página de estado.\nLa pantalla muestra 42.", none)!;
  assert.equal(mixed.corrected, "7 × 6 = 42.\nLa pantalla muestra 42.\n\nNo se adjuntó ninguna captura de pantalla.");

  const kept = "Aquí está la captura de la página de estado: muestra 3 servicios activos y 1 caído.";
  assert.equal(checkDelivery(kept, none)!.corrected, `${kept}\n\nNo se adjuntó ninguna captura de pantalla.`, "a sentence that says more stays");

  const two = checkDelivery("He adjuntado informe.md. Aquí está la grabación.", none)!;
  assert.equal(two.count, 2);
  assert.equal(two.corrected, "No se adjuntó ningún archivo. No se adjuntó ningún video.");
  assert.equal(checkDelivery("Las fotos están más abajo.", none)!.corrected, "No se adjuntó ninguna imagen.");

  const corrected = (text: string) => checkDelivery(text, none)?.corrected ?? text;
  assert.equal(corrected("Ya está 🎉. Aquí está la captura de pantalla. Revisé la página «Precios» también."), "Ya está 🎉. Revisé la página «Precios» también.\n\nNo se adjuntó ninguna captura de pantalla.");
  // "Dra." and "EE. UU." end no sentence: all of the claim's sentence goes, and nothing of it is left behind.
  assert.equal(corrected("He adjuntado el informe para la Dra. Ruiz. Cubre las cifras de marzo."), "Cubre las cifras de marzo.\n\nNo se adjuntó ningún archivo.");
  assert.equal(corrected("He enviado el informe sobre EE. UU. y México. Las cifras son de marzo."), "Las cifras son de marzo.\n\nNo se adjuntó ningún archivo.");
  // Neither does "p. ej.": the whole sentence says more than the claim, so it stays, whole, with the note.
  const example = "Adjunta está la captura, p. ej. la página de pago con 3 artículos a 4,99 € cada uno.";
  assert.equal(corrected(example), `${example}\n\nNo se adjuntó ninguna captura de pantalla.`);
  // A sentence goes with its emphasis and, alone on its line, with its bullet.
  assert.equal(
    corrected("Los precios ya están. **Te he adjuntado la captura.** El más barato es Mercadona:\n\n- **Aquí está la captura de pantalla.**\n- Mercadona: 4,99 €\n- Día: 5,49 €"),
    "Los precios ya están. El más barato es Mercadona:\n\n- Mercadona: 4,99 €\n- Día: 5,49 €\n\nNo se adjuntó ninguna captura de pantalla.",
  );
  assert.equal(checkDelivery("Resultados:\n1. Aquí está la captura.\n2. Mercadona lo tiene a 4,99 €.", none)!.corrected, "Resultados:\n2. Mercadona lo tiene a 4,99 €.\n\nNo se adjuntó ninguna captura de pantalla.");
  assert.equal(checkDelivery("**Los precios ya están. Aquí está la captura.**", none)!.corrected, "**Los precios ya están.**\n\nNo se adjuntó ninguna captura de pantalla.");
  for (const text of [only.feedback, only.corrected, mixed.corrected, two.corrected]) assert.doesNotMatch(text, /—|--/, "no long dashes");
});

test("in Spanish, whose act a claim is: the node's own, said with yo or nosotros or with no subject; never one someone else did or said", () => {
  for (const text of [
    "Te he enviado las capturas.",
    "Yo te he enviado las capturas.",
    "Corregí el error y te envié las capturas.",
    "Revisé la página, corregí el fallo y adjunté la captura.",
    "Mira revisó la página y yo adjunté la captura.",
    "Hola Mira, te he adjuntado el informe.",
    "Como pediste, te envío el informe.",
    "Te confirmo que he adjuntado el informe.",
    "Listo: adjunté el informe.",
  ]) {
    assert.equal(deliveryClaims(text).length, 1, text);
  }
  for (const text of [
    "Mira envió la captura ayer.",
    "El cliente ya ha compartido el informe.",
    "Tu jefa revisó la página y adjuntó la captura.",
    "Según Mira, te he enviado el informe.",
    "«He adjuntado el informe», escribió Mira.",
  ]) {
    assert.deepEqual(deliveryClaims(text), [], text);
  }
  // A quoted sentence ends where its quote does: the claim after it is the node's.
  assert.deepEqual(kinds("Mira dijo «Gracias.» Aquí está la captura."), ["screenshot"]);
});
