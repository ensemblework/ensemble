"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { quickAssignTask } from "@/lib/quick-assign";
import { useToast } from "../toast";

export function useQuickAssign(onOptions: (taskId: string) => void, onAssigned?: () => void) {
  const client = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: quickAssignTask,
    onSuccess: (result) => { void client.invalidateQueries(); toast(`Assigned with ${result.profile}. Follow the run in Workspace.`, { tone: "ok" }); onAssigned?.(); },
    onError: (error: Error, taskId) => { toast(error.message, { tone: "error" }); onOptions(taskId); },
  });
}
