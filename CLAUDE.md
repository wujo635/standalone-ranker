# standalone-ranker

## Branch discipline

Before starting any feature work, bug fix, or refactor, check the current git branch (`git branch --show-current`). If it's `main`, create and switch to a new feature branch first — never commit work-in-progress directly to `main`. This applies even if the user's request doesn't mention branching explicitly.

## Keeping ARCHITECTURE.md and CHANGELOG.md in sync

Whenever you change `index.html` in a way that affects behavior (new feature, bug fix, UI change, data shape change), update both docs in the same commit/PR:

1. Bump `APP_VERSION` per the semver rule documented next to it in the script (major/minor/patch), and if `state`'s shape changed, bump `DATA_SCHEMA_VERSION` too and add a migration block in `migrateData()`.
2. Update the "Current versions" table at the top of `ARCHITECTURE.md`.
3. Add a row to the "App version" (and "Data schema version" if applicable) table in `CHANGELOG.md` describing the change — not `ARCHITECTURE.md`, which only holds the current-state tables now.
4. If the change affects documented functions, data model, tab views, or design decisions sections in `ARCHITECTURE.md`, update those too — don't just append to the changelog.

Skip this only for changes that don't touch `index.html` behavior (e.g. editing these docs, `.claude/` config).
