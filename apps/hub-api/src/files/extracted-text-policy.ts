/**
 * Ensemble's extracted text of a file is not given to models or agents in its own turns: it is off.
 *
 * Models and agents get every attached file itself (docs/38); a provider that refuses one gets the
 * request again without it. Ensemble does not hand over its own reading of a file. Tried, and kept
 * behind this switch for a later decision:
 *  - the start of each attached file's text in chat, Ensemble Node and the task brief, for formats a
 *    model does not take whole (`filesSection` excerpts, files/attached.ts; files/model-input.ts);
 *  - Ensemble's text sent with a file to the person's own agent when its CLI cannot take that format
 *    (`TurnFile.text`, assistant/attachments.ts `turnFilesFor` → subscriptions/turn-files.ts), and to
 *    a paired computer whose Ensemble is too old to receive files (runSubscriptionTurn `fallback`);
 *  - excerpts of a page's files in the assistant's open-page context (assistant/state.ts) and in a
 *    paired computer's task brief (devices/routes.ts), both through `filesSection`.
 *  - the read tools that return a file's extracted text: hub_read_file (assistant/tools/files.ts),
 *    read_attachment (workspace/tools.ts), and uploaded files in hub_search_context /
 *    hub_read_context (assistant/tools/context.ts).
 * A file's summary is not Ensemble's reading of it: a model made it from the file itself when the file
 * was added (context/summary-model.ts). Models are given it wherever files are listed, to tell which
 * file is which without opening it, and a file's name and summary are searchable everywhere
 * (context/graph/search.ts). The Context Bridge is the person's own key reading their Files:
 * ensemble_get_file sends the text when asked and the file itself (bridge/files.ts). Files' extraction
 * stays on for search, previews and page conversion.
 */
export const EXTRACTED_TEXT_TO_MODELS = false;
