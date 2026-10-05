# Ensemble diagrams — cheat sheet

One statement per line. Quote labels. Refer to ids, not to the words inside the quotes.

```udl
title Login flow
direction down

node start "Start" shape circle
node form "Enter login" shape parallelogram
node check "Valid?" shape diamond
node home "Dashboard" shape rounded color green
node db "Users DB" shape cylinder

edge start > form
edge form > check
edge check > home : "yes"
edge form -- db : "lookup"
```

```text
title NAME
direction down|up|left|right
curve straight|curved|elbow

node ID "Label" shape SHAPE [color COLOR] [locked]
edge ID > ID [: "label"] [curve straight|curved|elbow]
edge ID --> ID [: "label"]     dashed arrow
edge ID -- ID                  line, no arrow
edge ID .. ID                  dashed line
edge ID <> ID                  arrows both ends
edge ID < ID                   arrow into the first id
edge FROM.e > TO.w             ports: n ne e se s sw w nw

group ID "Label" {
  node ...
}

text ID "Words you can drag"

layout
  ID x y width height [locked]
```

Shapes: `rectangle` `rounded` `diamond` `circle` `ellipse` `cylinder` `server` `triangle` `parallelogram` `document` `cloud` `actor` `hexagon` `note` `trapezoid`.

Useful aliases: `db` = cylinder, `decision` = diamond, `doc` = document, `person` = actor, `io` = parallelogram, `box` = rectangle.

A bad line is skipped. A missing `)` or `:` is kept, with a warning. An unknown shape becomes a rectangle. A name used only on an arrow becomes a rectangle, so declare blocks first.

A text that starts with `flowchart` or `graph` is read as Mermaid and then saved as the statements above.

Leave `layout` out of anything you write from scratch. The editor fills it in when someone moves a block or presses Reorganize. `locked` keeps that position on Reorganize, Fit vertically, and Fit horizontally.

`curve` defaults to `straight`. Set it once for the diagram, and again on a line only when that line should differ. `elbow` turns at right angles. Fit vertically writes `direction down`. Fit horizontally writes `direction right`.

Leave `color` off for the shape's own soft fill (blue for a step, amber for a decision, green for a start, teal for a database, and so on). `color red` or `color "#336699"` overrides it. The same name is lighter on a light canvas and deeper on a dark one.

Full rules and examples: `docs/21_BLOCK_DIAGRAMS_DSL.md`.
