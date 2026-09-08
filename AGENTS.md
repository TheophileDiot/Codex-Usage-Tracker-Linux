# Repository Guidelines

## Project Structure & Module Organization

This GNOME Shell extension uses JavaScript ES modules through GJS. Supported versions and runtime evidence are recorded in `metadata.json` and `docs/VALIDATION.md`. Root modules divide responsibilities: `extension.js` renders the panel and popup; `prefs.js` builds Libadwaita preferences; `app-server.js` handles Codex subprocess transport; `monitor.js` coordinates refreshes; `usage.js`, `history.js`, and `files.js` handle normalization, history, and storage; `statusline.js` manages native footer settings.

Keep GSettings XML in `schemas/`, assertions and Python fixtures in `tests/`, and screenshots in `docs/images/`. UI assets include `stylesheet.css` and `codex-usage-symbolic.svg`. Read `PRODUCT.md`, `DESIGN.md`, and `docs/VALIDATION.md` before changing behavior or presentation.

## Build, Test, and Development Commands

Install GJS, Libadwaita, GLib schema tools, and GNOME extension utilities. The documented Codex CLI minimum is 0.153.4.

- `rtk make test`: run offline GJS assertions and strict schema validation.
- `rtk make pack`: run tests and create the extension ZIP in `dist/`.
- `rtk gjs -m tests/test-usage.js`: run normalization checks alone.

Additional Makefile targets include `test-native` for real Codex configuration checks using a temporary home, `test-prefs` for preferences under Xvfb, and `test-shell` for a packaged extension in a private headless GNOME session. Desktop tests need display and D-Bus sockets. Follow README installation instructions for interactive development.

## Coding Style & Naming Conventions

Match existing JavaScript: four-space indentation, single-quoted strings, semicolons, camelCase functions, PascalCase classes, and uppercase constants. Use lowercase module filenames and `.cum-*` CSS classes. Reuse GJS/Gio/GLib helpers. No formatter or linter configuration exists; preserve surrounding style.

## Testing Guidelines

Use standalone assertions in `tests/test-<module>.js`; Python scripts provide fixtures and desktop orchestration. No numeric coverage threshold exists. Add focused regression checks for changed behavior, especially missing versus zero values, cancellation, account changes, and configuration recovery. Run relevant optional targets for transport, preferences, or shell changes; report skipped checks.

## Commit & Pull Request Guidelines

History currently contains one commit: `feat(gnome): add Codex usage monitor`. Follow that scoped, imperative message pattern. PRs should describe behavior changes, link relevant issues, list checks and limitations, and include synthetic-data screenshots for UI changes.

## Security & Agent Boundaries

Preserve unavailable values; never infer billing amounts. Keep credentials and prompt content out of logs and fixtures. Require explicit Apply/Restore actions for configuration writes. Agents must prefix shell commands with `rtk`, preserve unrelated changes, never create commits, and obtain explicit authorization for external actions.
