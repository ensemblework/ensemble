/**
 * Turns a remote MCP tool's inputSchema into JSON Schema every model provider
 * accepts as function parameters: an object at the top, no OpenAPI-only
 * keywords, numeric exclusive bounds, and a size cap.
 */

const MAX_SCHEMA_CHARS = 12_000;
const MAX_DEPTH = 12;
/** Keywords providers reject or that only add size. */
const DROP = new Set(["$schema", "$id", "$comment", "nullable", "examples", "readOnly", "writeOnly", "deprecated", "xml", "externalDocs"]);
/** Values copied as data, not walked as schemas. */
const LITERAL = new Set(["enum", "const", "default", "required"]);
/** Maps of name → schema. Their keys are property names, not keywords. */
const SCHEMA_MAPS = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);
/** Top-level combinators providers refuse on function parameters. */
const TOP_LEVEL_REFUSED = ["anyOf", "oneOf", "allOf", "not", "enum", "const", "if", "then", "else"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clean(node: unknown, depth: number): unknown {
  if (Array.isArray(node)) return node.map((child) => clean(child, depth + 1));
  if (!isRecord(node)) return node;
  if (depth > MAX_DEPTH) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (DROP.has(key)) continue;
    if ((key === "exclusiveMinimum" || key === "exclusiveMaximum") && typeof value !== "number") continue;
    if (LITERAL.has(key)) out[key] = value;
    else if (SCHEMA_MAPS.has(key) && isRecord(value)) {
      out[key] = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, clean(child, depth + 1)]));
    } else out[key] = clean(value, depth + 1);
  }
  if (node.exclusiveMinimum === true && typeof node.minimum === "number") {
    out.exclusiveMinimum = node.minimum;
    delete out.minimum;
  }
  if (node.exclusiveMaximum === true && typeof node.maximum === "number") {
    out.exclusiveMaximum = node.maximum;
    delete out.maximum;
  }
  if (node.nullable === true && typeof out.type === "string" && out.type !== "null") out.type = [out.type, "null"];
  return out;
}

function shallow(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const slim: Record<string, unknown> = {};
  for (const [name, child] of Object.entries(properties)) {
    const entry: Record<string, unknown> = {};
    if (isRecord(child)) {
      if (typeof child.type === "string" || Array.isArray(child.type)) entry.type = child.type;
      if (typeof child.description === "string") entry.description = child.description.slice(0, 200);
      if (Array.isArray(child.enum) && JSON.stringify(child.enum).length < 400) entry.enum = child.enum;
    }
    slim[name] = entry;
  }
  return { type: "object", properties: slim, ...(Array.isArray(schema.required) ? { required: schema.required } : {}) };
}

export type ProviderSchema = {
  schema: Record<string, unknown>;
  /** Top-level required property names, for a quick check before the call goes out. */
  required: string[];
  /** True when the schema was cut down to fit. */
  trimmed: boolean;
};

export function providerSafeSchema(raw: unknown): ProviderSchema {
  let schema = (isRecord(raw) ? clean(raw, 0) : {}) as Record<string, unknown>;
  for (const key of TOP_LEVEL_REFUSED) delete schema[key];
  schema.type = "object";
  if (!isRecord(schema.properties)) schema.properties = {};
  if (schema.required !== undefined && !(Array.isArray(schema.required) && schema.required.every((item) => typeof item === "string"))) {
    delete schema.required;
  }
  let trimmed = false;
  if (JSON.stringify(schema).length > MAX_SCHEMA_CHARS) {
    trimmed = true;
    schema = shallow(schema);
    if (JSON.stringify(schema).length > MAX_SCHEMA_CHARS) schema = { type: "object", properties: {}, additionalProperties: true };
  }
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  return { schema, required, trimmed };
}
