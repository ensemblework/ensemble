import assert from "node:assert/strict";
import test from "node:test";
import { APP_TOOL_LIST, chatToolSpecs, responsesToolSpecs, TOOLS } from "./registry.js";

function numericBounds(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) => numericBounds(child, `${path}[${index}]`));
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (key === "exclusiveMinimum" || key === "exclusiveMaximum") {
        assert.equal(typeof child, "number", `${path}.${key} must use JSON Schema numeric bounds, not OpenAPI boolean bounds`);
      }
      assert.notEqual(key, "nullable", `${path} must use JSON Schema nullability`);
      numericBounds(child, `${path}.${key}`);
    }
  }
}

test("all chat and Responses tool schemas use provider-compatible JSON Schema bounds", () => {
  const tools = [...TOOLS.values(), ...APP_TOOL_LIST];
  assert.equal(new Set(tools.map((tool) => tool.name)).size, tools.length, "tool names are unique across Hub and app tools");
  for (const spec of [...chatToolSpecs(tools), ...responsesToolSpecs(tools)]) numericBounds(spec, "tool");
  const plot = chatToolSpecs(tools).find((spec) => {
    const fn = spec.function;
    return fn !== null && typeof fn === "object" && "name" in fn && fn.name === "hub_create_plot";
  });
  assert.ok(plot);
  const fn = plot.function;
  assert.ok(fn !== null && typeof fn === "object" && "parameters" in fn);
  const json = JSON.stringify(fn.parameters);
  assert.match(json, /"xTickStep":\{[^}]*"exclusiveMinimum":0/);
  assert.doesNotMatch(json, /"exclusiveMinimum":true/);
});
