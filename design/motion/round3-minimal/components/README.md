# Minimal motion components (round 3)

Each folder is one **slot**. `<slot>.html` holds the Quiet markup, then `<!--dot-->`, then the Dot markup. `<slot>.js` registers both flavours with `UM.register(theme, slot, impl)`.

Load order: `core/tokens.css`, `core/suite.css`, `core/minimal.css`, then the slot css. Scripts: `core/u2-core.js`, `core/motion.js`, then the slot js.

Mount: put the markup inside `<div data-motion-theme="minimal-quiet" data-motion-slot="agent.thinking">` and call `UM.mount(el)`. It returns a scene; call `.dispose()` to stop it.

Everything reads the `--m-*` tokens. See `../SUITE.md` for the contract, and `core/motion-themes.json` for the native values.
