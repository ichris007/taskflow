# Contributing to TaskFlow

Thanks for contributing! This document describes the quality bar a pull request must meet before it can be merged. Following these rules up front saves review rounds for everyone.

## Getting started

```bash
npm install
npm run dev      # esbuild watch mode for local development
```

## Definition of Done

A PR is merge-ready only when **all** of the following hold:

- [ ] `npm run build` completes with **zero TypeScript errors** (`tsc -noEmit -skipLibCheck`).
- [ ] `npm run lint` reports no errors.
- [ ] New or changed UI ships with matching CSS. Styles must use the `--tf-*` design tokens (see `DESIGN-cal.md`); do **not** hardcode colors, radii, or spacing — use the tokens so light/dark themes stay consistent.
- [ ] Any user-facing string is added to **both** the ZH and EN tables in `src/i18n.ts`. A key missing from either table falls back to the key itself. The CI i18n check (`npm run check:i18n`) fails the build automatically if the two tables diverge.
- [ ] No obvious performance regression — e.g. do not re-scan the whole vault on every render; cache results and invalidate them on metadata change instead.
- [ ] The PR description explains the **purpose** and includes a **usage example** (this is especially important for anything touching Tasks queries).

## Review process

1. A contributor opens a PR against `main`.
2. A maintainer reviews it. If changes are needed, they submit a **Request changes** review with a concrete checklist (see template below) — this blocks the Merge button until addressed.
3. The contributor pushes fixes and requests re-review.
4. Merge happens only after **CI is green AND a maintainer approves**.

> `main` is protected: it requires passing status checks and at least one approving review, so a red CI or an unresolved review blocks merging automatically.

## Review checklist template (maintainer)

Paste this into a **Request changes** review when a PR is not yet ready:

```
Request changes — please address the following before merge:
- [ ] Build passes with zero TypeScript errors (run `npm run build` locally).
- [ ] Lint passes (`npm run lint`).
- [ ] New UI has matching CSS using the `--tf-*` tokens.
- [ ] i18n ZH + EN tables both updated for every new user-facing string.
- [ ] No performance regression (no full-vault scan per render).
- [ ] PR description includes purpose + a usage example.
```

## Notes for maintainers

- **The `tsc` squatting package is NOT in this repo.** The real TypeScript compiler is the `typescript` devDependency, and `npm run build` / the bare `tsc` command work correctly. A Pull Request *could* accidentally add the dummy `tsc` package (`npmjs.com/package/tsc`), which would shadow the real compiler on the PATH — if you see it in a PR, reject that dependency. As a safety net, CI calls the real binary directly (`node node_modules/typescript/bin/tsc`) so the type-check stays meaningful even if such a bad dependency slips through.
- **Keep Node versions aligned.** CI builds on Node 22 to match the version used for local development and releases. If you change the local toolchain, update `node-version` in `.github/workflows/ci.yml` to match, so "works locally" equals "passes CI".
- **i18n keys must stay symmetric.** `src/i18n.ts` has separate ZH and EN tables; a key present in one but missing in the other silently falls back to the raw key at runtime. This is now enforced automatically — `npm run check:i18n` runs in CI and fails the build if the ZH and EN key sets diverge, so missing translations are caught without manual review. Run it locally (`npm run check:i18n`) before pushing a PR that touches strings.
- Prefer small, focused PRs over large ones — they are easier to review and to gate with the checklist above.

## Releasing

Merging a PR to `main` does **not** publish anything. To ship a new version to the Obsidian Community Plugins directory:

1. Decide the bump (patch / minor / major) based on the change.
2. Run `npm run version` — it updates `manifest.json` and `versions.json` (and stages them). Make sure `manifest.json`'s `version` matches the bump.
3. Commit the version bump.
4. Draft a GitHub Release tagged with the new version.
5. Attach the three required files to the release:
   - `main.js`
   - `manifest.json`
   - `styles.css`

Only the files attached to a GitHub Release are picked up by the community plugin update mechanism, so re-bundle `main.js` via `npm run build` and upload it on every release.
