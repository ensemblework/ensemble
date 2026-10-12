---
name: files
title: Files and items from connected apps
when: find, read or summarise files (PDF, Word, slides, sheets) and items synced from apps; bring a file in from Drive, OneDrive, Dropbox, Box, Gmail or Outlook; attach a file to a page
tools: hub_list_files, hub_read_file, hub_search_context, hub_read_context, hub_import_app_file, apps_search, apps_read, hub_update_page, hub_read_page, hub_delete_entity, hub_restore_entity
appTools: true
match: \b(files?|pdfs?|docx?|word doc(ument)?s?|pptx?|powerpoint|slides?|decks?|xlsx?|excel|spreadsheets?|csv|attachments?|uploads?|uploaded|documents?|resume|cv|contract|invoice|report)\b
paths: /files
mentions: file
---
Two kinds of things live in Files:
- Files (`/files`): uploaded or imported originals. hub_list_files lists them (name, kind, size, where they came from); hub_read_file reads one's text in parts.
- Items from apps (`/files?view=apps`): mail, events, messages, pull requests and issues Ensemble synced. hub_search_context finds them, hub_read_context reads one.

Read and answer
- "What does the contract say about X?" → hub_list_files query "contract" → hub_read_file id; keep reading with nextOffset while you still need text. Quote the passage you rely on.
- "Summarise the deck" → hub_read_file, then a short summary by slide or section.
- A file on the open page appears as [file: name (id …)]; read it by that id.
- Scanned PDFs have no text; say so.

Bring a file in
- The file is in a connected app: apps_search with the words, app "google_workspace" (Drive, Gmail attachments), "microsoft_365" (OneDrive, Outlook), "dropbox" or "box", and kind "file" (or "attachment" for an email attachment; Gmail search words work, like `from:arjun filename:pdf`). Show the matches with names and dates and let them pick unless exactly one fits.
- Then hub_import_app_file with source (the same app id), kind and id from the pick. It saves a copy in Files and returns its id and link. It waits for Apply.
- Hosted accounts keep at most 10 files and 50 MB in total; if import is refused for room, say which limit and that removing a file in Files frees room.
- A Google Doc, Sheet or Slides comes in as Word, Excel or PowerPoint.

Attach to a page
- hub_update_page with pageId (or taskId), matchTitle = the page's current title, mode "append" and a line `[@<file name>](ensemble://file/<file id>)`; it becomes a file card on that page.

Remove
- A file: hub_delete_entity kind "document" with the file id (goes to Trash; hub_restore_entity brings it back).

If no app is connected for what they want, say which one to connect and link [Settings → Connections](/settings?tab=connections).
