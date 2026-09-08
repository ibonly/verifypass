# Production Cleanup Analysis - 7 September 2026

## Outcome

Permanently deleted **178 files totaling 415,951,127 bytes (396.68 MiB)**,
plus the four empty directories in the unused `email/` scaffold. The files are
177 previously quarantined artifacts and one unreferenced backend service.
No credentials, private biometric exports, stored evidence, required models,
installed dependencies, lockfiles, tests, or active deployment outputs were deleted.
The working tree was clean before this pass. No commit or deployment was made.

## Analysis Method

- Inventoried 303 files outside Git internals, dependency internals, the old
  quarantine, and private evidence directories. Of these, 287 were outside
  current `dist/` outputs. Counts describe the pre-cleanup inventory, not private data.
- Inspected all nine package manifests, the four GitHub workflows, both backend
  Dockerfiles, Vite configurations, and package/build/runtime entrypoints.
- Scanned 197 JavaScript/JSX/CJS/MJS files for static imports and requires. Reviewed
  files with no inbound static references against test globs, CLI commands,
  package entrypoints, HTML entries, dynamic loading, and documentation.
- Rechecked the 196 remaining scripts with Node module resolution: no unresolved
  relative imports. Static string extraction is a heuristic, not whole-program
  reachability proof; snippets and dynamic references require manual judgment.
- Compared non-secret, non-private files with SHA-256 to identify exact duplicates.
  Inspected external-package consumers and kept build tools, optional providers,
  peer dependencies, and independently deployed package dependencies.
- Verified every old quarantine entry's path, regular-file status, byte size, and
  SHA-256 before deleting any of the 177 entries. Preserved the local manifest.
- Did not run audit exporters, deletion/retention jobs, or database migrations.
  Credential contents and private biometric data were not inspected for cleanup.

## Deleted Files

| Category | Files | Bytes | Evidence for removal |
| --- | ---: | ---: | --- |
| Old frontend build archive | 146 | 415,803,529 | Previously reviewed obsolete archive; all hashes matched. Current workflows build and publish current app `dist/` directories. |
| Old Vite temporary configs | 29 | 137,539 | Generated timestamped wrappers in quarantine; original Vite configs retained. |
| Empty test placeholder | 1 | 0 | Previously quarantined `_unused`; not a test entrypoint. |
| Exact duplicate implementation report | 1 | 8,428 | Quarantined copy; original root report retained. |
| Unreferenced tenant-status service | 1 | 1,631 | No import, invocation, test, package export, CLI entrypoint, or runtime registration. Only the requirements document claimed it was wired. |

The last entry was `backend/src/services/tenantStatusService.js`. Removing it
does not remove an active route: the module had no callers. The workspace-status
email helper and PHP template remain. [Email requirements](docs/EMAIL_REQUIREMENTS.md)
now accurately state that this event has no application trigger.

The four removed empty scaffold directories were `email/bin`, `email/public`,
`email/src`, and their parent `email`. The active [email API](email-api/README.md)
is separate and remains intact. Empty-directory removal used `rmdir`, which
refuses to delete directory contents.

The historical per-file archive hashes remain in local `delete/manifest.json`.
That manifest is ignored by Git; the archived contents are no longer available
there. The deleted tracked service is recoverable from Git history.

## Retained Candidates

| Area | Reason retained |
| --- | --- |
| Backend API/server/worker/Lambda entries | Independently invoked runtime entrypoints; lack of ordinary imports does not make them dead code. |
| Backend routes, shared engine, services and providers | Remaining modules have reference paths; optional providers are configuration-driven. |
| Tests and helpers | Exercised by package test globs and regression suites; excluded from backend Docker context, not deleted from source. |
| Maintenance and release scripts | User creation, tenant seeding, queueing, model download, calibration, evaluation and replay are operational entrypoints. |
| SDK package exports | Public interfaces can have consumers outside this repository. |
| Sample app | Has its own build and deployment workflow and consumes the SDK; it is not an unused sample directory. |
| Audit reproduction/export/analysis scripts | Explicitly referenced by audit reports; snapshot-specific assertions preserve historical meaning. They are not current release acceptance tests. |
| Historical reports and screenshots | Independent audit evidence; age or absence of imports is not evidence of disposability. |
| Duplicate ONNX model copies | Backend, hosted page and sample app deploy separately and reference their own model paths. |
| Duplicate model manifests | Server model integrity and browser cache integrity use separate manifests in separate packages. |
| Identical dashboard/hosted-page bootstrap files | Each is an HTML entrypoint resolving a different local App component. |
| English OCR trained data | Tesseract's working-directory cache supports local/offline OCR; deleting it may force network downloads. |
| Current build outputs | Regenerated successfully for all four builds and used by deployment/preview workflows. |
| Dependencies, lockfiles, environment examples | Required for installation, tooling and configuration; no dependency was proven disposable. |
| Credentials and private evidence | Runtime/private data is outside code cleanup scope. |

## Packaging Changes

Added [backend/.dockerignore](backend/.dockerignore) because both image recipes
use `COPY .`. The context now excludes local dependencies, environment files,
credentials, worker PID state, evidence directories, coverage/build outputs,
logs, partial downloads, and backend/shared tests. Runtime source, Prisma schema,
model manifests, ONNX models, OCR data, and supported entrypoints remain included.

Updated [.gitignore](.gitignore) to remove obsolete `apps/` entries and explicitly
ignore current worker PID state, partial model downloads, and private audit
exports. Existing local data was left untouched. These exclusions do not remove
files already present in Git history or previously built container images.

## Verification

| Check | Result |
| --- | --- |
| Backend tests | 303 passed |
| Shared tests | 100 passed |
| SDK core tests | 108 passed |
| Dashboard tests | 2 passed |
| Total `npm test` | 513 passed, no failures or skips |
| `npm run test:email` | 21 PHP templates, 8 PHP security groups, 11 Node tests passed; Node email tests also appear in the backend count |
| `VP_SECRET_KEY= npm run build` | Prisma validation/generation and SDK JS, dashboard, hosted page, sample app builds passed |
| Generated-schema startup assertion | Passed |
| Remaining static relative imports | All resolved |
| Archive removal | All 177 manifest entries absent; only the manifest remains |
| Ignore-rule checks | Current PID, partial-download, environment and private-audit paths ignored |
| Docker packaging | Exclusion patterns and required file presence checked; actual image build not run because Docker is unavailable |

## Release Caveats

- Removing a file from backend `src/` changes the source digest computed by
  [release.js](backend/src/lib/release.js). Generate new production liveness
  validation receipts for the cleaned release; do not reuse receipts from the
  previous digest. Existing runtime release gates were not weakened.
- Workspace-status notification still needs an actual business-event trigger.
  Cleanup corrected a misleading integration claim; it did not implement a new
  tenant lifecycle workflow.
- Tests use local/synthetic fixtures. They do not validate live database access,
  deployed Docker behavior, camera/device capture, biometric accuracy, SMTP
  delivery, or production DNS. No production-release certification is claimed.
- Static analysis cannot prove every export or dynamic branch is used. Ambiguous
  files were retained rather than deleting supported behavior or audit history.