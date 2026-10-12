import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import { navigationDestinations, navigationScore } from "./navigation-destinations.js";
import { SETTINGS_DESTINATIONS, findSettingsTarget } from "../settings/navigation.js";
import { parseSettingsLocation } from "../settings/url-state.js";

const options = {modules:"code,workspace,runs,metrics,skills,diagrams,plots",template:"mkt.branch-desk"};
test("Jump to ranks deep controls and app sections ahead of their parent views",()=>{
  for (const [query, label, path] of [
    ["Accent","Accent","/settings?tab=account#jump-appearance-accent"],
    ["people","People","/context?tab=people"],
    ["graph","Graph","/context?tab=graph"],
    ["Local repositories","Local repositories","/code#local-repositories"],
    ["diagrams","Diagrams","/diagrams"],
    ["files","Files","/files"],
    ["time zone","Time zone","/settings?tab=account#jump-you-time-zone"],
  ]) {
    const first=navigationDestinations(query,options)[0]; assert.equal(first?.label,label,query); assert.equal(first?.href,path,query);
  }
  const google=navigationDestinations("Google",options); assert.equal(new Set(google.map(row=>row.href)).size,google.length);
  assert.ok(navigationDestinations("font",options).some(row=>row.label==="App font"));
  assert.ok(navigationDestinations("reasoning",options).some(row=>row.label==="Low model thinking"));
  assert.ok(navigationDestinations("Google Calendar",options).some(row=>row.href.includes("connector=google_workspace")));
  assert.ok(navigationDestinations("color",options).some(row=>row.label==="Accent"));
  assert.equal(navigationScore("appearance colour","Accent","Settings › Account › Appearance","color"),20);
});
test("Jump to has no record-name lookup and respects optional modules and shared-space access",()=>{
  assert.deepEqual(navigationDestinations("ML Model to Classifier",options),[]);
  assert.deepEqual(navigationDestinations("Mira Chen",options),[]);
  assert.ok(!navigationDestinations("local repositories",{modules:""}).some(row=>row.href.startsWith("/code")));
  assert.ok(!navigationDestinations("custom accent",{...options,guest:true}).some(row=>row.href.includes("tab=connections")));
  assert.ok(!navigationDestinations("Trash",{...options,guest:true}).some(row=>row.href.includes("tab=data")));
  assert.equal(new Set(SETTINGS_DESTINATIONS.map(row=>row.id)).size,SETTINGS_DESTINATIONS.length);
  for(const row of SETTINGS_DESTINATIONS) assert.equal(parseSettingsLocation("",`#${row.id}`).tab,row.tab);
});
test("deep Settings navigation resolves a rendered label without jumping to its parent heading",()=>{
  const root=document.createElement("div");root.innerHTML='<section data-setting-label="Appearance"><h2>Appearance</h2><div data-jump-label="Accent">Accent</div><label>Time zone<input></label><input aria-label="Full name"></section>';
  assert.equal(findSettingsTarget(root,"Accent")?.dataset.jumpLabel,"Accent");
  assert.equal(findSettingsTarget(root,"Time zone")?.tagName,"LABEL");
  assert.equal(findSettingsTarget(root,"Full name")?.tagName,"INPUT");
});
