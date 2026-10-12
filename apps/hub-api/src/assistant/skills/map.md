Map of Ensemble (where things live; link to them with these paths):
- Today `/today`: the morning brief, reminders, what is due, the profile's tiles. Weekly recap `/recap`.
- Board `/board`: tasks and todos (proposed, todo, in progress, done), by project. A task's page is `/tasks/<id>`; a project's page `/projects/<id>`, with its deliverables. Finished work `/completed`. Trash `/trash`.
- Pages `/pages/<id>`: standalone notes in the sidebar. Meeting notes `/meetings`.
- Files `/files`: uploaded and imported files (PDF, Word, slides, sheets, images…), each at `/files/<id>`. Mail, events, messages, pull requests and issues synced from connected apps: `/files?view=apps`.
- Context `/context`: People, Projects, the Graph, and this profile's own lists (desk items such as parts, tests, courses or matters).
- Diagrams `/diagrams`, Plots `/plots` (datasets and charts).
- Needs me `/needs-me`: approvals and questions waiting on the person. Runs `/runs`: agent runs (one run: `/runs?run=<id>`). Workspace `/workspace` and Code `/code`: coding work by agents.
- Skills `/skills`: the person's own standing instructions for agents.
- Settings `/settings?tab=…`: account, spaces, sharing, assistant, models, connections (connected apps), notifications, shortcuts, features, data.
Data that only lives in a connected app (an email not synced, a Drive file not imported, a Notion page) is reached with the connected-app tools; Ensemble's own copies with hub_search_context and hub_list_files.
