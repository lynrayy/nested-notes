# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install          # Install dependencies
npm run dev          # Watch mode — compiles src/main.ts → main.js on every change
npm run build        # Type-check then production build (minified, no sourcemap)
npm run lint         # Run ESLint across the project
npm version patch    # Bump patch version in manifest.json, package.json, and versions.json
```

There are no automated tests. Testing is manual: copy `main.js`, `manifest.json`, and `styles.css` into `<Vault>/.obsidian/plugins/nested-notes/`, then reload Obsidian and enable the plugin under **Settings → Community plugins**.

## Architecture

This is an Obsidian community plugin written in TypeScript, bundled by esbuild into a single `main.js` CJS file that Obsidian loads directly.

- **Entry point**: `src/main.ts` — exports the default plugin class extending `Plugin`. Keep this file minimal (lifecycle only: `onload`, `onunload`, `addCommand` calls). Delegate all feature logic to separate modules under `src/`.
- **Build output**: `main.js` at the repo root (not `src/` or `dist/`). This file is committed and shipped as a release artifact alongside `manifest.json` and `styles.css`.
- **External modules**: `obsidian`, `electron`, all `@codemirror/*` and `@lezer/*` packages, and Node built-ins are marked external — they are provided by the Obsidian runtime and must not be bundled.
- **Styles**: `styles.css` at the repo root is loaded by Obsidian automatically.

### Key conventions

- Use `this.registerEvent`, `this.registerDomEvent`, and `this.registerInterval` for all listeners so they are cleaned up on unload automatically.
- Persist settings with `this.loadData()` / `this.saveData()`.
- Command IDs are stable API — never rename after first release.
- `manifest.json` version and `versions.json` must stay in sync; the GitHub release tag must exactly match the version string (no `v` prefix).
- TypeScript is strict (`noImplicitAny`, `strictNullChecks`, etc.) — don't disable checks.
- Target `es2018` / `ES6`; avoid Node/Electron-only APIs if `isDesktopOnly` is `false`.
