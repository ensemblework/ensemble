# One desk, one app

Every desk uses the same shell. A Chambers account and a Bench account differ by accent and by the words on the tiles. They do not get a different font, a different sidebar, or a different way of moving.

## Mark

The logo is concept B, "Two voices", from `design/icons`. The outer strand is the agent and the inner strand is you. It is the sidebar mark (`components/mark.tsx`), the login mark, and `app/icon.svg` (the favicon and the app icon). The constellation on the login panel is decoration behind the form, not a second logo.

Native `.ico` and `.icns` files live under `design/icons` for a later shell. This web app does not branch on Windows, macOS, or Linux.

## Type, colour, space

- Text is Figtree. Display lines are Fraunces. Code and times are JetBrains Mono. These are the faces already loaded in `app/layout.tsx`.
- Colour comes from the theme tokens in `app/globals.css` (`--bg`, `--ink`, `--accent`, `--tile`, `--line`). A desk may set `--accent` only. Do not invent a per-desk palette or rename tokens back to the mockup's `--a`.
- Tiles use `--radius-tile` (14px), `--row` (72px), and the same skeleton sweep as the rest of the app.
- Light and dark are the settings theme. The same components have to read in both.

## Motion

Curves and durations are the expressive set from `design/motion` (`--m-ease-enter`, `--m-ease-loop`, `--m-dur-ui`, and the rest, declared next to the older `--ease` tokens). Desk tiles rise with those tokens. Reduced motion, from the OS or from Settings, cuts the rise to a short fade and stops loops. Do not add a second motion system inside a desk.

## Features

A module that is off stays on its URL, with a blurred preview and an Enable button. Turning it off hides the tab and leaves the saved work. Desk extras (deadlines, learning, the bench card) follow the same rule and can be switched on from any desk.
