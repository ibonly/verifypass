# Codebase cleanup analysis — 2026-09-05

Moved **177 files (415,949,496 bytes; 396.68 MiB)** into `delete/`, preserving their original relative paths. No application source files were removed. Files remain available for manual deletion or restoration. Moving files does not reclaim disk space until you delete them.

## Scope and method

- Inventoried tracked and untracked files, including hidden configuration and ignored build output. Excluded dependency internals, Git internals, credentials and stored verification evidence from cleanup candidates. The initial Git working tree was clean; no AGENTS.md was found in the project/parent search.
- Inspected all package manifests, npm scripts, CI/deployment workflows, Vite configs and application entrypoints.
- Scanned static relative imports/requires across 160 JavaScript/JSX source, test and configuration files, excluding generated bundles. Manually classified modules with no inbound relative imports against package exports, HTML entries and command-line entrypoints.
- Searched active source, scripts and workflows for references to proposed cleanup paths. Compared duplicate contents using SHA-256. Checked model lookup paths and the installed Tesseract cache behavior.
- Moved only confirmed generated leftovers, an existing old-build archive, an empty placeholder and an exact document duplicate. Verified every moved file against its pre-move SHA-256.

## Moved files

| Category | Files | Bytes | Evidence |
| --- | ---: | ---: | --- |
| Old frontend build archive | 146 | 415,803,529 | `frontend/_to_delete_verify_page_dist_prev/`: archived dashboard, sample and hosted-page builds. Active deploy workflows use the current app `dist/` directories; no active references to this archive found. |
| Vite temporary configs | 29 | 137,539 | 29 timestamped bundles: dashboard 2, verify-page 12, sample-app 15. Generated wrappers contain former session paths; real `vite.config.js` files remain. |
| Empty test placeholder | 1 | 0 | `backend/tests/_unused`: zero bytes, no references, not matched by `tests/*.test.js`. |
| Duplicate implementation document | 1 | 8,428 | `Claude outputs/LIVENESS_IMPLEMENTATION_v7.md`: exact duplicate of the root document, which remains. |

The complete per-file list, original locations, quarantine locations, sizes, reasons and SHA-256 hashes are in [delete/manifest.json](delete/manifest.json).

## Preserved files and reasons

| Files / area | Why retained |
| --- | --- |
| Backend routes, services, middleware, workers, providers and shared code | Static references connect modules to application code, tests or public exports. No clear whole-file source removal candidate was established. |
| `backend/app.js`, Lambda entries, server/worker entries | Separate supported runtime entrypoints. An entrypoint need not have a normal inbound import. |
| Backend maintenance scripts and root scripts | Seed/user creation, queueing, calibration, model downloads and local startup remain operational tools. `setup-inhouse.js` is imported by `start-all.js`. |
| SDK core/react/js packages | Public package APIs and standalone bundle entrypoint; lack of a local consumer does not prove an exported API is unused. |
| Identical dashboard/verify-page `src/main.jsx` files | Each is an independent HTML application entrypoint and resolves its own local App component. |
| Backend ONNX models and both frontend public model directories | Runtime provider and browser model paths require these assets. Identical model bytes are intentional copies for independently deployed applications. |
| `backend/eng.traineddata` | Used implicitly by Tesseract’s English language cache in the working directory. Removing it can force a network download or disrupt offline OCR. |
| Current `dist/` directories | Active build/preview/deployment output. All four were successfully rebuilt during validation. |
| `node_modules/`, package manifests and lockfiles | Installed tooling/runtime dependencies and folder-local reproducibility. Dependencies were not pruned. |
| Root code reviews, roadmap, v1–v7 analysis documents and screenshots | Historical findings and evidence have independent value; some documents reference earlier versions. Age or absence of code imports does not establish obsolescence. Only the exact duplicate was moved. |
| Environment examples, local credentials and evidence stores | Setup references or runtime data. Local secrets and verification evidence were not opened or moved. The frontend-level environment example merits later documentation review, but was not proven disposable. |

## Validation

- `npm test`: **420 passed, 0 failed, 0 skipped** — backend 230, shared 87, SDK core 103.
- The first sandboxed test run could not open temporary HTTP sockets (`listen EPERM`). The full suite passed after rerunning with local socket access.
- `npm run build`: passed for SDK JS, dashboard, hosted verification page and sample app.
- `git diff --check`: passed.
- All 177 quarantined files verified with SHA-256 after moving.
- Added `/delete/` and generated Vite timestamp bundles to `.gitignore`. Git shows tracked originals as deletions because their preserved quarantine copies are intentionally ignored. No commit or deployment was performed.

## Manual deletion or restoration

Inspect `delete/manifest.json`, then delete the project’s `delete/` directory manually when ready. The report remains outside the quarantine. To restore an individual file, move it from `delete/<original-relative-path>` back to `<original-relative-path>`, creating parent directories as needed. Check whether the destination already exists before restoring; do not overwrite newer work.

## Limits and follow-up findings

Static import analysis does not prove every export or branch is exercised, and tests/builds do not validate live camera capture, OCR inference, database access or production deployment. No claim is made that every remaining function or dependency is used. Public APIs and dynamic/configuration-driven resources were retained where absence of references was insufficient evidence.

Documentation contains older layout references worth correcting separately: `.gitignore` still lists legacy `apps/` paths, `backend/src/env.js` comments mention a root environment file/workspace command despite loading `backend/.env`, and the frontend deployment workflow comments reference a missing `deploy/cpanel.md`. These are documentation/configuration maintenance candidates, not evidence that their containing files should be removed.
