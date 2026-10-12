"use client";
/** @jsxRuntime automatic */
/** @jsxImportSource react */

import { useQueryClient } from "@tanstack/react-query";
import { Download } from "lucide-react";
import dynamic from "next/dynamic";
import { useState } from "react";
import { TASK_LIKE_KINDS } from "@ensemble/shared-types";
import { appItemsApi } from "@/lib/api-app-items";
import { useSpaceAccess } from "@/lib/access";
import { usePeek } from "../shell/peek";
import { useToast } from "../toast";
import { MenuItem, Popover } from "../ui";
import { AppItemPicker } from "./app-item-picker";

const ImportDialog = dynamic(() => import("../imports/import-dialog").then((mod) => mod.ImportDialog), { ssr: false });

const TASK_KINDS = [...TASK_LIKE_KINDS];

/** The board's Import menu: single issues and cards from connected apps, or a whole board from another app. */
export function BoardImport() {
  const client = useQueryClient();
  const toast = useToast();
  const peek = usePeek();
  const access = useSpaceAccess();
  const [picking, setPicking] = useState(false);
  const [importing, setImporting] = useState(false);
  if (access.guest) return null;
  return (
    <>
      <Popover
        align="right"
        width={250}
        trigger={(_open, toggle) => (
          <button type="button" className="btn" onClick={toggle}>
            <Download size={13} /> Import
          </button>
        )}
      >
        {(close) => (
          <>
            <MenuItem hint="Issues, cards" onClick={() => (close(), setPicking(true))}>
              Add from apps…
            </MenuItem>
            <MenuItem hint="Trello, Jira, Asana" onClick={() => (close(), setImporting(true))}>
              Import a board…
            </MenuItem>
          </>
        )}
      </Popover>
      <AppItemPicker
        open={picking}
        onClose={() => setPicking(false)}
        title="Add tasks from your apps"
        description="Each one becomes a task on this board, linked back to where it came from."
        kinds={TASK_KINDS}
        actionLabel="Add as task"
        doneLabel="Added"
        onPick={async (item) => {
          const result = await appItemsApi.toTask(item);
          void client.invalidateQueries({ queryKey: ["tasks"] });
          toast(result.created ? `Added “${item.title}” to the board.` : `“${item.title}” is already on the board.`, {
            action: { label: "Open", run: () => peek.open(result.taskId) },
          });
        }}
      />
      {importing ? <ImportDialog open onClose={() => setImporting(false)} /> : null}
    </>
  );
}
