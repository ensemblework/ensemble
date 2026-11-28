import assert from "node:assert/strict";
import test from "node:test";
import { cleanContextHref } from "./context-href";

const clean = (query: string) => cleanContextHref(new URLSearchParams(query));

test("old widgets links and the removed tabs land on Context itself, on the same tab when Context has it", () => {
  assert.equal(clean("view=widgets"), "/context");
  assert.equal(clean("view=widgets&tab=overview"), "/context");
  for (const tab of ["people", "projects", "repos", "graph"]) assert.equal(clean(`view=widgets&tab=${tab}`), `/context?tab=${tab}`, tab);
  for (const tab of ["preferences", "sources", "artifacts"]) {
    assert.equal(clean(`tab=${tab}`), "/context", tab);
    assert.equal(clean(`view=widgets&tab=${tab}`), "/context", `widgets ${tab}`);
  }
  // What the tab needs comes along.
  assert.equal(clean("view=widgets&tab=people&who=Mira%20Chen&search=mira"), "/context?tab=people&who=Mira+Chen&search=mira");
});

test("Context's own addresses are left alone", () => {
  for (const query of ["", "tab=repos", "tab=people&who=Mira", "tab=overview", "tab=deploys", "view=desk", "view=graph", "tab=people&person=11111111-1111-4111-8111-111111111111"]) {
    assert.equal(clean(query), null, query);
  }
});
