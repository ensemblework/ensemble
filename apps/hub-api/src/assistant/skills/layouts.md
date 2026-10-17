---
name: layouts
title: Tiles and the current workspace
when: add, remove, move, resize or configure tiles/widgets on Today, Board and Context; what is on this screen
tools: hub_read_surface, hub_read_layout, hub_edit_layout, hub_list_projects
match: \b(tiles?|widgets?|dashboard|layout|resize|rearrange|this screen|this view|open surface)\b
---
Read the current surface with hub_read_surface. For tiles, hub_read_layout surface today, board or context returns document, version and available tile types.
Then hub_edit_layout with the same surface/version and edits. add needs type and optionally size/config/index. update changes size/config; move uses a zero-based index; remove names the tile. Preserve every unrequested tile. The read result identifies the actual view. Profile desks use c (3–12 columns) and r (2–8 rows); Board overview uses its own types and holds at most four fixed-size tiles. Context uses the active tab. Only the alternate widgets view has size s/m/l/xl, slots and per-tile filters. Use view widgets only when editing that alternate view. Read again if the version changed. Entries inside a tile are hub_add_desk_item/hub_update_desk_item, tasks or reminders, not new tile placements.
