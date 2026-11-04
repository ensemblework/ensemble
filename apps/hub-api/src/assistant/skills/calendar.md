---
name: calendar
title: Calendar, meetings and reminders
when: upcoming meetings and events, what is on a day or week, free time, creating or moving calendar events, reminders
tools: hub_list_events, hub_list_due, hub_list_meeting_notes, hub_read_meeting_note, hub_list_reminders, hub_create_reminder, hub_update_reminder, hub_delete_reminder, hub_dismiss_reminder, hub_list_people, calendar_list_events, calendar_create_event, calendar_update_event, outlook_calendar_list_events, outlook_calendar_create_event, zoom_list_meetings, calendar_list_calendars, outlook_calendar_list_calendars, calendar_free_busy, outlook_calendar_free_busy, calendar_manage_event, outlook_calendar_manage_event, hub_run_workflow
match: \b(calendar|meetings?|events?|schedule[ds]?|agenda|tomorrow|today|tonight|this week|next week|monday|tuesday|wednesday|thursday|friday|saturday|sunday|remind(er)?s?|availability|free (time|slot)|busy|invite|book|reschedule)\b
paths: /today, /meetings
---
Ensemble keeps the person's calendars as one list: Google Calendar, Outlook (Teams meetings included) and calendar links (ICS), read every 30 minutes, with a meeting or holiday that is in several calendars listed once. hub_list_events reads that list; its `calendar` field names every calendar an event came from. For an event's live state, or its id before a change, use the Google/Outlook calendar tools.

Read
- "What meetings do I have tomorrow / this week?" → hub_list_events with absolute dates. Give time, title, who, and the meeting link. Never list one meeting twice.
- "What is my day like?" → hub_list_events for today and hub_list_due for today; mention reminders from hub_list_reminders.
- Free time: list the events for the range and name the gaps inside working hours (9:00–18:00 unless they say otherwise).
- Notes for a meeting: hub_list_meeting_notes (by date or title), then hub_read_meeting_note. Zoom summaries: zoom_list_meetings (past).
- If hub_list_events is empty or its `sync` shows an error but they connected a calendar, read the live calendar: calendar_list_events (Google) or outlook_calendar_list_events, and give a meeting found in both once.

Change
- Create an event: calendar_create_event (Google) or outlook_calendar_create_event, with title, start (YYYY-MM-DDTHH:MM in their time zone), end, attendees as email addresses (from hub_list_people), and googleMeet/teamsMeeting when they want a call. Invites go out when the event is created, so say who will get one.
- Move or rename: find the event id with calendar_list_events, then calendar_update_event.
- These are connected-app writes: they always wait for Apply.
- A private nudge to themselves is a reminder, not an event: hub_create_reminder with dueDate (and dueTime HH:MM). Change with hub_update_reminder, remove with hub_delete_reminder or hub_dismiss_reminder.

Rules
- Always send absolute dates and times. Never "tomorrow" or "5pm" in a tool argument.
- If no calendar is connected, say so and link [Settings → Connections](/settings?tab=connections#calendars): Google, Microsoft 365, or a calendar link (ICS) for iCloud, Proton, Fastmail or holidays.

Available calendars → calendar_list_calendars / outlook_calendar_list_calendars. Availability → calendar_free_busy / outlook_calendar_free_busy with actual calendar IDs/emails and absolute ISO instants. An inaccessible calendar is unknown, never free.
Edit/cancel/RSVP/recurrence → calendar_manage_event / outlook_calendar_manage_event: use a live event ID and exact matchTitle. For a move send both start and end. scope event means one occurrence; series means the entire series and must be requested. Repeating meetings are calendar events, not routines. Creation accepts recurrence: frequency daily/weekly/monthly/yearly, interval, optional weekdays MO..SU and count or until. Updates/cancellation may notify attendees; say who before Apply. No general email or chat sending.

Created calendar events return external id for app operations and hubEventId for linking Ensemble meeting notes. Only the explicitly changed event is saved for Today; this does not fetch other events. Use live calendar reads for current availability and recurring occurrences.
