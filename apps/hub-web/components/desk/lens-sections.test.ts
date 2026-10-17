import "../ui-test-dom.js";
import assert from "node:assert/strict";
import test from "node:test";
import type { DeskLive } from "@/lib/api";
import { contextTabs, selectedContextTabs, PROFILE_CONTEXT, tabKey } from "./context-tabs";
import { deskRole } from "./tile-catalog";
import { DESK_IDS } from "./desks";
import { lensSections, tileFilled } from "./live-board";

function live(attendance: DeskLive["attendance"]): DeskLive {
  return {
    today: "2026-10-16", tasks: [], deliverables: [], people: [], meetings: [], artifacts: [], reminders: [], slots: [], holidays: [],
    attendance, objectives: [], deploys: [], parts: [], tests: [], citations: [], grading: [], repos: [], projects: [], limitation: [], countdowns: [],
  };
}

test("Context's Attendance tile reads the same marks as Today's", () => {
  let seen = 0;
  for (const desk of DESK_IDS) {
    for (const label of [...contextTabs(desk), ...Object.values(PROFILE_CONTEXT).flatMap(profile => profile.optional)]) {
      for (const marked of [true, false]) {
        const data = live(marked ? { present: 6, absent: 0 } : { present: 0, absent: 0 });
        for (const section of lensSections(desk, tabKey(label), data)) {
          if (section.kind !== "attendance") continue;
          seen += 1;
          assert.equal(section.rows.length, 0, "attendance is a count, not rows");
          assert.equal(section.filled, marked, `${desk} › ${label}`);
          assert.equal(section.filled, tileFilled(section.spec, data), "the same check Today uses");
        }
      }
    }
  }
  assert.ok(seen > 0, "some Context tab shows attendance");
});

test("Context defaults are fixed and optional choices stay within each profile", () => {
 assert.deepEqual(selectedContextTabs("engineer",[]),["Overview","People","Projects","Repos","Graph"]);
 assert.deepEqual(selectedContextTabs("student",null),["Overview","People","Projects","Graph"]);
 assert.deepEqual(selectedContextTabs("engineer",["Courses","Reviews","Mocks"]),["Overview","People","Projects","Repos","Mocks","Reviews","Graph"]);
 assert.ok(!selectedContextTabs("student",["Mocks","Parts"]).includes("Mocks"));
});

test("changing a desk layout does not expose another profile’s tabs or tiles",()=>{assert.equal(deskRole("default","semester-desk"),"student");assert.equal(deskRole("bench","branch-desk"),"engineer");});

test("every profile add-on has a data source even with Today extras turned off",()=>{
 const desk={engineer:"branch",student:"semester",teacher:"classes",lawyer:"chambers",manager:"staff",vibe:"bench"} as const;
 for(const role of Object.keys(PROFILE_CONTEXT) as Array<keyof typeof PROFILE_CONTEXT>)for(const label of PROFILE_CONTEXT[role].optional){if(label==="Mocks")continue;assert.ok(lensSections(desk[role],tabKey(label),live({present:0,absent:0})).length,`${role}: ${label}`);}
});
