/**
 * Ensemble's extracted text of a file is not put into a model's prompt: it is off.
 *
 * Models and agents get the files themselves, in the form each takes (docs/38). Where a model or
 * agent cannot take a format, it is told the file's name and that it could not be given; it is not
 * given Ensemble's reading of the file instead. Tried, and kept behind this switch for a later
 * decision:
 *  - the start of each attached file's text in chat, Ensemble Node and the task brief, for formats a
 *    model does not take whole (`filesSection` excerpts, files/attached.ts; files/model-input.ts);
 *  - Ensemble's text sent with a file to the person's own agent when its CLI cannot take that format
 *    (`TurnFile.text`, assistant/attachments.ts `turnFilesFor` → subscriptions/turn-files.ts), and to
 *    a paired computer whose Ensemble is too old to receive files (runSubscriptionTurn `fallback`);
 *  - excerpts of a page's files in the assistant's open-page context (assistant/state.ts) and in a
 *    paired computer's task brief (devices/routes.ts), both through `filesSection`.
 * A text file (.txt, .md, .csv, .json, code) is not extracted: its own contents are the file, and
 * they are sent as they are. Files' extraction stays on for search, previews and page conversion,
 * and for the read tools a model calls itself (hub_read_file, read_attachment, ensemble_read).
 */
export const EXTRACTED_TEXT_TO_MODELS = false;
