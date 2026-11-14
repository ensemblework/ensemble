# Ensemble diagrams: cheat sheet

Create a diagram by describing its nodes and connections. Write one statement per line, put labels in quotes and use IDs to connect nodes. Start with this login flow, then replace the labels and IDs with your own.

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

## Statement reference

Use these statements to control the diagram’s direction, shapes, connections and labels.

```text
title NAME
direction down|up|left|right
curve straight|curved|elbow

node ID "Label" shape SHAPE [color COLOR] [locked] [font PX] [bold] [italic] [underline]
edge ID > ID [: "label"] [curve straight|curved|elbow] [width PX] [head PX] [bend PX] [font PX] [bold]
edge ID --> ID [: "label"]     dashed arrow
edge ID -- ID                  line, no arrow
edge ID .. ID                  dashed line
edge ID <> ID                  arrows both ends
edge ID < ID                   arrow into the first id
edge FROM.e > TO.w             ports: n ne e se s sw w nw

group ID "Label" {
  node ...
}

text ID "Words you can drag" [font PX] [bold] [italic] [underline]

layout
  ID x y width height [locked]
```

## Choose shapes and connections

Shapes: `rectangle` `rounded` `diamond` `circle` `ellipse` `cylinder` `server` `triangle` `parallelogram` `document` `cloud` `actor` `hexagon` `note` `trapezoid` `queue` `subroutine` `browser` `delay`.

Useful aliases: `db` = cylinder, `decision` = diamond, `doc` = document, `person` = actor, `io` = parallelogram, `box` = rectangle, `kafka` = queue, `web` = browser, `wait` = delay.

Two blocks have one line between them. A second line between the same two blocks is merged into the first (a reversed one makes it two-way, `<>`). Text sizes are 8–48 px; line `width` 0.5–8, `head` 6–40.

Declare blocks before connecting them. A name used only on an arrow becomes a rectangle. An unknown shape also becomes a rectangle. The parser skips a bad line, but keeps a line with a missing `)` or `:` and warns you.

A text that starts with `flowchart` or `graph` is read as Mermaid and then saved as the statements above.

## Arrange and style the diagram

Leave `layout` out when writing a new diagram. The editor fills it in when someone moves a block or presses Reorganize. Reorganize lays each group out as its own frame, clear of the others. `locked` keeps that position on Reorganize, Fit vertically, and Fit horizontally.

`curve` defaults to `straight`. Set it once for the diagram, and again on a line only when that line should differ. `elbow` turns at right angles. Fit vertically writes `direction down`. Fit horizontally writes `direction right`.

Leave `color` off for the shape's own soft fill (blue for a step, amber for a decision, green for a start, teal for a database, and so on). `color red` or `color "#336699"` overrides it. The same name is lighter on a light canvas and deeper on a dark one.

Read the [full language reference](21_BLOCK_DIAGRAMS_DSL.md) for more rules and examples.

## In the code

The full language reference is `docs/21_BLOCK_DIAGRAMS_DSL.md`.
