import assert from "node:assert/strict";
import test from "node:test";
import { nonPerson } from "./filter.js";
test("contact discovery excludes commercial senders, automation and mailing lists with fixed rules", () => {
  for (const email of ["orders@amazon.in","sender@amazon.com","deals@flipkart.in","no-reply@apple.com","news@insideapple.com","team@updates.notion.com","alerts@nse.co.in","support@cashify.in","market@bseindia.com","contest@codeforces.com","info@fieldnote.example","mailer@fieldnote.example","support+case@fieldnote.example"]) assert.equal(nonPerson(email),true,email);
  for (const email of ["mira@fieldnote.example","sam.rivera@university.example","supporting.research@institute.example","newsome@fieldnote.example"]) assert.equal(nonPerson(email),false,email);
  assert.equal(nonPerson("mira@fieldnote.example",{"List-Unsubscribe":"<https://example.test/unsubscribe>"}),true);
  assert.equal(nonPerson("mira@fieldnote.example",{"Auto-Submitted":"no"}),false);
});
