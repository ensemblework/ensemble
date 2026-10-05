# Context redesign

## Round 5

A long press keeps the drag: once it arms, the card blocks the browser pan, and a swipe before that still scrolls. Lane snapping is off while a card is dragged, so the row auto-scrolls at the edge, easing from about 120 px/s up to 450. A new toast replaces the one on screen. The graph legend names each kind, and the count reads “28 nodes · 34 links” (a short count with that tooltip on a phone). On the board, Edit layout and New task stay on one row. “Drop to link” sits on the top edge of a project card.

## Round 4

A sideways swipe on a card scrolls the lanes. A touch drag starts from the grip or a long press, and holding at the edge scrolls the row. The peek reads the live card, so a rename, undo, or unlink shows up without reopening it. Unlink is only offered for a person or a repo on a project. Deliverable Open goes to that deliverable. The graph toolbar is one compact row; focus, Ask, refresh, and full screen sit in More. People and project labels stay on the graph. Toasts queue for about 8 seconds. Shared chips appear only when every card in the lane has them.

## Round 3

Touch reorder keeps capture on the grip, so a finger move no longer cancels the drag. Peek menus stay inside the viewport, above the scrim. Lane counts show the filter (`1 / 4`), and a miss says “Nothing matches” once. Titles wrap to two lines. Shared chips and identical meta sit on the lane, not on every card. Page titles use one display face. Connect a source is quiet once a source is on.

## Round 2

Lanes stay between the content width and 300px. Once the row is at least 1040px they share it, capped at 300px, so five lanes sit on a 1440 screen and a single lane does not stretch across the page. Narrower widths keep a 280px lane and scroll inside the row, with an edge fade and a next control. A lane never grows with its text. Empty lanes collapse to a one-line rail. Cards differ by kind: people keep a tinted disc, projects show a progress bar and member stack, repos show a language dot and owner/name, meetings and deliverables show a date block. The grip is a small hover handle. A cancelled touch or Escape drops the drag without saving. The peek is a dialog with a scrim, Escape, a focus loop, clickable links, and Remove behind More, with an undo toast. Deliverables share the Artifacts lane. Dates use en-IN: relative when recent, otherwise “28 Sept”.

Context is the map of the work: people, projects, repos, meetings, and artifacts, and the links between them. The overview was a widget grid of plain rows. It now opens on a board of lanes. The widget grid stays available as a layout view; it is no longer the first thing you see.

## Information architecture

The page has one title, a view switcher, a filter, and the view.

| View | What it is |
| --- | --- |
| Board | Default. One lane per kind: People, Projects, Repos, Meetings, Artifacts. |
| Grid | The same cards, wrapped. |
| List | A dense row for each entity: avatar, name, kind, detail, links, when. |
| Graph | The existing graph, full height. |

`Group by` is Kind or Project. Project mode turns each project into a lane of the people, repos, meetings, and artifacts already linked to it, plus an Unlinked lane. A card can sit in more than one project lane. Order is stored per lane.

Deep links:

| URL | Lands on |
| --- | --- |
| `/context` | Last view, or Board |
| `?view=board\|grid\|list\|graph` | That view |
| `?view=widgets` | The saved widget layout, including Edit layout |
| `?tab=people\|projects\|repos\|meetings\|artifacts` | Board (or the current view) filtered to that lane |
| `?tab=graph` | Graph |
| `?tab=preferences` and `?tab=sources` | Those tools, unchanged |
| `?search=`, `?who=`, `?ids=` | The same filters as before |

The last view and the manual order live in the preference `hub.context.board`. That key is hidden from the Preferences list (`hub.*`). Changing it does not write an undo entry. Reset to template does not touch it.

## Cards

A card is an entity, not a row of text.

- People: initials on a warm disc, role, last interaction, project chips.
- Projects: name, summary, task and deliverable counts, people and repo chips.
- Repos: name, language or provider, role, last sync, project chips.
- Meetings: note title, when, linked project.
- Artifacts: kind, title, when, linked project.

Each lane shows at most 24 cards from the server, and 8 until you ask for the rest. Search filters what is already loaded. Nothing on this page renders an unbounded list.

Empty lanes say what would fill them and point at Connect or at adding a person or project. Skeletons match the lane height when the board payload is missing.

## Interactions

Reorder is inside a lane. The handle is the grip; the rest of the card opens the peek. Dropping on a card inserts at that card (a neighbour swaps). The floating label stays inside the viewport. Alt+ArrowUp and Alt+ArrowDown do the same move from the keyboard.

Order is saved with `PUT /api/context/order`. The server keeps at most 80 ids per lane, drops ids the user does not own, and rejects a body over 8 KB. Unknown ids are ignored so a stale client does not fail.

Dropping a person or a repo onto a project card does not link them immediately. The card asks "Link A to B?" and Apply calls the existing project update (`personIds` or `repoIds`), which already checks ownership. Cancel leaves the order unchanged. Artifact and meeting drops do not invent a link.

The peek is a side panel (full width below 768). It shows the same facts as the card, the relationship chips, and Ask Ensemble for that entity. People can be removed from the peek. Hovering a card lights the cards that share a person, repo, or project with it. `/` focuses the filter. Jump to stays the existing Ctrl/⌘K palette.

## Motion and tokens

Hover lifts a card by 1px and strengthens the border. The drag chip rotates slightly and uses the existing ease (`--ease`). Reduced motion turns the lift and the chip transition off. Kind colour is a disc and a lane wash, not a rainbow header.

New tokens in `globals.css`: `--elev-1` and `--elev-2` for resting and dragged surfaces, in both themes. Cards, list rows, trash rows, and completed rows share `.entity-card` and `.entity-row`.

## Widget tiles

The widget layout uses the same discs, role line, and kind pip in the tile header. The graph tile keeps a soft accent wash and a glow under each node so a sparse graph does not read as an empty box. It still zooms to the tile.

## Rest of the app

Type, radius, and elevation stay on the existing scale. Today tile headers gain a kind pip and a slightly larger label. Trash, Completed, and Recap rows use `.entity-row` instead of a bare divider list. Role and template cards on `/start` use the existing lift. Meeting-note rows in the side list use the tile surface. Flows are unchanged.

## Budget

The board is server-rendered from `GET /api/context/board`. The client uses that payload as its first state and does not refetch it, so the first HTML already has the lanes. Context first-load JS may grow by at most 15 kB from the feature-2 head (114 kB). Other routes may grow by at most 5 kB. Drag is pointer events in the Context chunk, not a drag library. The graph, Ask, and the widget layout load only when those views open.
