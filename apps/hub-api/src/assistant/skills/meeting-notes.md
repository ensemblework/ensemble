---
name: meeting-notes
title: Meeting notes
when: find, read, write, edit, recap or delete meeting notes; action items and decisions from a meeting; notes imported from Zoom or other meeting tools
tools: hub_list_meeting_notes, hub_read_meeting_note, hub_create_meeting_note, hub_update_meeting_note, hub_delete_meeting_note, hub_restore_entity, hub_list_events, hub_list_people, hub_create_tasks, hub_search_context, zoom_list_meetings, zoom_get_meeting_summary, zoom_get_transcript, zoom_list_recordings
match: \b(meeting notes?|minutes|transcripts?|standup|stand-up|1:1|one-on-one|sync notes|retro|action items?|decisions?|recap (of|from) (the|my|our|today'?s|yesterday'?s) (meeting|call|sync))\b
paths: /meetings
---
Meeting notes live at `/meetings`. Some are written in Ensemble; others come in from connected meeting tools (Zoom and others) and say where they came from.

Find and read
- hub_list_meeting_notes with query (title or person) and/or from/to dates; then hub_read_meeting_note with meetingId for the full notes, attendees, decisions and action items (in parts if long). Notes from meeting tools say where they came from and are read-only.
- "What did we decide with Mira last week?" → hub_list_meeting_notes (query "Mira", from/to last week) → read each → answer with the decisions and who owns what.
- A Zoom meeting with no note in Ensemble: zoom_list_meetings (past) → zoom_get_meeting_summary, or zoom_list_recordings → zoom_get_transcript.

Write
- New note: hub_create_meeting_note with title, date (YYYY-MM-DD), time (HH:MM), notes in Markdown (sections "Notes", "Decisions", "Action items"), attendeeIds from hub_list_people, and eventId from hub_list_events when it was a calendar meeting (title, time and attendees then come from the event).
- Add to or rewrite a note: hub_update_meeting_note with meetingId, matchTitle = its current title, mode "append" or "replace", notes. Delete: hub_delete_meeting_note with meetingId (Trash; Undo or [Trash](/trash) brings it back). Imported notes cannot be changed or deleted here.
- Turn action items into tasks: one hub_create_tasks call with each item as a task (owner and due when the note says), status "proposed".
- Recap a meeting: read it, then write 3–6 bullets of decisions and next steps; save with hub_update_meeting_note (mode "append", a "Recap" heading) only if they asked to save it.

Rules
- Use only what the notes or transcript say. Name owners only when the text does.
- Writes wait for Apply.
