/** Kinds that belong on the Artifacts tab. Task rows are not artifacts. */
export const ARTIFACT_KINDS = new Set([
  "email",
  "chat_msg",
  "channel_msg",
  "event",
  "transcript",
  "transcript_segment",
  "file",
  "pr",
  "pr_comment",
  "commit",
  "issue",
  "meeting_note",
]);

export function isListedArtifact(row: { kind: string; title: string }): boolean {
  return ARTIFACT_KINDS.has(row.kind) && row.title.trim().length > 0;
}
