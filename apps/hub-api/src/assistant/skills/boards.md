---
name: boards
title: Custom boards
when: the person's own boards beside the Ensemble board (“my EnsembleWork board”, a /board?board=<id> link): read their columns and cards, make or change boards and columns, put, move or take off tasks and notes
tools: hub_list_boards, hub_read_board, hub_create_board, hub_update_board, hub_delete_board, hub_move_to_board, hub_remove_from_board, hub_list_tasks, hub_get_task, hub_update_task, hub_create_tasks, hub_list_pages, hub_read_page, hub_create_page, hub_run_workflow
match: \b(custom boards?|boards|(?:my|the|our|a|new|this|that|their) [\w-]+ board|columns?|lanes?|kanban)\b|[?&]board=
---
Custom boards are the person's own boards beside the Ensemble board, each at /board?board=<id> (“my EnsembleWork board”). A board has columns, left to right, and cards: tasks (a task's page, with its status) and notes (standalone pages). A card is on one board at a time. You already act in Ensemble: never open a board's link in a browser and never ask the person to sign in.

Find
- A pasted link (https://app.ensemblework.com/board?board=<id>), an id or a title: pass it as board to hub_read_board exactly as given. Not sure of the name: hub_list_boards.
- hub_read_board gives each column's cards, top first: kind task (its id is the task id: hub_get_task, hub_update_task) or kind page (a note: hub_read_page with pageId). A long column: read it alone with column.

Change
- New board: hub_create_board with title and columns in order.
- Columns: hub_update_board with columns edits in order: add {name}, rename {column, name}, move {column, position} (1 is leftmost), color {column, color}, remove {column} (only an empty column: move its cards first).
- Put a task or note on a column, or move it: hub_move_to_board {board, column, taskId or pageId}; after or before another card, or position top. A card's column is the board's own: when they say a task is done or started, also hub_update_task status.
- A new task or note on a board: hub_create_tasks or hub_create_page, then hub_move_to_board with the id it returned. When writes wait for Apply, do both in one hub_run_workflow with a $ref.
- Take a card off: hub_remove_from_board (nothing is deleted). Delete a board: hub_delete_board (always waits for Apply; its cards are kept).

Rules
- “Work on my board”: read it first; its cards are the work. Do or plan them as usual and move each card when its state changes.
- Name boards and cards by title; link a board with the url hub_read_board returned.
- Ensemble Node: a board belongs to one space. Not found where you looked: hub_list_boards with another space your owner can open.
