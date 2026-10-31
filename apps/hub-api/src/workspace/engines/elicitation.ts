/**
 * A form an agent asks the person to fill: ACP's `elicitation/create` (OpenCode's question tool, any
 * ACP agent), or an MCP server's elicitation inside Codex. Each field becomes a question with its
 * choices, asked like every other question of the run (Needs me, or the node's chat), and the
 * answers go back as the form's content. Nobody is watching an unattended run: a field's default,
 * else its first choice, is taken and listed on the task. A form asking for a password, key or
 * token is declined, as the protocol does not let agents collect those in a form.
 */
import { askPerson, type JobContext } from "../tools.js";

export type FormAnswer = { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> };

type Field = {
  key: string;
  title: string;
  /** The field has a title or description of its own (not only its key). */
  named: boolean;
  required: boolean;
  /** The choices shown and the value each stands for. */
  choices: Array<{ label: string; value: unknown }>;
  /** A typed answer is taken (free text, a number, or a choice list with its own "other"). */
  typed: "text" | "number" | null;
  many: boolean;
  fallback: unknown;
};

const SECRET = /password|passphrase|secret|token|api[_ -]?key|credential|private[_ -]?key|recovery code|\bpin\b|\bcvv\b|card number/i;
const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

function choicesOf(schema: Record<string, unknown>): Array<{ label: string; value: unknown }> {
  const titled = (Array.isArray(schema.oneOf) ? schema.oneOf : Array.isArray(schema.anyOf) ? schema.anyOf : []).map(record).filter((row) => "const" in row);
  if (titled.length) return titled.map((row) => ({ label: text(row.title) ?? String(row.const), value: row.const }));
  const values = Array.isArray(schema.enum) ? schema.enum : [];
  const names = Array.isArray(schema.enumNames) ? schema.enumNames : [];
  return values.map((value, index) => ({ label: text(names[index]) ?? String(value), value }));
}

/** The form's fields as questions, or null when it asks for something secret or something a question cannot carry. */
export function formFields(requestedSchema: unknown): Field[] | null {
  const schema = record(requestedSchema);
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === "string") : []);
  const fields: Field[] = [];
  for (const [key, raw] of Object.entries(record(schema.properties))) {
    const property = record(raw);
    const title = text(property.title) ?? key;
    if ([key, title, text(property.description) ?? ""].some((value) => SECRET.test(value))) return null;
    const many = property.type === "array";
    const choices = choicesOf(many ? record(property.items) : property);
    const base = { key, title: text(property.description) ? `${title}: ${text(property.description)}` : title, named: Boolean(text(property.title) ?? text(property.description)), required: required.has(key), many, fallback: property.default };
    if (property.type === "boolean") fields.push({ ...base, choices: [{ label: "Yes", value: true }, { label: "No", value: false }], typed: null });
    else if (choices.length) fields.push({ ...base, choices, typed: null });
    else if (property.type === "number" || property.type === "integer") fields.push({ ...base, choices: [], typed: "number" });
    else if (property.type === "string" || property.type === undefined) fields.push({ ...base, choices: [], typed: "text" });
    else return null;
  }
  return fields;
}

/** Asks the person to fill the form, one question per field; `ask` stands in for Needs me in tests. */
export async function answerForm(
  ctx: JobContext,
  input: { message: string; requestedSchema: unknown },
  ask: typeof askPerson = askPerson,
  withdrawn?: AbortSignal,
): Promise<FormAnswer> {
  const fields = formFields(input.requestedSchema);
  if (!fields) return { action: "decline" };
  const message = input.message.trim().slice(0, 600) || "The agent has a question.";
  // A form with nothing to fill is a yes-or-no: go ahead, or not.
  const asked: Field[] = fields.length ? fields : [{ key: "", title: message, named: false, required: true, choices: [{ label: "Yes", value: true }, { label: "No", value: false }], typed: null, many: false, fallback: true }];
  const content: Record<string, unknown> = {};
  for (const field of asked) {
    const question = fields.length > 1 ? `${message} — ${field.title}` : field.named && fields.length === 1 && !message.includes(field.title) ? `${message} (${field.title})` : message;
    const fallback = field.choices.find((choice) => choice.value === field.fallback) ?? (field.fallback === undefined ? field.choices[0] : undefined);
    let value: unknown;
    if (ctx.job.unattended) {
      value = fallback?.value ?? field.fallback;
      if (value === undefined) {
        if (field.required) return { action: "decline" };
        continue;
      }
      const options = field.choices.map((choice) => choice.label);
      ctx.decisions?.push({ question, options, recommended: fallback?.label ?? String(value) });
      await ctx.event("decision", { question, options, recommended: fallback?.label ?? String(value), by: "unattended" });
    } else {
      await ctx.progress(`Waiting for your answer: ${question.slice(0, 80)}`);
      const answer = await ask(ctx, { event: "question", toolName: "question", title: question.slice(0, 300), options: field.choices.map((choice) => choice.label), allowCustom: field.typed !== null, recommended: fallback?.label ?? null }, withdrawn);
      if (answer.decision === "expired") return { action: "cancel" };
      const given = answer.decision === "allow" ? text(answer.answer) : null;
      if (given === null) {
        if (field.required) return { action: "decline" };
        continue;
      }
      const chosen = field.choices.find((choice) => choice.label === given);
      if (chosen) value = chosen.value;
      else if (field.typed === "number") {
        const number = Number(given);
        if (!Number.isFinite(number)) return { action: "decline" };
        value = number;
      } else if (field.typed === "text") value = given;
      else return { action: "decline" };
    }
    if (!field.key) return value === false ? { action: "decline" } : { action: "accept", content: {} };
    content[field.key] = field.many ? [value] : value;
  }
  return { action: "accept", content };
}

/**
 * What Ensemble offers an ACP agent (Copilot, Cursor's agent and the ACP runner): no files or terminal
 * of its own (the agent uses its own, judged per call), and form questions (`elicitation/create`).
 */
export const ACP_CLIENT_CAPABILITIES = { fs: { readTextFile: false, writeTextFile: false }, terminal: false, elicitation: { form: {} } };

/** An agent's `elicitation/create`: a form is asked field by field; a link to open (URL mode, not offered) is declined. */
export async function answerElicitation(ctx: JobContext, params: Record<string, unknown>, ask: typeof askPerson = askPerson): Promise<FormAnswer> {
  // A form when the mode is left out, as MCP's elicitation defaults to it.
  if (params.mode !== undefined && params.mode !== "form") return { action: "decline" };
  return answerForm(ctx, { message: text(params.message) ?? "", requestedSchema: params.requestedSchema }, ask);
}
