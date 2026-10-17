import { prisma } from "../../lib/prisma.js";
import { loadSettings } from "../../lib/settings.js";
import { requireVerifiedUser } from "../../lib/hosted-access.js";
import { isGuestIn } from "../../sharing/context.js";
import { createProposals } from "../triage.js";
import { meetingSource } from "./index.js";
import type { MeetingVendor } from "./types.js";
/** Explicit assistant import. Generic contact sync never invokes transcript adapters. */
export async function importRequestedMeetings(userId: string, source: MeetingVendor, since: Date, proposeTasks = false) {
  if (isGuestIn(userId)) throw Object.assign(new Error("Import meeting notes in a space you own."), { statusCode: 403 });
  await requireVerifiedUser(userId);
  const settings = await loadSettings(prisma,userId);
  const adapter = meetingSource(source)!;
  const result = await adapter.sync({userId,settings,since,cursor:null});
  const proposed = proposeTasks ? await createProposals(userId,result.proposals,"connector") : 0;
  return {ok:true,items:result.items,proposed,message:`Imported ${result.items} meeting note(s). ${proposed} action item(s) proposed.`};
}
