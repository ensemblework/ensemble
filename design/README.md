# Ensemble design

The current shipping identity is **Woven Chorus / Satin Gold**. Its source and motion controller live in [`packages/brand`](../packages/brand); see [`docs/BRAND.md`](../docs/BRAND.md). Use `pnpm brand:build` to export assets and `pnpm brand:check` to detect drift.

`brand/index.html` is the current, self-contained gallery, generated from the shipping controller. The `icons/` exploration sheets and `motion/round*` folders retain historical design studies. They are not imported by the apps and are not the current brand specification. The `icons/app-icon/png/recommended/` exports and `icons/ui-icons/svg/ensemble.svg` are regenerated from the current shared source. Do not run historical generators to replace shipping assets.
