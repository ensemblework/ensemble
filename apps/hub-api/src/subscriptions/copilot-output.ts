/** Consume only events emitted by the Copilot process Ensemble started for this turn. */
export function copilotOutput(model: string | null, onDelta: (text: string) => void) {
  const result = { text: "", model, tokensIn: null as number | null, tokensOut: null as number | null, costUsd: null };
  let streamed = "";
  const valid = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  return {
    result,
    line(line: string) {
      let event: { type?: string; data?: Record<string, unknown> };
      try { event = JSON.parse(line); } catch { return; }
      const data = event?.data;
      if (!data) return;
      if (event.type === "assistant.usage") {
        if (typeof data.model === "string" && data.model) result.model = data.model;
        if (valid(data.inputTokens)) result.tokensIn = (result.tokensIn ?? 0) + data.inputTokens;
        if (valid(data.outputTokens)) result.tokensOut = (result.tokensOut ?? 0) + data.outputTokens;
        // Copilot's cost field is not USD or Ensemble credits. Do not reinterpret it as either.
      } else if (event.type === "assistant.message_delta" && typeof data.deltaContent === "string") {
        if (!streamed && result.text) onDelta("\n\n");
        streamed += data.deltaContent;
        onDelta(data.deltaContent);
      } else if (event.type === "assistant.message" && typeof data.content === "string") {
        const rest = data.content.startsWith(streamed) ? data.content.slice(streamed.length) : streamed ? "" : data.content;
        if (rest) { if (!streamed && result.text) onDelta("\n\n"); onDelta(rest); }
        result.text += (result.text ? "\n\n" : "") + data.content;
        streamed = "";
      }
    },
    finish() { result.text = (result.text + (result.text && streamed ? "\n\n" : "") + streamed).trim(); return result; },
  };
}
