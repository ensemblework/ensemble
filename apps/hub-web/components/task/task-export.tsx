"use client";

import { api } from "@/lib/api";
import { taskDoc } from "@/lib/export/items";
import { OWNER_LABEL } from "@/lib/format";
import { taskPersonId, useSpacePeople } from "@/lib/space-people";
import { ExportMenu } from "../export-menu";

/** Download for one task: its properties plus its page. Reads fresh copies when a format is picked. */
export function TaskExportMenu({ taskId }: { taskId: string }) {
  const space = useSpacePeople();
  return (
    <ExportMenu
      load={async () => {
        // Direct reads, not the query cache: refreshing ["page", id] would reset an open editor.
        const [task, page] = await Promise.all([api.task(taskId), api.page(taskId).catch(() => null)]);
        const record = task.task;
        const personId = taskPersonId(record, space.ownerId) ?? space.me;
        const owner = record.owner !== "me" ? (OWNER_LABEL[record.owner] ?? record.owner) : (space.byId.get(personId ?? "")?.name ?? "Me");
        return taskDoc(record, page, owner);
      }}
    />
  );
}
