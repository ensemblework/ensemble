---
name: files
title: Files and items from connected apps
when: find, read or summarise files (PDF, Word, slides, sheets) and items synced from apps; bring a file in from Drive, OneDrive, Dropbox, Box, Gmail or Outlook, or from a web link; attach a file to a page
tools: hub_list_files, hub_view_file, hub_search_context, hub_read_context, hub_import_app_file, hub_save_file, apps_search, apps_read, hub_update_page, hub_read_page, hub_delete_entity, hub_restore_entity, hub_file_edit_info, hub_edit_file, hub_file_to_page, hub_export_page_file, hub_run_workflow, hub_manage_record
appTools: true
match: \b(files?|pdfs?|docx?|word doc(ument)?s?|pptx?|powerpoint|slides?|decks?|xlsx?|excel|spreadsheets?|csv|attachments?|uploads?|uploaded|documents?|resume|cv|contract|invoice|report)\b
paths: /files
mentions: file
---
Two kinds of things live in Files:
- Files (`/files`): uploaded or imported originals. hub_list_files lists them (name, kind, size, where they came from); hub_view_file opens one: you are given the file itself.
- Items from apps (`/files?view=apps`): mail, events, messages, pull requests and issues Ensemble synced. hub_search_context finds them, hub_read_context reads one.

Read and answer
- "What does the contract say about X?" → hub_list_files query "contract" → hub_view_file id. Quote the passage you rely on.
- "Summarise the deck" → hub_view_file, then a short summary by slide or section.
- A file on the open page is listed with its id; open it by that id.
- If you cannot read a file you were given, say so rather than guess.

Bring a file in
- The file is in a connected app: apps_search with the words, app "google_workspace" (Drive, Gmail attachments), "microsoft_365" (OneDrive, Outlook), "dropbox" or "box", and kind "file" (or "attachment" for an email attachment; Gmail search words work, like `from:arjun filename:pdf`). Show the matches with names and dates and let them pick unless exactly one fits.
- Then hub_import_app_file with source (the same app id), kind and id from the pick. It saves a copy in Files and returns its id and link. It waits for Apply.
- Hosted accounts keep at most 10 files and 50 MB in total; if import is refused for room, say which limit and that removing a file in Files frees room.
- A Google Doc, Sheet or Slides comes in as Word, Excel or PowerPoint.
- A file on the web (a paper, a report, an image): hub_save_file with url, the direct link to the file (for a paper, its official PDF link). A web page is refused. It returns the file's link (ensemble://file/<id>): give only that link, never one you write yourself.

Attach to a page
- hub_update_page with pageId (or taskId), matchTitle = the page's current title, mode "append" and a line `[@<file name>](ensemble://file/<file id>)`; it becomes a file card on that page.

Remove
- A file: hub_delete_entity kind "document" with the file id (goes to Trash; hub_restore_entity brings it back).

If no app is connected for what they want, say which one to connect and link [Settings → Connections](/settings?tab=connections).

Edit an original: hub_view_file → hub_file_edit_info → hub_edit_file with the returned expectedSha256. replace_text changes one unique exact passage in Word, PowerPoint or text/code/CSV; edit_cells takes sheet names and 1-based row/col values, or deleteRows. Unsupported workbook features are refused.
Make a page → hub_file_to_page (PDF/Word need Markdown from what you read in the file). Export a page → hub_export_page_file. File edits preserve the ID so attachments follow. A Word export rebuilds formatting; tell the person before replacing an original.

Other record maintenance → hub_manage_record (restore one trashed record, page/task conversion, supported plot/diagram/dataset actions, file tags and internal comments). Use the relevant real ID; it preserves the app's existing access and deletion rules.
