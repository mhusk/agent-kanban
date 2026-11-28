# Implementation Plan: `agent-kanban` (v1 / M0–M4 & v1.1 / M5–M10)

> **For Coding Agents:** Read [`AGENTS.md`](../AGENTS.md) before starting. Execute **one unchecked step at a time**, run every command in its **Validation Gate** until all pass, mark it `[x]` in both the tracker below and the step section, and commit directly to `main` (`step(MX.Y): ...`). Stop immediately when the next unchecked step is marked `[HUMAN]`.
>
> **Public Repo Rule:** Never commit secrets, `.env` files, real Firebase project IDs, personal/family names, real emails, personal locations/timezones, or real household data. Use strictly fictional fixtures (`alex@example.test`, `sam@example.test`) and environment-driven configuration everywhere.

Reference specification: [`docs/PRD.md`](PRD.md)

---

## Locked Implementation Decisions

These decisions resolve all implementation details beyond `docs/PRD.md`:

| Area | Locked Decision |
| :--- | :--- |
| **Monorepo & Tooling** | `pnpm` workspaces, TypeScript (strict), ESLint + Prettier, Vitest (unit/API/emulator/rules tests), Playwright (PWA E2E). |
| **Public Repo Privacy** | All personal/deployment values (`FIREBASE_PROJECT_ID`, `HOUSEHOLD_TIMEZONE`, WorkOS config, `WEBHOOK_ENCRYPTION_KEY`, `BACKUP_BUCKET`) live strictly in env vars / Secret Manager / GitHub Secrets. `.firebaserc` is gitignored (`.firebaserc.example` committed instead). Automated `pnpm hygiene:check` runs in CI and supports a gitignored `.hygiene-denylist.local` file for owner-defined personal strings. |
| **Web Frontend (`apps/web`)** | React + Vite + Tailwind CSS + TanStack Query + React Router + `vite-plugin-pwa`. Mobile-first single-column layout (`max-w-xl mx-auto` on desktop) with bottom tab bar (`To-Do`, `Active`, `Done`, `Settings`), sticky search/tag/person filter strip, FAB quick-add, and full Card Detail view. |
| **API & Hosting (`apps/api`)** | Firebase Cloud Functions v2 (Node 22 + Express) bundled with `esbuild`/`tsup` so `@agent-kanban/shared` deploys cleanly. Single-origin Firebase Hosting rewrites route `/api/**`, `/mcp`, and `/.well-known/**` to the API function. |
| **Environments** | Single Firebase production project + local Firebase Emulators (Firestore, Functions, Storage, Hosting) for dev & CI. |
| **Auth & Allowlist** | Household users are pre-created in `users/{userId}` (`email`, `displayName`, `handle`, `role`) via CLI bootstrap/admin endpoint. First WorkOS AuthKit login matches verified email, links `workosUserId`, and rejects unknown emails with `403`. |
| **Offline/CI Auth Testing** | Local RSA test keypair + Dev User Switcher (`AUTH_MODE=emulator`), strictly gated on `FUNCTIONS_EMULATOR=true` or `NODE_ENV=test` and hard-refused at startup in production. Exercises the real JWT verification and allowlist pipeline offline. |
| **Card Visibility & Sharing** | Both `assignedUserIds` and `awareUserIds` grant full read/write on the card. Denormalize `visibleToUserIds = unique([...assignedUserIds, ...awareUserIds])` on cards, activity, and events. New cards default to `assignedUserIds=[creator]` with a UI "Share with household" toggle (**default ON**) adding all other household users to `awareUserIds`. |
| **Checklists & Deletion** | Checklists are embedded directly on `cards/{cardId}` (`checklists[]`). Cards are soft-archived (`archived: true`), not hard-deleted. |
| **Timezone & Recurrence** | Default timezone is configured via `HOUSEHOLD_TIMEZONE` env var (defaults to `'UTC'` in code; any valid IANA timezone supported, DST-aware). Support two recurrence rule types: `cron` (5-field cron) and `interval_after_completion` (`{ every, unit: 'days' | 'weeks' | 'months' }`). On completion (`POST /api/cards/:id/complete`): log `card.completed`, uncheck all checklist items, advance `due`, reset `status` to `todo`, clear `priorityScore` & `priorityReason` to `null`, and reset `dueSoonNotifiedAt`/`overdueNotifiedAt`. |
| **MCP Server** | Stateless Streamable HTTP endpoint mounted at `/mcp` via `@modelcontextprotocol/sdk`, exposing RFC 9728 metadata at `/.well-known/oauth-protected-resource` for WorkOS AuthKit OAuth 2.1, plus API-key fallback on the same endpoint. Wraps shared handler functions used by REST. |
| **Webhook Secrets & Retries** | Envelope-encrypt each subscription secret with AES-256-GCM using one master `WEBHOOK_ENCRYPTION_KEY` (Secret Manager in prod, `.env.local` in emulator). Deliver via Firestore `onDocumentCreated('events/{eventId}')` trigger with Firestore-backed exponential backoff retries (`1m, 5m, 15m, 60m`, max 5 attempts) swept by a scheduled function—100% testable in local emulators. |

### Locked v1.1 Implementation Decisions

| Area | Locked Decision |
| :--- | :--- |
| **Shared Tag Vocabulary & Normalization** | Normalize tags with `normalizeTag` / `normalizeTags` (trim + lowercase + dedupe) on all write inputs (`CreateCardInputSchema`, `UpdateCardInputSchema`, `BulkCardUpdateItemSchema`, `SubscriptionFiltersSchema`) while keeping case-insensitive filter and webhook `filters.tags[]` matching for pre-v1.1 cards. Derive `GET /api/tags` dynamically from visible cards (frequency-sorted), expose MCP `list_tags` + `tags[]` in `workspaceSnapshot`, provide a reusable `TagPicker` autocomplete across Quick-Add / Card Detail / bulk bar / `l` popover, and add a Settings Tag Manager (`POST /api/tags/rename`) to rename, merge, or delete tags across visible cards. |
| **Unified Snooze (`deferUntil`) & Recurring Auto-Defer** | Add `deferUntil: IsoDateTimeSchema.nullable().default(null)` and `lastCompletedAt: IsoDateTimeSchema.nullable().default(null)` on `CardSchema`, plus optional `autoDefer?: boolean` (default `true`) and `leadDays?: number` (`0..365`) on `RecurrenceSchema`. On recurring card completion (`autoDefer !== false`), compute `deferUntil` from explicit `leadDays` or a smart cadence default (`0` days for daily / `< 7` days, `1` day before for weekly / `7–13` days, `3` days before for monthly / `>= 14` days; omitted if wake-up time `<= completedAt`). Default `To-Do` hides cards with `deferUntil > now`; `workspaceSnapshot` separates `deferredCards[]` from active `cards[]`; the 15-minute `dueScanner` cron clears elapsed `deferUntil` values and emits `card.unsnoozed` so BYOA agents score cards right as they resurface. |
| **Schedule View (5th Tab)** | Add a 5th bottom nav tab `Schedule` (`/schedule`, `grid-cols-5`) with two modes: **Upcoming** timeline (grouped into *Due / Active Now*, *Next 7 Days*, *Next 30 Days*, and *Later*, showing snoozed cards and projected recurring occurrences via shared `projectNextOccurrences`) and **All Recurring** master list (human-readable cadence, next due, wake-up date, `lastCompletedAt`, and quick Complete / Wake Now / Edit actions). |
| **Human Priority Nudges (BYOA-Respecting)** | Add `pinned: z.boolean().default(false)` on `CardSchema` (no manual numeric `priorityScore` editing). Pinned cards sort above AI-scored cards in `To-Do`, survive nightly `bulk_update_priorities` passes (agents see `pinned: true` in `workspaceSnapshot`), and auto-clear (`pinned: false`) on completion or archive. Add `POST /api/cards/:id/rescore` (and bulk rescore) which clears `priorityScore`/`priorityReason` and emits `card.rescore_requested` to wake subscribed agents on demand. |
| **Multi-Select & Bulk Webhook Storm Protection** | Extend `PATCH /api/cards/bulk` with `assignedUserIds`, `addAssignedUserIds`, `removeAssignedUserIds`, `awareUserIds`, `addAwareUserIds`, `removeAwareUserIds`, `deferUntil`, `pinned`, and `rescoreRequested`, and reject `status: 'done'` on recurring cards in favor of recurring-safe `POST /api/cards/bulk/complete`. Make `EventSchema.cardId` nullable and emit one visibility-grouped `cards.bulk_updated` batch event per distinct `visibleToUserIds` set instead of `N` per-card `card.updated` events (zero private-card leakage, zero webhook storms, consolidated wake-up for bulk rescore). UI supports desktop hover checkboxes + `x` / `Shift+Click` / `Cmd+A` / `Esc`, mobile header `Select` toggle, and a sticky Bulk Action Bar. |
| **Trello-Inspired Desktop Shortcuts, Quick Popovers & `Cmd+K` Palette** | Keep the focused `max-w-xl` single-column layout in List mode. Single-key shortcuts work across multi-selection -> focused/hovered list row (`j`/`k` cursor or hover) -> open Card Detail (saving immediately without scrolling to Details): `j`/`k` (or `↓`/`↑`) move focus, `x` select, `Enter`/`o` open, `Esc` close/clear/back, `n` new card, `/` focus search, `Cmd+K`/`Ctrl+K` command palette, `?` shortcuts cheatsheet, `g` then `t`/`a`/`r`/`d`/`s` navigate to To-Do / Active / Schedule / Done / Settings, `c` archive/unarchive (with Undo toast), `m` members/assign popover, `Space` toggle assign-to-me, `l` labels/tags popover, `d` due date popover with quick presets, `s` status popover, `h` snooze (`deferUntil`) popover with presets, `p` pin/unpin toggle, `r` request AI rescore, `Shift+Enter` (or `v`) complete/reset (with Undo toast). Shortcuts automatically ignore events inside inputs, textareas, selects, contenteditables, and open modals. |
| **Desktop Kanban Board (`>= 1024px`)** | Desktop-only horizontally scrollable Kanban board (`overflow-x-auto`, `w-80` fixed-width independently scrollable columns) toggled via a **Board \| List** switcher in the desktop header (hotkey `b`, persisted in `localStorage`), defaulting to **Board** at `>= 1024px` while `< 1024px` stays strictly on the single-column mobile tabs with the toggle hidden. Columns: **To-Do** (crisp visual divider after Pinned + Top 5, collapsible rest), **Doing**, **Blocked**, **Done** (recent non-archived + archived toggle), plus an optional toggleable **Snoozed** column. Supports cross-column drag-and-drop only (multi-select aware; dropping onto `Done` invokes recurring-safe `complete`/`bulk/complete`; dragging out of `Snoozed` wakes the card; dropping onto `Snoozed` opens Snooze presets; no fake within-column vertical reordering), Trello-style inline `+ Add a card` composer at the bottom of `To-Do`/`Doing`/`Blocked` (Enter creates with "Share with household" ON + active tag filter, plus `"More options…"` -> `QuickAddModal`), slide-over Card Detail drawer over the live board via React Router `backgroundLocation` state (`Esc` closes preserving scroll/filters; direct URL/reload renders full `/cards/:id`), and 2D keyboard navigation (`ArrowLeft`/`ArrowRight` across columns so `h`/`l` never conflict, `j`/`k`/`ArrowDown`/`ArrowUp` within columns, `Shift+ArrowLeft`/`Shift+ArrowRight` or `[` / `]` to move cards across adjacent columns). |

---

## Master Progress Tracker

### Milestone 0: Monorepo, Tooling, Emulators, Auth & CI/CD
- [x] **M0.1** — Monorepo workspace, TypeScript, lint/format, privacy hygiene check & package skeleton
- [x] **M0.2** — Shared Zod schemas & domain types (`packages/shared`)
- [x] **M0.3** — Firebase config, locked Firestore/Storage rules, indexes & Emulator tests
- [x] **M0.4** — Express Cloud Function bootstrap, bundler & health smoke test
- [x] **M0.5** — Auth middleware (WorkOS JWKS + emulator RSA keypair), allowlist & seed script
- [x] **M0.6** — Minimal PWA shell, Hosting rewrites, AuthKit client & Dev User Switcher
- [x] **M0.7** — GitHub Actions CI & CD workflows + local `ci:verify` script
- [x] **M0.8 `[HUMAN]`** — Provision Firebase project, WorkOS AuthKit, secrets & prod deploy

### Milestone 1: Core Card API & Minimal Mobile PWA
- [x] **M1.1** — Shared helpers: search tokenizer, `@mention` parser, DST-aware due & recurrence engine
- [x] **M1.2** — Core Card CRUD, visibility, status transitions, idempotency, `ifUpdatedAt` & activity log
- [x] **M1.3** — Checklists CRUD/toggle, link attachments & full-text token search
- [x] **M1.4** — Comments with `@mentions` & in-place recurring card resets
- [x] **M1.5** — PWA views: Bottom nav, `To-Do` (Top 5 + collapsible), `Active`, `Done`, search & filters
- [x] **M1.6** — PWA Quick-Add (FAB + household sharing default) & full Card Detail view

### Milestone 2: Agent Connections & Prioritization API
- [x] **M2.1** — User-owned Agent Connections, hashed API keys (`ak_...`) & `X-Agent-Name` attribution
- [x] **M2.2** — Bulk priority/field updates, smart queries & workspace snapshot
- [x] **M2.3** — PWA Settings: Agent Connection / API Key management & household roster

### Milestone 3: MCP Server, Filtered Webhooks & Scheduled Jobs
- [x] **M3.1** — Shared handler layer, Stateless Streamable HTTP `/mcp` & RFC 9728 OAuth metadata
- [x] **M3.2** — Event pipeline, agent loop suppression & 30-day polling fallback (`GET /api/events`)
- [x] **M3.3** — Filtered webhook subscriptions, AES-GCM encryption, `Bearer`/`HMAC` delivery & retries
- [x] **M3.4** — Scheduled jobs (`due_soon`/`overdue`, 30-day auto-archive, cleanup, backup) & Settings webhooks view

### Milestone 4: File Uploads, PWA Polish & Production Readiness
- [x] **M4.1** — GCS signed-URL attachment API (upload/confirm/download/delete, 10 MB + MIME checks)
- [x] **M4.2** — PWA client-side image compression, photo/PDF upload & attachment gallery
- [x] **M4.3** — PWA installability, icons/manifest, offline banner, optimistic UX & accessibility polish
- [x] **M4.4** — Public `README.md`, self-hosting guide, prod smoke script & full regression verification
- [x] **M4.5 `[HUMAN]`** — Human-guided feature walkthrough & bug-fix pass
- [x] **M4.6 `[HUMAN]`** — Final production verification (household PWA install + Chief of Staff live test)

### Milestone 5: Shared Tag Vocabulary, Case Normalization & Tag Management (v1.1)
- [x] **M5.1** — Tag normalization, dynamic `GET /api/tags`, bulk tag rename/merge API, MCP `list_tags` & snapshot vocabulary
- [ ] **M5.2** — Reusable `TagPicker` autocomplete (Quick-Add & Card Detail), case-insensitive webhook/filter matching & Settings Tag Manager

### Milestone 6: Snooze (`deferUntil`), Recurring Auto-Defer, Schedule View & Priority Nudges (v1.1)
- [x] **M6.1** — Shared schemas & helpers: `pinned`, `deferUntil`, `lastCompletedAt`, recurrence `autoDefer`/`leadDays`, `projectNextOccurrences` & v1.1 event types
- [x] **M6.2** — API, MCP & cron: pinned-first `To-Do` sort, deferred filtering, recurring auto-defer, `POST /api/cards/:id/rescore`, `GET /api/cards/recurring`, `dueScanner` wake-up & Firestore index
- [ ] **M6.3 `[HUMAN]`** — Cloud deploy-and-verify gate (deploy Firestore `deferUntil` index + updated `scanDueCards` cron & live smoke verification)
- [x] **M6.4** — PWA 5th `Schedule` tab (`Upcoming` timeline + `All Recurring` master list + snoozed cards), recurrence `leadDays` editor, Pin & Request AI Rescore UI

### Milestone 7: Multi-Select & Hardened Bulk Actions (v1.1)
- [x] **M7.1** — Hardened bulk API & MCP: assignees/`deferUntil`/`pinned`/`rescoreRequested`, recurring-safe `POST /api/cards/bulk/complete` & visibility-grouped `cards.bulk_updated` batch events
- [ ] **M7.2** — PWA Multi-Select (desktop hover/`Shift+Click`, mobile `Select` mode) & sticky Bulk Action Bar across all board views

### Milestone 8: Trello-Inspired Desktop Shortcuts, Quick-Edit Popovers & `Cmd+K` Command Palette (v1.1)
- [ ] **M8.1** — Keyboard shortcut engine, list focus cursor (`j`/`k`/`x`/`Enter`/`Esc`), Trello-inspired hotkeys, `g`+tab navigation & Undo toast
- [ ] **M8.2** — Inline quick-edit popovers (Status, Members, Tags, Due, Snooze), `Cmd+K` Command Palette & `?` Shortcuts Cheatsheet

### Milestone 9: Desktop Horizontally Scrollable Kanban Board (v1.1)
- [ ] **M9.1** — Desktop `Board | List` mode (`>= 1024px` default Board), horizontally scrollable status + optional `Snoozed` columns, inline column Quick-Add & Card Detail slide-over drawer
- [ ] **M9.2** — Cross-column Drag-and-Drop (multi-select, recurring-safe `Done` & `Snoozed` drops) + 2D Kanban keyboard navigation (`ArrowLeft`/`ArrowRight`, `[` / `]`)

### Milestone 10: v1.1 Docs, Full Regression & Live Walkthrough (v1.1)
- [ ] **M10.1** — Full v1.1 E2E regression (`pnpm ci:verify`) & repository docs update (`README.md`, `docs/PRD.md`, `docs/DEPLOYMENT_SETUP.md`)
- [ ] **M10.2 `[HUMAN]`** — Human-guided v1.1 live feature walkthrough & bug-fix pass

---

## Feature ideas

Not implementation steps and not ready to build. The plan for each idea lives in `docs/features/`. This file only links to that path.

- [`docs/features/trello-json-card-import.md`](features/trello-json-card-import.md) — the idea is not defined yet.

---

## Milestone 0: Monorepo, Tooling, Emulators, Auth & CI/CD

### - [x] Step M0.1: Monorepo workspace, TypeScript, lint/format, privacy hygiene check & package skeleton

**Goal:** Establish a clean `pnpm` monorepo with strict TypeScript, ESLint, Prettier, Vitest, automated public-repo privacy/secret scanning, and the core workspace directories matching the PRD.

**Deliverables:**
- Root `package.json` (`"private": true`, Node `>=22`, scripts: `lint`, `format:check`, `typecheck`, `hygiene:check`, `build`, `test`, `ci:verify`).
- `pnpm-workspace.yaml` covering `apps/*` and `packages/*`.
- Root `tsconfig.base.json`, ESLint flat config (`eslint.config.mjs`), `.prettierrc`, and `.gitignore` explicitly ignoring:
  - `.env*` (except `!.env.example`)
  - `.firebaserc` (except `!.firebaserc.example`)
  - `.hygiene-denylist.local`
  - Service account keys (`*service-account*.json`, `*firebase-adminsdk*.json`, `*.pem`, `*.key`)
  - Firebase emulator data/logs, build outputs, `node_modules`
- `scripts/check-hygiene.mjs` (invoked by `pnpm hygiene:check`): scans all git-tracked files and fails non-zero if it detects:
  - Tracked `.env` files (other than `.env.example`), `.firebaserc`, or key/credential files.
  - Secret patterns (`BEGIN .* PRIVATE KEY`, `sk_live_`, `sk_test_`, `ak_[A-Za-z0-9]{8}_[A-Za-z0-9_-]{20,}`, `AIza[0-9A-Za-z_-]{35}`, WorkOS API keys).
  - Non-placeholder email addresses (any email not ending in `@example.test`, `@example.com`, `@example.org`, or `@users.noreply.github.com`).
  - Any case-insensitive terms listed in optional gitignored `.hygiene-denylist.local` (one term per line, so the repo owner can guard personal names/locations locally without committing the denylist).
- Package stubs with valid `package.json` + `tsconfig.json`:
  - `packages/shared` (`@agent-kanban/shared`)
  - `apps/api` (`@agent-kanban/api`)
  - `apps/web` (`@agent-kanban/web`)
- `.env.example` documenting all required env vars (`AUTH_MODE`, `HOUSEHOLD_TIMEZONE`, `WORKOS_CLIENT_ID`, `WORKOS_JWKS_URL`, `WORKOS_ISSUER`, `WEBHOOK_ENCRYPTION_KEY`, `AUTO_ARCHIVE_DAYS`, `BACKUP_BUCKET`) with safe placeholder values only.

**Validation Gate:**
```bash
pnpm install
pnpm -r typecheck
pnpm lint
pnpm format:check
pnpm hygiene:check
```
- Pass criteria: All commands exit `0`; `apps/api` and `apps/web` successfully import a smoke symbol from `@agent-kanban/shared`; `pnpm hygiene:check` catches a deliberate temporary test string when verified in a unit test (`scripts/__tests__/check-hygiene.test.ts`).

---

### - [x] Step M0.2: Shared Zod schemas & domain types (`packages/shared`)

**Goal:** Define the canonical single-source-of-truth Zod schemas and inferred TypeScript types shared by the REST API, MCP server, and PWA.

**Deliverables:**
- `packages/shared/src/schemas/`:
  - `user.ts`: `UserSchema` (`id`, `workosUserId`, `email`, `displayName`, `handle`, `role: 'admin' | 'member'`, `createdAt`), `CreateUserInputSchema`.
  - `card.ts`: `CardStatusSchema` (`'todo' | 'doing' | 'blocked' | 'done'`), `ChecklistItemSchema`, `ChecklistSchema`, `LinkAttachmentSchema`, `RecurrenceSchema` (`type: 'cron'` with 5-field expression or `type: 'interval_after_completion'` with `{ every, unit: 'days' | 'weeks' | 'months' }`, optional `timezone` IANA string defaulting to configured household timezone), `CardSchema` (including `visibleToUserIds`, `priorityScore: z.number().min(0).max(100).nullable()`, `priorityReason`, `due`, `dueFirm`, `dueHasTime`, `archived`, `enteredStatusAt`, `lastTouchedAt`, `searchTokens`, `trelloUrl`, `trelloShortLink`, `dueSoonNotifiedAt`, `overdueNotifiedAt`), plus `CreateCardInputSchema`, `UpdateCardInputSchema`, `BulkPriorityUpdateSchema`, `BulkCardUpdateSchema`.
  - `comment.ts`: `CommentSchema`, `CreateCommentInputSchema`.
  - `attachment.ts`: `AttachmentSchema`, `UploadUrlRequestSchema` (allowlisted MIME types + max 10 MB = `10 * 1024 * 1024`).
  - `activity.ts`: `ActorTypeSchema` (`'human' | 'agent' | 'system'`), `ActivitySchema`.
  - `agent.ts`: `AgentConnectionSchema`, `CreateAgentConnectionSchema`, `SubscriptionSchema`, `CreateSubscriptionSchema`, `UpdateSubscriptionSchema`, `EventSchema`, `EventTypeSchema`.
- `packages/shared/src/index.ts` re-exporting all schemas and types.
- Unit test suite in `packages/shared/src/__tests__/schemas.test.ts`.

**Validation Gate:**
```bash
pnpm --filter @agent-kanban/shared test
pnpm -r typecheck
pnpm lint
pnpm hygiene:check
```
- Pass criteria: Vitest verifies valid fixtures pass and invalid edge cases fail (e.g., `priorityScore: -1` or `101`, attachment `size > 10MB`, disallowed MIME type, invalid recurrence unit, empty card title, non-HTTPS webhook URL in strict schema).

---

### - [x] Step M0.3: Firebase config, locked Firestore/Storage rules, indexes & Emulator tests

**Goal:** Configure Firebase Emulators and enforce deny-all client security rules for Firestore and Cloud Storage so the API is the sole data access path.

**Deliverables:**
- `firebase.json` configuring `firestore`, `storage`, `functions` (Node 22 codebase pointing to `apps/api`), `hosting` (`apps/web/dist` with rewrites for `/api/**`, `/mcp`, `/.well-known/**` -> `api` function, and SPA fallback `**` -> `/index.html`), and `emulators` (deterministic ports: Firestore `8080`, Functions `5001`, Storage `9199`, Hosting `5050` [avoids macOS ControlCenter AirPlay Receiver on `5000`], UI `4000`).
- `.firebaserc.example` with `"default": "demo-agent-kanban"` (actual `.firebaserc` stays gitignored; all local/CI commands pass `--project demo-agent-kanban` explicitly).
- `firebase/firestore.rules`: explicit `rules_version = '2';` with `match /{document=**} { allow read, write: if false; }`.
- `firebase/storage.rules`: explicit `rules_version = '2';` with `match /{allPaths=**} { allow read, write: if false; }`.
- `firebase/firestore.indexes.json`: composite indexes for:
  - `cards`: `(visibleToUserIds CONTAINS, archived ASC, status ASC, priorityScore DESC, due ASC, createdAt ASC)`
  - `cards`: `(visibleToUserIds CONTAINS, archived ASC, updatedAt DESC)`
  - `cards`: `(status ASC, archived ASC, enteredStatusAt ASC)` (auto-archive & stale queries)
  - `cards`: `(archived ASC, due ASC)` (15-min due scanner)
  - `activity`: `(visibleToUserIds CONTAINS, createdAt DESC)` and `(cardId ASC, createdAt DESC)`
  - `events`: `(visibleToUserIds CONTAINS, createdAt ASC)` and `(createdAt ASC)` (retention cleanup)
  - `subscriptions`: `(ownerUserId ASC, active ASC)`
- Rules test suite `apps/api/tests/rules.test.ts` using `@firebase/rules-unit-testing` + Vitest, plus npm script `test:rules` in `apps/api`.

**Validation Gate:**
```bash
firebase emulators:exec --project demo-agent-kanban --only firestore,storage "pnpm --filter @agent-kanban/api test:rules"
pnpm hygiene:check
```
- Pass criteria: Tests prove unauthenticated AND authenticated client SDK `getDoc`/`setDoc`/`deleteDoc` on `users`, `cards`, `activity`, `agentConnections`, `subscriptions`, `events` all fail with `PERMISSION_DENIED`; direct Storage client uploads/downloads fail with `PERMISSION_DENIED`; Admin SDK / `withSecurityRulesDisabled` succeeds.

---

### - [x] Step M0.4: Express Cloud Function bootstrap, bundler & health smoke test

**Goal:** Build the Express app hosted inside Firebase Cloud Functions v2 (`api`) with an `esbuild` bundle step that cleanly inlines `@agent-kanban/shared` for zero-friction Firebase deployment.

**Deliverables:**
- `apps/api/src/config.ts`: centralized environment config reader (`HOUSEHOLD_TIMEZONE` defaulting to `'UTC'`, `AUTH_MODE`, `AUTO_ARCHIVE_DAYS` defaulting to `30`, WorkOS settings, `BACKUP_BUCKET`).
- `apps/api/src/app.ts` creating the Express application with JSON parsing (1 MB limit), request ID middleware, structured error handler (`AppError` -> `{ error: { code, message, details? } }`), Zod request validation helper, and `GET /api/health` returning `{ ok: true, timestamp, version }`.
- `apps/api/src/index.ts` exporting `api = onRequest({ region: 'us-central1', memory: '512MiB' }, app)` (Firebase Functions v2).
- `apps/api/src/lib/firebase.ts` initializing Firebase Admin SDK (`getFirestore()`, `getStorage()`) lazily and idempotently for both emulator and prod.
- `apps/api/package.json` build script using `esbuild`/`tsup` producing `dist/index.js` cleanly with `@agent-kanban/shared` bundled and Firebase/Node externals preserved.
- Smoke test `apps/api/tests/health.test.ts` hitting the live Functions Emulator endpoint.

**Validation Gate:**
```bash
pnpm --filter @agent-kanban/api build
firebase emulators:exec --project demo-agent-kanban --only functions,firestore "pnpm --filter @agent-kanban/api test:smoke"
pnpm -r typecheck
pnpm lint
pnpm hygiene:check
```
- Pass criteria: Build succeeds cleanly; `GET /api/health` through the Functions Emulator returns HTTP `200` with `{ ok: true }`; unknown route returns structured JSON `404`.

---

### - [x] Step M0.5: Auth middleware (WorkOS JWKS + emulator RSA keypair), allowlist & seed script

**Goal:** Implement the complete JWT verification pipeline supporting WorkOS AuthKit JWKS in production and a local RSA test keypair in emulator/test mode, enforce the Firestore user allowlist, and provide an idempotent fake-data emulator seeder.

**Deliverables:**
- `apps/api/src/middleware/auth.ts`:
  - **Hard Safety Guard:** Throw fatal startup error if `AUTH_MODE === 'emulator'` when `FUNCTIONS_EMULATOR !== 'true'` and `NODE_ENV !== 'test'`.
  - Verifies `Authorization: Bearer <jwt>` using `jose` (`createRemoteJWKSet` for WorkOS AuthKit JWKS in prod; local test RSA public key in emulator mode).
  - Extracts `sub` (`workosUserId`) and verified `email`.
  - Looks up `users` collection: first by `workosUserId`, fallback by lowercased `email` (if found and `workosUserId` is null, atomically links `workosUserId`). If no matching allowlisted user exists, responds `403 Forbidden` (`USER_NOT_ALLOWLISTED`).
  - Attaches `req.auth = { userId, ownerUserId: userId, role, actorType: 'human', displayName, handle, email }`.
- `apps/api/src/lib/emulatorAuth.ts`: ephemeral/runtime-generated local RSA test keypair (never committed as a PEM file) + helper to sign test JWTs (`POST /api/dev/token` mounted **ONLY** when emulator guard passes, returning a signed JWT for any seeded emulator user).
- User endpoints in `apps/api/src/routes/users.ts`:
  - `GET /api/me` (current authenticated user)
  - `GET /api/users` (household roster for assignee/aware/@mention pickers)
  - `POST /api/admin/users` (admin-only: add a household user to the allowlist)
- `scripts/seed-emulator.ts`: idempotent CLI script seeding 2 strictly fictional household users (`Alex Rivera`, `@alex`, `alex@example.test`, `admin`; `Sam Rivera`, `@sam`, `sam@example.test`, `member`) and 6 generic sample cards across `todo`/`doing`/`blocked`/`done`.
- `scripts/bootstrap-user.ts`: CLI script reading user flags/env vars to pre-create a household user doc in Firestore (emulator or prod via Admin credentials—never stores personal data in git).
- Integration tests `apps/api/tests/auth.test.ts`.

**Validation Gate:**
```bash
pnpm --filter @agent-kanban/api build
firebase emulators:exec --project demo-agent-kanban --only functions,firestore "pnpm --filter @agent-kanban/api test:auth"
pnpm hygiene:check
```
- Pass criteria: Tests prove:
  1. Missing/malformed/bad-signature JWT -> `401`.
  2. Valid JWT for non-allowlisted email -> `403`.
  3. First login for allowlisted email -> `200` and persists `workosUserId` on `users/{userId}`.
  4. `GET /api/users` returns household roster; non-admin calling `POST /api/admin/users` -> `403`; admin succeeds -> `201`.
  5. Unit test proves `assertEmulatorAuthAllowed()` throws when `FUNCTIONS_EMULATOR` is unset and `NODE_ENV=production`.

---

### - [x] Step M0.6: Minimal PWA shell, Hosting rewrites, AuthKit client & Dev User Switcher

**Goal:** Stand up the React + Vite + Tailwind + TanStack Query + `vite-plugin-pwa` frontend, wire WorkOS AuthKit login (prod) and the Dev User Switcher (emulator), and prove end-to-end browser login through Firebase Hosting + Functions Emulators.

**Deliverables:**
- `apps/web` configured with Vite, React, Tailwind CSS, TanStack Query, React Router, and `vite-plugin-pwa` (generating manifest + service worker).
- `apps/web/src/lib/auth.tsx`:
  - When `VITE_AUTH_MODE === 'emulator'`, renders a clean "Dev User Switcher" (`Sign in as Alex (@alex)` / `Sign in as Sam (@sam)`) that fetches a real signed test JWT from `/api/dev/token` and stores it in memory/sessionStorage.
  - Otherwise uses `@workos-inc/authkit-react` (WorkOS AuthKit PKCE login + token refresh).
- `apps/web/src/lib/api.ts`: typed fetch client attaching `Authorization: Bearer <token>` and parsing structured errors.
- Authenticated shell displaying current user + sign-out button; unauthenticated sign-in screen; friendly `403` "Household access required" screen if signed in with an unallowlisted account.
- Playwright configuration (`playwright.config.ts`) at repo root + E2E test `e2e/m0-auth.spec.ts`.

**Validation Gate:**
```bash
pnpm --filter @agent-kanban/web build
pnpm --filter @agent-kanban/api build
firebase emulators:exec --project demo-agent-kanban --only hosting,functions,firestore "pnpm exec tsx scripts/seed-emulator.ts && pnpm test:e2e -- e2e/m0-auth.spec.ts"
pnpm hygiene:check
```
- Pass criteria: Web build outputs PWA bundle with manifest/SW; Playwright loads `http://127.0.0.1:5050`, verifies sign-in screen, signs in as Alex via Dev User Switcher, confirms `/api/me` renders `"Alex Rivera"`, signs out, and signs in as Sam.

---

### - [x] Step M0.7: GitHub Actions CI & CD workflows + local `ci:verify` script

**Goal:** Automate full build, lint, typecheck, privacy hygiene, unit, rules, emulator API, and Playwright E2E verification on every push/PR, and automate Firebase deployment on `main`.

**Deliverables:**
- Root `package.json` script `ci:verify` running:
  1. `pnpm hygiene:check`
  2. `pnpm lint`
  3. `pnpm format:check`
  4. `pnpm -r typecheck`
  5. `pnpm --filter @agent-kanban/shared test`
  6. `pnpm -r build`
  7. `firebase emulators:exec --project demo-agent-kanban --only firestore,storage,functions,hosting "pnpm run test:emulator-all"` (runs rules tests, API integration tests, seeds emulator, and runs Playwright E2E).
- `.github/workflows/ci.yml`: triggers on `push` and `pull_request`; installs Node 22, Java 21, `pnpm`, Playwright Chromium, Firebase CLI, and runs `pnpm ci:verify`.
- `.github/workflows/deploy.yml`: triggers on `push` to `main` (and `workflow_dispatch`); runs CI checks, then deploys Firestore rules/indexes, Storage rules, Cloud Functions, and Firebase Hosting using `--project "$FIREBASE_PROJECT_ID"` from GitHub Secrets (skipped gracefully if `FIREBASE_SERVICE_ACCOUNT` secret is not yet configured so M0.7 stays green before M0.8).

**Validation Gate:**
```bash
pnpm ci:verify
node -e "const fs=require('fs'); for (const f of ['.github/workflows/ci.yml','.github/workflows/deploy.yml']) { if (!fs.existsSync(f)) throw new Error(f); }"
```
- Pass criteria: `pnpm ci:verify` passes end-to-end with exit code `0` on a clean emulator run; `pnpm hygiene:check` confirms zero secrets, `.env` files, or personal details in tracked files.

---

### - [x] Step M0.8 `[HUMAN]`: Provision Firebase project, WorkOS AuthKit, secrets & prod deploy

> **AGENT STOP GATE:** Do not execute or skip this step. Present the checklist below to the repository owner and wait for confirmation.
>
> **Setup Guide & Gotchas:** See [`docs/DEPLOYMENT_SETUP.md`](DEPLOYMENT_SETUP.md) for detailed WorkOS AuthKit JWT template, multi-app `iss`/JWKS, CORS, GCP IAM, and bootstrap notes.

**Manual Setup Checklist:**
1. **Local Privacy Guard (Optional but Recommended):**
   - Create a gitignored `.hygiene-denylist.local` file in your local checkout containing any personal terms (family names, real emails, city/timezone) you want `pnpm hygiene:check` to block from ever being committed.
   - Enable **GitHub Secret Scanning** and **Push Protection** in the repository's GitHub security settings.
2. **Firebase Project:**
   - Create a private Firebase project and upgrade to the Blaze plan.
   - Set a GCP Billing Budget Alert at **$5/month**.
   - Enable **Cloud Firestore** (Native mode, `us-central1`), **Cloud Storage**, **Cloud Functions**, **Firebase Hosting**, and **Secret Manager**.
   - Keep `.firebaserc` local-only (gitignored) or configure `FIREBASE_PROJECT_ID` strictly in GitHub Secrets.
3. **WorkOS AuthKit:**
   - Create a WorkOS AuthKit application.
   - Configure Allowed Redirect URIs (`https://<your-domain>/callback`, `http://localhost:5173/callback`) and OAuth 2.1 settings for MCP clients.
   - Note `WORKOS_CLIENT_ID`, `WORKOS_JWKS_URL`, and `WORKOS_ISSUER`.
4. **Secrets (Google Secret Manager & GitHub Actions):**
   - Generate a 32-byte random base64 `WEBHOOK_ENCRYPTION_KEY` (`openssl rand -base64 32`) and store it in Google Secret Manager.
   - Set runtime config / GitHub Actions Secrets (`FIREBASE_PROJECT_ID`, `FIREBASE_SERVICE_ACCOUNT`, `HOUSEHOLD_TIMEZONE`, `VITE_WORKOS_CLIENT_ID`, `WORKOS_JWKS_URL`, `WORKOS_ISSUER`).
5. **Bootstrap Household Users:**
   - Run `scripts/bootstrap-user.ts` locally against production to pre-create your household user accounts (`admin` and `member`) with their real emails and `@handles`.
6. **Trigger Deploy & Verify:**
   - Run the Deploy GitHub Action (`deploy.yml`).

**Validation Gate:**
- GitHub Actions `ci.yml` and `deploy.yml` both pass green.
- Allowlisted household members can open the live Firebase Hosting URL, log in via WorkOS AuthKit, and see their authenticated profile from `/api/me`.
- Logging in with an unallowlisted email returns `403` and shows the "Household access required" screen.

---

## Milestone 1: Core Card API & Minimal Mobile PWA

### - [x] Step M1.1: Shared helpers — search tokenizer, `@mention` parser, DST-aware due & recurrence engine

**Goal:** Build and thoroughly unit-test all deterministic domain logic in `packages/shared` before wiring API routes.

**Deliverables:**
- `packages/shared/src/utils/search.ts`: `buildSearchTokens({ title, description, checklists })` and `tokenizeQuery(query)` — lowercases, strips punctuation, deduplicates tokens, generates prefix tokens (length 2..20) capped reasonably so Firestore `array-contains` / multi-term search works fast and accurately.
- `packages/shared/src/utils/mentions.ts`: `extractMentionHandles(text)` matching `@handle` tokens while ignoring email addresses (e.g., `alex@example.test`).
- `packages/shared/src/utils/dates.ts`: DST-aware IANA timezone helpers (using `luxon` or `date-fns-tz`):
  - `resolveEffectiveDueInstant(dueIso, dueHasTime, tz)`: date-only dues evaluate to `23:59:59` local time in the configured IANA timezone `tz` (handling DST spring-forward/fall-back transitions cleanly).
  - `isDueSoon(card, now, tz, windowDays = 2)` and `isOverdue(card, now, tz)`.
- `packages/shared/src/utils/recurrence.ts`: `computeNextDueDate(recurrence, completedAt, currentDue, defaultTz)`:
  - `cron`: uses `cron-parser` evaluated in `recurrence.timezone || defaultTz` strictly after `completedAt`.
  - `interval_after_completion`: adds `{ every, unit: 'days' | 'weeks' | 'months' }` in `recurrence.timezone || defaultTz` preserving time if `dueHasTime`, else date-only.
- Comprehensive Vitest unit test suites in `packages/shared/src/__tests__/` (using generic DST-observing IANA timezones such as `America/New_York` and `UTC`).

**Validation Gate:**
```bash
pnpm --filter @agent-kanban/shared test
pnpm -r typecheck
pnpm lint
pnpm hygiene:check
```
- Pass criteria: Unit tests cover DST spring-forward (March) and fall-back (November) in `America/New_York`, Saturday 7:00 AM cron, `30 days after completion`, `1 month after completion` (month-end clamping), `@mention` vs email edge cases, and multi-checklist tokenization.

---

### - [x] Step M1.2: Core Card CRUD, visibility, status transitions, idempotency, `ifUpdatedAt` & activity log

**Goal:** Implement the core Card REST endpoints with strict visibility filtering, concurrency preconditions, idempotency, and automatic activity logging.

**Deliverables:**
- `apps/api/src/services/activity.ts`: helper writing `activity/{id}` docs with `cardId`, `visibleToUserIds`, actor fields (`actorType`, `actorId`, `agentName`, `platform`), `action`, `diff` (`{ field: { from, to } }`), optional `note`, and `createdAt`.
- `apps/api/src/services/idempotency.ts`: Firestore `idempotencyKeys/{scope_key}` transaction store (24h TTL metadata) returning cached `{ status, body }` on replay for `Idempotency-Key` header.
- Card endpoints (`apps/api/src/routes/cards.ts` backed by clean handler functions in `apps/api/src/handlers/cards.ts`):
  - `POST /api/cards` — supports `Idempotency-Key`, optional `note`, computes `visibleToUserIds`, `searchTokens`, `enteredStatusAt`, `lastTouchedAt`, `createdBy`, `updatedAt`. Defaults `assignedUserIds` to `[req.auth.userId]` if omitted.
  - `GET /api/cards` — filters: `status`, `tag`, `assignedTo`, `awareOf`, `dueBefore`, `dueAfter`, `updatedSince`, `archived` (default `false`). Automatically restricted to `visibleToUserIds array-contains req.auth.ownerUserId`. Default sort for `todo`: `priorityScore DESC` (nulls last), `due ASC` (nulls last), `createdAt ASC`.
  - `GET /api/cards/:id` — returns `404` if missing or not visible to caller.
  - `GET /api/cards/by-trello?url=...` or `?shortLink=...` — resolves legacy Trello links within caller's visible cards.
  - `PATCH /api/cards/:id` — enforces optional `ifUpdatedAt` precondition (`409 Conflict` on mismatch), updates `visibleToUserIds`, `searchTokens`, `lastTouchedAt`, `updatedAt`, resets `dueSoonNotifiedAt`/`overdueNotifiedAt` if `due` changed, logs field diff + `note`.
  - `POST /api/cards/:id/status` — validates status (`todo` | `doing` | `blocked` | `done`), updates `enteredStatusAt` when status changes, logs `card.status_changed`.
  - `POST /api/cards/:id/archive` — sets `archived: true` (or `false` when unarchiving), logs activity.
  - `GET /api/cards/:id/activity` & `GET /api/activity` — paginated, visibility-filtered.
- Emulator integration suite `apps/api/tests/cards.test.ts`.

**Validation Gate:**
```bash
pnpm --filter @agent-kanban/api build
firebase emulators:exec --project demo-agent-kanban --only functions,firestore "pnpm --filter @agent-kanban/api test:cards"
pnpm -r typecheck
pnpm lint
pnpm hygiene:check
```
- Pass criteria: Tests prove:
  1. Visibility isolation: Sam cannot read, patch, change status, or see activity for Alex's private card (`404`, omitted from list).
  2. Both `assignedUserIds` and `awareUserIds` grant full read/write.
  3. Default `todo` sort orders scored cards `DESC`, nulls last, tie-broken by `due ASC`, `createdAt ASC`.
  4. `Idempotency-Key` replay returns the exact same card ID without creating a duplicate.
  5. Stale `ifUpdatedAt` returns `409 Conflict`.
  6. Legacy Trello lookup by `trelloUrl` and `trelloShortLink` returns the visible card.
  7. Every mutation produces an accurate `activity` entry with `diff` and `note`.

---

### - [x] Step M1.3: Checklists CRUD/toggle, link attachments & full-text token search

**Goal:** Add embedded checklist operations, card link attachments, and full-text tokenized search across title, description, and checklist items.

**Deliverables:**
- Checklist endpoints (`apps/api/src/handlers/checklists.ts`):
  - `POST /api/cards/:id/checklists` (create checklist with optional initial items)
  - `PATCH /api/cards/:id/checklists/:checklistId` (rename or replace items)
  - `DELETE /api/cards/:id/checklists/:checklistId`
  - `POST /api/cards/:id/checklists/:checklistId/items` (add item)
  - `PATCH /api/cards/:id/checklists/:checklistId/items/:itemId` (toggle `checked` and/or edit `text`)
  - `DELETE /api/cards/:id/checklists/:checklistId/items/:itemId`
  - Every checklist mutation recalculates `searchTokens[]`, updates `lastTouchedAt` & `updatedAt`, and logs activity.
- Link attachment endpoints:
  - `POST /api/cards/:id/links` (`{ url, label? }`, validates http/https URL)
  - `DELETE /api/cards/:id/links/:linkId`
- Search endpoint:
  - `GET /api/cards/search?q=<text>&archived=<bool>` — uses `visibleToUserIds` + tokenized matching (requiring all query tokens to match against `searchTokens[]`, supporting prefix match).
- Integration tests `apps/api/tests/checklists-search.test.ts`.

**Validation Gate:**
```bash
pnpm --filter @agent-kanban/api build
firebase emulators:exec --project demo-agent-kanban --only functions,firestore "pnpm --filter @agent-kanban/api test:checklists-search"
pnpm -r typecheck
pnpm lint
pnpm hygiene:check
```
- Pass criteria: Tests prove checklist CRUD + item toggling persists and logs activity; searching finds words inside title, description, AND checklist item text; multi-word search requires all terms; private cards of another user never appear in search results; link attachments add/remove cleanly.

---

### - [x] Step M1.4: Comments with `@mentions` & in-place recurring card resets

**Goal:** Implement card comments with automatic `@handle` resolution and atomic in-place completion/reset for recurring cards.

**Deliverables:**
- Comment endpoints (`apps/api/src/handlers/comments.ts`):
  - `GET /api/cards/:id/comments` (chronological order, visibility checked)
  - `POST /api/cards/:id/comments` — extracts `@handles`, resolves against `users` collection into `mentions[]` user IDs, writes `cards/{id}/comments/{commentId}` with actor metadata, updates card `lastTouchedAt`, logs `card.commented` activity.
- Completion & Recurrence endpoint (`POST /api/cards/:id/complete` in `apps/api/src/handlers/cards.ts`):
  - **Non-recurring card:** sets `status: 'done'`, updates `enteredStatusAt` & `lastTouchedAt`, logs `card.completed`.
  - **Recurring card (atomic Firestore transaction):**
    1. Logs `card.completed` activity (recording completed `due` and computed next `due`).
    2. Unchecks **all** checklist items across all `checklists[]`.
    3. Computes and sets next `due` via `computeNextDueDate` using the card's or configured `HOUSEHOLD_TIMEZONE`.
    4. Resets `status` to `'todo'` and updates `enteredStatusAt`, `lastTouchedAt`, `updatedAt`.
    5. Clears `priorityScore: null`, `priorityReason: null`, `dueSoonNotifiedAt: null`, `overdueNotifiedAt: null`.
    6. Preserves card ID, comments, links, and attachments untouched.
- Integration tests `apps/api/tests/comments-recurrence.test.ts`.

**Validation Gate:**
```bash
pnpm --filter @agent-kanban/api build
firebase emulators:exec --project demo-agent-kanban --only functions,firestore "pnpm --filter @agent-kanban/api test:comments-recurrence"
pnpm -r typecheck
pnpm lint
pnpm hygiene:check
```
- Pass criteria: Tests prove:
  1. Comment mentioning `@sam` resolves `mentions: [samUserId]` and ignores `not-a-mention@example.test`.
  2. Completing a recurring `cron` card keeps the same card ID and existing comments, unchecks all checklist items, advances `due`, sets `status: 'todo'`, clears `priorityScore`/`priorityReason` to `null`, and writes a `card.completed` activity log entry.
  3. Completing an `interval_after_completion` card computes `completedAt + interval` accurately.
  4. Completing a non-recurring card moves it to `done`, and it can be reopened (`done -> todo`).

---

### - [x] Step M1.5: PWA views — Bottom nav, `To-Do` (Top 5 + collapsible), `Active`, `Done`, search & filters

**Goal:** Build the mobile-first single-column PWA views for browsing, filtering, and searching the unified card pool.

**Deliverables:**
- Responsive app shell (`max-w-xl mx-auto` on desktop, full width on mobile) with persistent bottom tab navigation:
  - **To-Do** (`/`): Shows Top 5 `todo` cards expanded by default; remaining `todo` cards collapsed inside an expandable `"Show N more"` section.
  - **Active** (`/active`): Two stacked sections for `Doing` and `Blocked` cards.
  - **Done** (`/done`): Recently completed non-archived cards (with toggle to include archived).
  - **Settings** (`/settings`): Shell page (populated further in M2.3 & M3.4).
- Sticky top filter bar: search input (debounced `GET /api/cards/search`), horizontal tag filter chips, and person filter (`All`, `Assigned to me`, or specific household member).
- Clean Card Row component showing: title, priority score badge + `priorityReason` one-liner (or `"Unscored"`), due date chip (highlighted when `dueFirm` or overdue), tags, checklist progress (`2/5`), recurrence icon, and assigned user avatar/initials.
- Playwright E2E test `e2e/m1-views.spec.ts`.

**Validation Gate:**
```bash
pnpm --filter @agent-kanban/web build
pnpm --filter @agent-kanban/api build
firebase emulators:exec --project demo-agent-kanban --only hosting,functions,firestore "pnpm test:e2e -- e2e/m1-views.spec.ts"
pnpm hygiene:check
```
- Pass criteria: E2E test seeds 8 `todo` cards + `doing`/`blocked`/`done` cards, confirms `To-Do` renders Top 5 sorted by `priorityScore DESC` with 3 collapsed under `"Show 3 more"` (clicking expands to 8), tag/person filters and search narrow the list accurately, and a `390x844` mobile viewport has zero horizontal overflow.

---

### - [x] Step M1.6: PWA Quick-Add (FAB + household sharing default) & full Card Detail view

**Goal:** Complete full human task interaction in the PWA—quick card creation with default household visibility and a complete Card Detail page.

**Deliverables:**
- Floating Action Button (FAB) opening a fast Quick-Add modal/sheet:
  - Title (autofocus), optional description, tags input, due date + `dueFirm` toggle + `dueHasTime` toggle, and **"Share with household"** toggle (**default ON**, populating `awareUserIds` with all other household members).
- Full Card Detail route (`/cards/:id`):
  - Editable title, description, tags, assigned & aware user pickers, due date (`dueFirm`/`dueHasTime`), recurrence rule editor (`None`, `Weekly/Cron`, `Every N days/weeks/months after done`).
  - One-tap status pills (`To-Do`, `Doing`, `Blocked`), primary **Complete** button (showing `"Complete & Reset"` indicator when recurring), and **Archive** action.
  - Interactive Checklists section (add checklist, add item, tap checkbox to toggle, delete item).
  - Links section (add/open/remove links).
  - Comments thread showing author (`"Alex Rivera"` or `"Chief of Staff via Automation Bot (agent)"`) and composer supporting `@handle` mentions.
  - Collapsible Activity Log timeline showing actor, diff, and `note`.
- Playwright E2E test `e2e/m1-card-lifecycle.spec.ts`.

**Validation Gate:**
```bash
pnpm --filter @agent-kanban/web build
pnpm --filter @agent-kanban/api build
firebase emulators:exec --project demo-agent-kanban --only hosting,functions,firestore "pnpm test:e2e -- e2e/m1-card-lifecycle.spec.ts"
pnpm ci:verify
```
- Pass criteria: E2E test verifies:
  1. Alex creates a card via FAB with default "Share with household" ON -> switching to Sam confirms Sam sees and can edit it.
  2. Alex creates a private card (toggle OFF) -> Sam cannot see it.
  3. Adding/toggling checklist items, adding a link, posting a `@sam` comment, changing status, and completing a recurring card all persist across page reload and appear in Activity Log.
  4. Full `pnpm ci:verify` passes with zero regressions.

---

## Milestone 2: Agent Connections & Prioritization API

### - [x] Step M2.1: User-owned Agent Connections, hashed API keys (`ak_...`) & `X-Agent-Name` attribution

**Goal:** Enable any household user to create, rotate, and revoke platform API keys bound to their `ownerUserId`, with full agent attribution on every write.

**Deliverables:**
- Key format & crypto (`apps/api/src/lib/apiKeys.ts`):
  - Generate `ak_<8-char-prefix>_<32-byte-base64url>` secrets.
  - Store only `keyPrefix` + `hashedKey = sha256(fullKey)` in `agentConnections/{connectionId}` (never store plaintext).
  - Constant-time hash comparison during auth lookup.
- Endpoints (`apps/api/src/routes/agentConnections.ts` — human JWT auth required; scoped to `ownerUserId === req.auth.userId`):
  - `GET /api/agent-connections` (lists owner's connections with `keyPrefix`, `platform`, `authType`, `revoked`, `createdAt`, `rotatedAt` — never returns secret or hash).
  - `POST /api/agent-connections` (`{ platform }`, returns `{ connection, apiKey }` **once**).
  - `POST /api/agent-connections/:id/rotate` (generates new hash, sets `rotatedAt`, returns new `apiKey` **once**).
  - `DELETE /api/agent-connections/:id` (sets `revoked: true`).
- Auth middleware update (`apps/api/src/middleware/auth.ts`):
  - Detect `Authorization: Bearer ak_...` prefix, look up non-revoked connection by `hashedKey`, load owner user doc, and populate `req.auth = { userId: owner.id, ownerUserId: owner.id, role: owner.role, actorType: 'agent', connectionId, platform: conn.platform, agentName: header('X-Agent-Name') || conn.platform }`.
  - Format display attribution consistently in comments and activity as `"<agentName> via <platform> (agent)"`.
- Integration tests `apps/api/tests/agent-auth.test.ts`.

**Validation Gate:**
```bash
pnpm --filter @agent-kanban/api build
firebase emulators:exec --project demo-agent-kanban --only functions,firestore "pnpm --filter @agent-kanban/api test:agent-auth"
pnpm -r typecheck
pnpm lint
pnpm hygiene:check
```
- Pass criteria: Tests prove:
  1. Key returned once on create/rotate; `GET /api/agent-connections` never exposes plaintext or hash.
  2. Valid key with `X-Agent-Name: Chief of Staff` creates/edits cards and comments attributed to `actorType: 'agent'`, `agentName: 'Chief of Staff'`, `platform: 'Automation Bot'`.
  3. Key strictly inherits owner's card visibility (cannot read another user's private card).
  4. Rotated old key and revoked key immediately fail with `401`.

---

### - [x] Step M2.2: Bulk priority/field updates, smart queries & workspace snapshot

**Goal:** Deliver the high-leverage agent endpoints that let a Chief of Staff agent reprioritize the household backlog and generate morning briefs in a single roundtrip.

**Deliverables:**
- `PATCH /api/cards/priorities` (handler `apps/api/src/handlers/priorities.ts`):
  - Accepts `{ updates: [{ cardId, priorityScore, priorityReason }], note? }` + `Idempotency-Key`.
  - Validates every `cardId` exists and is visible to `ownerUserId` (rejects cleanly without partial corruption if any card is invisible/invalid).
  - Updates `priorityScore`, `priorityReason`, `updatedAt`, and logs a priority-rescore activity entry with `note`.
- `PATCH /api/cards/bulk`:
  - Accepts `{ updates: [{ cardId, status?, tags?, addTags?, removeTags?, due?, dueFirm?, dueHasTime?, archived? }], note? }` + `Idempotency-Key`.
- Smart Query endpoint `GET /api/cards/smart`:
  - `query=overdue_or_due_within_days&days=<N>` (default `3`, DST-aware using `HOUSEHOLD_TIMEZONE`).
  - `query=stale_in_todo_days&days=<N>` (default `14`, checks `status === 'todo'` and `enteredStatusAt` older than `N` days).
- Workspace Snapshot endpoint `GET /api/workspace/snapshot`:
  - Single-call payload returning `{ generatedAt, timezone, ownerUserId, users, counts, cards }` containing all non-archived open cards (`todo`, `doing`, `blocked`) visible to caller with scores, reasons, dues (`isOverdue`, `isDueSoon` computed), checklist counts, tags, `enteredStatusAt`, `lastTouchedAt`, and latest comment preview.
- Integration tests `apps/api/tests/prioritization.test.ts`.

**Validation Gate:**
```bash
pnpm --filter @agent-kanban/api build
firebase emulators:exec --project demo-agent-kanban --only functions,firestore "pnpm --filter @agent-kanban/api test:prioritization"
pnpm -r typecheck
pnpm lint
pnpm hygiene:check
```
- Pass criteria: Tests simulate a full Chief of Staff pass: call `GET /api/workspace/snapshot` with API key -> call `PATCH /api/cards/priorities` with `Idempotency-Key` + `note` -> verify `GET /api/cards?status=todo` reflects new ranking -> replay `Idempotency-Key` -> verify smart queries return exact overdue/due-within-N and stale-in-todo cards -> verify bulk payload containing an invisible card ID is rejected cleanly.

---

### - [x] Step M2.3: PWA Settings — Agent Connection / API Key management & household roster

**Goal:** Let household users manage their own agent API keys and view the household roster directly in the PWA Settings tab.

**Deliverables:**
- Settings page (`apps/web/src/pages/SettingsPage.tsx`):
  - **Profile & Sign Out** card.
  - **Household Roster** list (names, `@handles`, roles; admin-only "Add household member" form calling `POST /api/admin/users`).
  - **Agent Connections (API Keys)** section:
    - Create connection form (`platform` name e.g. `"Automation Bot"`).
    - Copy-once key reveal modal with warning that the key will not be shown again.
    - Rotate and Revoke buttons with confirmation.
- Playwright E2E test `e2e/m2-settings.spec.ts`.

**Validation Gate:**
```bash
pnpm --filter @agent-kanban/web build
pnpm --filter @agent-kanban/api build
firebase emulators:exec --project demo-agent-kanban --only hosting,functions,firestore "pnpm test:e2e -- e2e/m2-settings.spec.ts"
pnpm ci:verify
```
- Pass criteria: E2E test creates an `"Automation Bot"` key in Settings, captures the copy-once `ak_...` key, uses that key directly against `/api/workspace/snapshot` (`200`), reloads Settings confirming secret is hidden, clicks Revoke, and confirms `/api/workspace/snapshot` now returns `401`.

---

## Milestone 3: MCP Server, Filtered Webhooks & Scheduled Jobs

### - [x] Step M3.1: Shared handler layer, Stateless Streamable HTTP `/mcp` & RFC 9728 OAuth metadata

**Goal:** Expose the entire `agent-kanban` toolset as a spec-compliant remote MCP server over Streamable HTTP sharing the exact same handler functions as the REST API.

**Deliverables:**
- Audit/refactor `apps/api/src/handlers/*` so every read/write/search/snapshot/bulk/comment/checklist operation is a pure typed handler taking `(ctx: RequestContext, input)` — called identically by Express REST routes and MCP tool callbacks.
- RFC 9728 metadata route (`GET /.well-known/oauth-protected-resource`) returning `{ resource, authorization_servers: [WORKOS_ISSUER], bearer_methods_supported: ['header'], scopes_supported: ['openid', 'profile', 'email'] }`.
- `apps/api/src/mcp/server.ts` using `@modelcontextprotocol/sdk`:
  - Stateless `StreamableHTTPServerTransport` mounted at `POST /mcp` (and `GET/DELETE /mcp` returning `405` cleanly in stateless mode per spec).
  - Accepts WorkOS OAuth 2.1 JWT **or** `ak_...` API key via existing `auth` middleware.
  - Unauthenticated requests to `/mcp` return `401` with `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource"`.
  - Every write tool accepts optional `agentName` & `note` arguments (falling back to `X-Agent-Name` header), stamping `actorType: 'agent'` when called over `/mcp` so MCP agent calls obey agent attribution and loop suppression.
  - Register tools: `list_cards`, `get_card`, `get_card_by_trello`, `search_cards`, `get_workspace_snapshot`, `smart_query_cards`, `get_activity`, `create_card`, `update_card`, `change_card_status`, `complete_card`, `archive_card`, `bulk_update_priorities`, `bulk_update_cards`, `add_comment`, `manage_checklist`, `toggle_checklist_item`, `manage_link`, `list_events`, `manage_subscriptions`.
- Integration tests `apps/api/tests/mcp.test.ts` using `@modelcontextprotocol/sdk/client`.

**Validation Gate:**
```bash
pnpm --filter @agent-kanban/api build
firebase emulators:exec --project demo-agent-kanban --only functions,firestore "pnpm --filter @agent-kanban/api test:mcp"
pnpm -r typecheck
pnpm lint
pnpm hygiene:check
```
- Pass criteria: Official MCP client connects to `http://127.0.0.1:5001/.../mcp`, verifies `401` + `WWW-Authenticate` header without auth, verifies `/.well-known/oauth-protected-resource`, authenticates with BOTH JWT (OAuth path) and API key, executes `tools/list`, runs `create_card` + `bulk_update_priorities` + `get_workspace_snapshot`, verifies visibility isolation, and verifies writes are attributed as `actorType: 'agent'`.

---

### - [x] Step M3.2: Event pipeline, agent loop suppression & 30-day polling fallback (`GET /api/events`)

**Goal:** Emit immutable domain events on human actions only (suppressing all agent-triggered loops) and expose cursor-based polling for harnesses that don't use webhooks.

**Deliverables:**
- `apps/api/src/services/events.ts`: `publishEvent(ctx, { type, card, payload, note })`:
  - **Strict Loop Guard:** Immediately no-ops if `ctx.actorType === 'agent'`.
  - Writes `events/{eventId}` with `type`, `cardId`, `visibleToUserIds`, `actor`, `note`, `payload` (including `tags`, `status`, `assignedUserIds`, `mentions`), `createdAt`, `deliveries: {}`.
- Wire `publishEvent` into handlers for:
  - `card.created`
  - `card.updated`
  - `card.status_changed`
  - `card.commented` (includes `mentions[]`)
  - `card.completed`
- Polling endpoint `GET /api/events?since=<cursor>&limit=<N>`:
  - Returns events visible to `req.auth.ownerUserId` ordered by `createdAt ASC`, with `nextCursor` for incremental polling.
- Integration tests `apps/api/tests/events.test.ts`.

**Validation Gate:**
```bash
pnpm --filter @agent-kanban/api build
firebase emulators:exec --project demo-agent-kanban --only functions,firestore "pnpm --filter @agent-kanban/api test:events"
pnpm -r typecheck
pnpm lint
pnpm hygiene:check
```
- Pass criteria: Tests prove:
  1. Human card create, update, status change, comment (with `@mention`), and complete each write an `events/{eventId}` doc.
  2. Identical operations performed via API key OR `/mcp` write **zero** event docs.
  3. `GET /api/events?since=<cursor>` returns only events visible to caller and advances cursor without duplicates or skips.

---

### - [x] Step M3.3: Filtered webhook subscriptions, AES-GCM encryption, `Bearer`/`HMAC` delivery & retries

**Goal:** Implement user-owned webhook subscriptions with encrypted secrets, rich event filtering, signed deliveries, and Firestore-backed exponential backoff retries.

**Deliverables:**
- `apps/api/src/lib/crypto.ts`: AES-256-GCM `encryptSecret(plaintext)` / `decryptSecret(ciphertext)` using `WEBHOOK_ENCRYPTION_KEY` (32-byte key from Secret Manager in prod, `.env.local` in emulator).
- Subscription endpoints (`apps/api/src/handlers/subscriptions.ts` + routes):
  - `GET /api/subscriptions` (owner-scoped; never returns secret)
  - `POST /api/subscriptions` (`webhookUrl` must be `https://`, allowing `http://127.0.0.1` / `http://localhost` ONLY in emulator/test mode; `authType: 'bearer' | 'hmac'`, `secret`, `filters: { eventTypes, tags?, statuses?, assignedUserIds?, mentionedUserIds? }`)
  - `PATCH /api/subscriptions/:id` (toggle `active`, update filters, rotate `secret`)
  - `DELETE /api/subscriptions/:id`
- Delivery engine (`apps/api/src/services/webhookDispatcher.ts`):
  - Filter matcher: verifies `sub.active`, `event.visibleToUserIds.includes(sub.ownerUserId)`, `eventTypes` match, and any configured `tags`, `statuses`, `assignedUserIds`, or `mentionedUserIds` intersect cleanly.
  - Request headers: `Content-Type: application/json`, `X-Agent-Kanban-Event-Id: <eventId>`, `X-Agent-Kanban-Event-Type: <type>`, `X-Agent-Kanban-Timestamp: <unixSeconds>`, plus:
    - `bearer`: `Authorization: Bearer <decryptedSecret>`
    - `hmac`: `X-Agent-Kanban-Signature: t=<unixSeconds>,v1=<hex(hmac_sha256(secret, `${ts}.${rawBody}`))>`
  - Retries: On non-2xx or timeout (5s), writes a delivery retry entry (`webhookDeliveries/{eventId}_{subId}`) with `attemptCount`, `nextAttemptAt` (backoff `1m, 5m, 15m, 60m`, max 5 attempts), `lastError`, reusing the exact same `eventId`.
- Cloud Functions exports in `apps/api/src/index.ts`:
  - `onEventCreated = onDocumentCreated('events/{eventId}', ...)`
  - `retryWebhooks = onSchedule('every 1 minutes', ...)` (also callable via testable function `processDueWebhookRetries(now)`).
- Integration tests `apps/api/tests/webhooks.test.ts` with an in-process mock HTTP server.

**Validation Gate:**
```bash
pnpm --filter @agent-kanban/api build
firebase emulators:exec --project demo-agent-kanban --only functions,firestore "pnpm --filter @agent-kanban/api test:webhooks"
pnpm -r typecheck
pnpm lint
pnpm hygiene:check
```
- Pass criteria: Tests prove:
  1. Firestore `subscriptions/{id}` stores encrypted ciphertext—raw secret string never appears in the doc.
  2. `Bearer` and `HMAC` headers verify cryptographically at the mock HTTP receiver.
  3. Filtering by `eventTypes`, `tags`, `statuses`, `assignedUserIds`, `mentionedUserIds`, and card visibility delivers only matching events.
  4. Agent writes trigger **zero** webhook calls.
  5. Mock receiver returning `500` on attempt 1 schedules a retry; running `processDueWebhookRetries` after backoff delivers attempt 2 with the **exact same `eventId`** and marks delivery `succeeded`.

---

### - [x] Step M3.4: Scheduled jobs (`due_soon`/`overdue`, 30-day auto-archive, cleanup, backup) & Settings webhooks view

**Goal:** Complete scheduled time-based event generation, housekeeping jobs, and visibility of webhook subscriptions in the PWA Settings screen.

**Deliverables:**
- `apps/api/src/jobs/dueScanner.ts`: `runDueScanner(now, tz)`:
  - Scans non-archived open cards (`status in ['todo', 'doing', 'blocked']`) with non-null `due`.
  - Evaluates due instant in configured `HOUSEHOLD_TIMEZONE` (`dueHasTime` vs end-of-day).
  - Emits `card.due_soon` (within 2 days) if `dueSoonNotifiedAt == null` and sets `dueSoonNotifiedAt = now`.
  - Emits `card.overdue` (past due) if `overdueNotifiedAt == null` and sets `overdueNotifiedAt = now`.
  - Exported as Cloud Function `scanDueCards = onSchedule('every 15 minutes', ...)`.
- `apps/api/src/jobs/dailyMaintenance.ts`: `runDailyMaintenance(now)`:
  - Auto-archives non-recurring `done` cards whose `enteredStatusAt` is older than `AUTO_ARCHIVE_DAYS` (default `30`), logging `card.auto_archived` activity.
  - Deletes `events` and completed `webhookDeliveries` older than 30 days.
  - If `BACKUP_BUCKET` env var is set, triggers Firestore Admin managed export (`exportDocuments`) to `gs://<BACKUP_BUCKET>/firestore/<YYYY-MM-DD>`.
  - Exported as Cloud Function `dailyMaintenance = onSchedule('0 8 * * *', ...)` (UTC schedule; configurable).
- PWA Settings update (`apps/web/src/pages/SettingsPage.tsx`):
  - **Webhook Subscriptions** panel listing the signed-in user's subscriptions (URL, auth type, active status, filters, toggle active / delete).
- Integration tests `apps/api/tests/jobs.test.ts` + E2E check `e2e/m3-webhooks-ui.spec.ts`.

**Validation Gate:**
```bash
pnpm --filter @agent-kanban/api build
pnpm --filter @agent-kanban/web build
firebase emulators:exec --project demo-agent-kanban --only hosting,functions,firestore "pnpm --filter @agent-kanban/api test:jobs && pnpm test:e2e -- e2e/m3-webhooks-ui.spec.ts"
pnpm ci:verify
```
- Pass criteria: Tests prove `due_soon` and `overdue` fire once and never duplicate on repeat runs; editing `due` or completing a recurring card clears dedup flags; 31-day-old non-recurring `done` card archives while 29-day or recurring cards do not; 31-day-old events are pruned; Settings UI displays and toggles user's webhook subscriptions.

---

## Milestone 4: File Uploads, PWA Polish & Production Readiness

### - [x] Step M4.1: GCS signed-URL attachment API (upload/confirm/download/delete, 10 MB + MIME checks)

**Goal:** Enable secure image and PDF uploads up to 10 MB via API-minted short-lived Cloud Storage signed URLs (keeping direct Storage rules locked down).

**Deliverables:**
- `apps/api/src/handlers/attachments.ts` + routes:
  - `POST /api/cards/:id/attachments/upload-url` (`{ fileName, contentType, size }`):
    - Verifies card visibility, allowlisted MIME (`image/jpeg`, `image/png`, `image/webp`, `image/heic`, `application/pdf`), and `size <= 10 * 1024 * 1024`.
    - Mints short-lived upload URL (5 min) for `cards/{cardId}/{attachmentId}/{sanitizedFileName}` (uses GCS `getSignedUrl` in prod; supports Firebase Storage Emulator upload URL seamlessly when `FIREBASE_STORAGE_EMULATOR_HOST` is set).
    - Returns `{ attachmentId, uploadUrl, storagePath, expiresAt }`.
  - `POST /api/cards/:id/attachments/:attachmentId/confirm`:
    - Verifies the object exists in Cloud Storage and its actual stored size `<= 10 MB` and contentType is allowlisted (deletes object & rejects `400` if violated).
    - Writes `cards/{cardId}/attachments/{attachmentId}`, updates `lastTouchedAt`, logs `card.attachment_added` activity.
  - `GET /api/cards/:id/attachments` (lists card attachments).
  - `GET /api/cards/:id/attachments/:attachmentId/download-url` (verifies card visibility, mints 15-min read URL).
  - `DELETE /api/cards/:id/attachments/:attachmentId` (deletes Storage object + Firestore doc, logs activity).
- Integration tests `apps/api/tests/attachments.test.ts` against Storage + Firestore + Functions Emulators.

**Validation Gate:**
```bash
pnpm --filter @agent-kanban/api build
firebase emulators:exec --project demo-agent-kanban --only functions,firestore,storage "pnpm --filter @agent-kanban/api test:attachments"
pnpm -r typecheck
pnpm lint
pnpm hygiene:check
```
- Pass criteria: Tests prove: `>10 MB` -> `400`, disallowed MIME (`text/html`) -> `400`, unauthorized user -> `404`, full upload -> confirm -> download -> verify bytes match -> delete removes both Firestore record and Storage object.

---

### - [x] Step M4.2: PWA client-side image compression, photo/PDF upload & attachment gallery

**Goal:** Allow household users to snap/upload photos and attach PDFs directly from their phones with automatic client-side photo compression to keep Blaze Storage costs near zero.

**Deliverables:**
- `apps/web/src/lib/imageCompression.ts`: resizes images exceeding `1920px` on the longest edge and re-encodes to JPEG/WebP (`quality: 0.82`) using Canvas/OffscreenCanvas (passes PDFs through untouched, enforces 10 MB limit with clear user error message).
- Attachment UI in Card Detail (`apps/web/src/components/AttachmentSection.tsx`):
  - File picker supporting camera/photos + PDF (`accept="image/*,application/pdf"`).
  - Upload progress indicator (`Compressing...` -> `Uploading...` -> `Done`).
  - Inline image thumbnail grid (tap to open full-size via signed download URL) + PDF file rows + delete button.
- Unit test for `imageCompression.ts` + Playwright E2E test `e2e/m4-attachments.spec.ts`.

**Validation Gate:**
```bash
pnpm --filter @agent-kanban/web test
pnpm --filter @agent-kanban/web build
pnpm --filter @agent-kanban/api build
firebase emulators:exec --project demo-agent-kanban --only hosting,functions,firestore,storage "pnpm test:e2e -- e2e/m4-attachments.spec.ts"
pnpm hygiene:check
```
- Pass criteria: Unit test confirms oversized image dimensions/bytes are compressed; Playwright uploads a fixture PNG and PDF to a card, verifies thumbnail and PDF row render after reload, opens download URL cleanly, and deletes both attachments.

---

### - [x] Step M4.3: PWA installability, icons/manifest, offline banner, optimistic UX & accessibility polish

**Goal:** Polish the PWA so it feels snappy, reliable, and installable on iOS Safari and Android Chrome.

**Deliverables:**
- PWA assets in `apps/web/public/`: crisp SVG/PNG app icons (`192x192`, `512x512`, maskable `512x512`, `apple-touch-icon.png`, favicon) wired in `vite-plugin-pwa` manifest (`display: 'standalone'`, `theme_color`, `background_color`, `name: 'Agent Kanban'`).
- `index.html` Apple mobile web app meta tags (`apple-mobile-web-app-capable`, `viewport-fit=cover`, safe-area padding for bottom nav).
- Offline status banner (`navigator.onLine` listener) + clean retryable error boundary / query error states.
- Optimistic UI mutations via TanStack Query for checklist item toggles and status pill taps (rolling back cleanly on error).
- Accessibility pass: `>=44px` tap targets on mobile buttons/checkboxes, visible keyboard focus rings, ARIA labels on icon buttons, semantic landmarks (`<main>`, `<nav>`).
- Playwright E2E test `e2e/m4-pwa-polish.spec.ts`.

**Validation Gate:**
```bash
pnpm --filter @agent-kanban/web build
pnpm --filter @agent-kanban/api build
firebase emulators:exec --project demo-agent-kanban --only hosting,functions,firestore,storage "pnpm test:e2e -- e2e/m4-pwa-polish.spec.ts"
pnpm hygiene:check
```
- Pass criteria: Manifest and all referenced icons load with HTTP `200`; zero browser console errors or uncaught page errors; toggling Playwright offline mode surfaces the offline banner and restores smoothly when back online; mobile tap targets and no-horizontal-overflow assertions pass.

---

### - [x] Step M4.4: Public `README.md`, self-hosting guide, prod smoke script & full regression verification

**Goal:** Document the project cleanly for building-in-public self-hosters and verify the entire codebase end-to-end with zero warnings, leaked personal info, or skipped checks.

**Deliverables:**
- Root `README.md`:
  - Project thesis & architecture diagram (Mermaid).
  - Local development with Firebase Emulators (5-minute quickstart).
  - Self-hosting deployment guide (Firebase Blaze + WorkOS AuthKit + Secret Manager + GitHub Actions, including `HOUSEHOLD_TIMEZONE` configuration).
  - API & MCP quick reference (connecting Claude/ChatGPT via WorkOS OAuth or custom agents via API key + `X-Agent-Name` + webhook setup).
- `scripts/smoke-prod.ts`: non-destructive production smoke checker verifying `GET /api/health`, `GET /.well-known/oauth-protected-resource`, and (when `SMOKE_API_KEY` is provided) `GET /api/workspace/snapshot` returning `200`.
- Full secret & PII hygiene audit across working tree and git log.

**Validation Gate:**
```bash
pnpm ci:verify
```
- Pass criteria: Entire CI verification pipeline (`hygiene:check`, `lint`, `format:check`, `typecheck`, `shared` unit tests, `web` unit tests, `api` build, `web` build, Firestore/Storage rules tests, all API emulator suites, and full Playwright E2E suite) passes 100% cleanly with exit code `0`.

---

### - [x] Step M4.5 `[HUMAN]`: Human-guided feature walkthrough & bug-fix pass

> **AGENT STOP GATE:** Interactive QA pass led by the user. Work through one functional area at a time; fix reported bugs with regression tests, verify with `pnpm ci:verify`, and deploy/confirm each fix before checking off that area.

**Goal:** Systematically exercise every user-facing and agent-facing feature in the deployed app, capture real-world bugs and UX rough edges, and fix them with automated regression coverage before final v1 launch sign-off.

**Functional Walkthrough Areas:**
1. - [x] **Auth, Session & Access Control:** WorkOS sign-in/sign-out, reload/session persistence, unallowlisted email `403` screen, private vs shared card visibility isolation.
2. - [x] **Navigation, Mobile Layout & PWA Shell:** Mobile responsiveness (zero horizontal overflow/clipping), bottom nav (`To-Do`, `Active`, `Done`, `Settings`), FAB placement, Home Screen install/icons, offline banner, loading/error states.
3. - [x] **Board Views, Search & Filters:** `To-Do` (Top 5 + collapsible rest, priority ordering, due badges), `Active` (`Doing` + `Blocked`), `Done` (completed + archived view), search bar, tag/assignee/visibility filters.
4. - [x] **Quick-Add & Card Detail Core Editing:** Quick-Add modal defaults & sharing toggle, editing title/description/tags/assigned/aware/due/dueFirm/dueHasTime, status pills, optimistic updates, archive/unarchive, save feedback & error handling.
5. - [x] **Checklists, Links & Comments (`@mentions`):** Checklist create/rename/delete, item add/toggle/delete, link add/open/remove, comments with `@handle` mentions, Activity Log accuracy.
6. - [x] **Recurrence & Scheduled Jobs:** Cron and interval-after-completion rules, `Complete & Reset` (checklist reset + next due date in `HOUSEHOLD_TIMEZONE`), `scanDueCards` (`due_soon`/`overdue`) and `dailyMaintenance` behavior.
7. - [x] **File Attachments (Photos & PDFs):** Photo capture/upload & client-side compression, PDF upload, 10 MB/MIME error handling, thumbnail grid, signed download URL viewing, deletion (Storage + Firestore), live GCS CORS.
8. - [x] **Settings, Household Roster & Agent Connections (API Keys):** Profile info, adding/viewing household members (admin vs member), creating copy-once API keys, reload hiding secret, rotating & revoking keys, `X-Agent-Name` attribution.
9. - [x] **Webhooks, Events & MCP Integration:** Settings webhook CRUD + Pause/Enable, live `onEventCreated` delivery (`Bearer`/`HMAC`), filters & visibility isolation, agent loop suppression (zero webhooks on agent writes), `GET /api/events` polling, `/mcp` client tools.

**Bug-Fix Loop & Validation Gate:**
- For every batch of bugs fixed: add or update automated tests covering the root cause, run `pnpm ci:verify`, commit directly to `main`, push to deploy, and confirm live with the user before checking off that area (`- [x]`).
- Step M4.5 is checked off only after all 9 walkthrough areas are marked `- [x]`.

---

### - [x] Step M4.6 `[HUMAN]`: Final production verification (household PWA install + Chief of Staff live test)

> **AGENT STOP GATE:** Final human verification milestone for v1 launch.

**Manual Verification Checklist:**
1. Confirm latest `main` deployed cleanly via GitHub Actions `deploy.yml`.
2. Run `PROD_URL=https://<your-domain> pnpm exec tsx scripts/smoke-prod.ts` and confirm `200` on `/api/health` and `/.well-known/oauth-protected-resource`.
3. **Household Mobile Onboarding:**
   - Install `agent-kanban` PWA to Home Screen on household phones.
   - Create a shared card, upload a phone photo, post a comment with `@mention`, and verify other household members see it.
   - Create a recurring card (e.g., weekly groceries/chores) and verify completion resets checklist items and advances the due date in your configured `HOUSEHOLD_TIMEZONE`.
4. **Chief of Staff Integration:**
   - Create an API key in Settings (or connect via WorkOS MCP OAuth).
   - Register a `card.created` webhook subscription to your agent harness.
   - Create a new card as a human -> confirm webhook fires once -> agent scores the card via `PATCH /api/cards/priorities` or MCP -> confirm activity logs `"Chief of Staff via <platform> (agent)"` and **no** follow-up webhook loop triggers.
5. Verify Firebase/GCP billing console shows budget alert active at $5/mo and minimal idle cost.

**Validation Gate:**
- All 5 checklist items confirmed working live in production; ready to begin M5 (Parallel Run with Trello).

---

## Milestone 5: Shared Tag Vocabulary, Case Normalization & Tag Management (v1.1)

### - [x] Step M5.1: Tag normalization, dynamic `GET /api/tags`, bulk tag rename/merge API, MCP `list_tags` & snapshot vocabulary

**Goal:** Eliminate tag drift across humans and BYOA agents by normalizing tags to trimmed lowercase on write, exposing a single visibility-scoped tag vocabulary via REST, MCP, and `workspaceSnapshot`, and keeping pre-v1.1 mixed-case docs compatible.

**Deliverables:**
- `packages/shared/src/schemas/common.ts` & `packages/shared/src/schemas/card.ts`:
  - Add `normalizeTag(tag: string): string` (`trim().toLowerCase()`) and `normalizeTags(tags: readonly string[]): string[]` (trim, lowercase, dedupe, preserve order).
  - Normalize tags on write input schemas (`CreateCardInputSchema`, `UpdateCardInputSchema`, `BulkCardUpdateItemSchema`, `SubscriptionFiltersSchema`) while keeping `CardSchema` read-compatible with any pre-v1.1 mixed-case card documents.
- `apps/api/src/handlers/tags.ts` & `apps/api/src/routes/tags.ts` (mounted in `apps/api/src/app.ts`):
  - `GET /api/tags?includeArchived=false`: aggregates tags across the caller's visible cards (`visibleToUserIds array-contains ownerUserId`), returning `{ tags: [{ tag, openCount, totalCount, lastUsedAt }] }` sorted by `openCount DESC`, `totalCount DESC`, `tag ASC` (case-insensitively normalized).
  - `POST /api/tags/rename`: accepts `{ fromTag, toTag: string | null, note? }` + `Idempotency-Key`. Matches `fromTag` case-insensitively across all visible cards; if `toTag` is a non-empty normalized tag, renames/merges `fromTag` -> `toTag` (deduplicating tags); if `toTag === null`, removes `fromTag`. Refreshes `searchTokens`, writes `activity`, and respects agent loop suppression.
- `apps/api/src/handlers/cards.ts` & `apps/api/src/handlers/priorities.ts`:
  - Normalize tags on create/update/bulk writes; make `GET /api/cards?tag=...` match case-insensitively.
  - Add `tags: Array<{ tag: string; openCount: number }>` summary to `WorkspaceSnapshotResult`.
- `apps/api/src/mcp/server.ts`: register `list_tags` tool wrapping `listTagsHandler`.
- `apps/api/src/services/webhookDispatcher.ts`: make `filters.tags` comparison in `matchesSubscription` case-insensitive so pre-v1.1 mixed-case cards match lowercase subscriptions.
- Tests: update `packages/shared/src/__tests__/schemas.test.ts` and `apps/api/src/__tests__/webhooks.unit.test.ts`; add `apps/api/tests/tags.test.ts` (plus `"test:tags"` script in `apps/api/package.json`).

**Validation Gate:**
```bash
pnpm --filter @agent-kanban/shared test
pnpm --filter @agent-kanban/api test
pnpm --filter @agent-kanban/api build
firebase emulators:exec --project demo-agent-kanban --only functions,firestore "pnpm --filter @agent-kanban/api test:tags && pnpm --filter @agent-kanban/api test:mcp"
pnpm -r typecheck
pnpm lint
pnpm hygiene:check
```
- Pass criteria: Normalization deduplicates `"Groceries"` and `"groceries"`; `GET /api/tags` only includes tags from caller's visible cards; `POST /api/tags/rename` merges/deletes across visible cards without touching another user's private cards; MCP `list_tags` and `get_workspace_snapshot` return the expected tag counts; webhook tag matching works across mixed-case cards.
- If it fails: Inspect `packages/shared/src/schemas/common.ts` normalization transforms and `apps/api/src/handlers/tags.ts` visibility query filter (`visibleToUserIds array-contains`).

---

### - [ ] Step M5.2: Reusable `TagPicker` autocomplete, case-insensitive filters & Settings Tag Manager

**Goal:** Make reusing existing tags effortless everywhere in the PWA and give household users a clean Settings tool to clean up or merge legacy tags.

**Deliverables:**
- `apps/web/src/lib/api.ts`: add `TagSummary` client calls `fetchTags` (`GET /api/tags`) and `renameTag` (`POST /api/tags/rename`).
- `apps/web/src/components/TagPicker.tsx`: accessible chip-based tag input with instant typeahead dropdown populated by `['tags']` query (frequency-sorted), keyboard navigation (`ArrowDown`/`ArrowUp`/`Enter`/`,`/`Backspace` to remove last chip), one-tap chip suggestions for top unused tags, inline creation of new lowercase-normalized tags, and clean wrapping on `390px` mobile.
- Wire `TagPicker` into `apps/web/src/components/QuickAddModal.tsx` and `apps/web/src/pages/CardDetailPage.tsx` (replacing raw comma-separated inputs).
- `apps/web/src/hooks/useFilteredCards.ts`: normalize tag filter comparison case-insensitively and ensure card/tag mutations invalidate `['tags']`.
- `apps/web/src/pages/SettingsPage.tsx`: add a **Tags** section listing household tags with open/total counts and **Rename / Merge** + **Remove** actions (with confirmation and status feedback).
- Tests: unit test for `TagPicker` / tag helpers in `apps/web/src/__tests__/tagPicker.test.ts`; Playwright E2E `e2e/m5-tags.spec.ts` (and update `e2e/m1-card-lifecycle.spec.ts` where it previously targeted the `'Tags (comma-separated)'` label so it enters the tag via `TagPicker` cleanly without weakening assertions).

**Validation Gate:**
```bash
pnpm --filter @agent-kanban/web test
pnpm --filter @agent-kanban/web build
pnpm --filter @agent-kanban/api build
firebase emulators:exec --project demo-agent-kanban --only hosting,functions,firestore "pnpm test:e2e -- e2e/m5-tags.spec.ts"
pnpm hygiene:check
```
- Pass criteria: E2E proves creating a card with `#groceries`, reusing `#groceries` via `TagPicker` autocomplete in Quick-Add and Card Detail, renaming/merging a tag in Settings updates matching visible cards, and `390x844` mobile layout has zero horizontal overflow.
- If it fails: Check React Query cache invalidation keys (`['tags']`, `['cards']`, `['card', id]`) and `TagPicker` dropdown focus/blur handling inside `<dialog>`.

---

## Milestone 6: Snooze (`deferUntil`), Recurring Auto-Defer, Schedule View & Priority Nudges (v1.1)

### - [x] Step M6.1: Shared schemas & helpers — `pinned`, `deferUntil`, `lastCompletedAt`, `autoDefer`/`leadDays`, `projectNextOccurrences` & v1.1 event types

**Goal:** Establish deterministic, thoroughly unit-tested shared types and date/recurrence projection logic before changing API handlers or UI.

**Deliverables:**
- `packages/shared/src/schemas/card.ts`:
  - Add `pinned: z.boolean().default(false)`, `deferUntil: IsoDateTimeSchema.nullable().default(null)`, and `lastCompletedAt: IsoDateTimeSchema.nullable().default(null)` to `CardSchema` (all defaulted for 100% backwards compatibility with existing v1 Firestore docs).
  - Add `pinned` and `deferUntil` to `CreateCardInputSchema` and `UpdateCardInputSchema`.
  - Add optional `autoDefer: z.boolean().optional()` and `leadDays: z.number().int().min(0).max(365).optional()` to both `CronRecurrenceSchema` and `IntervalRecurrenceSchema`.
  - Add `RescoreCardInputSchema` (`ifUpdatedAt?`, `note?`).
- `packages/shared/src/schemas/agent.ts`:
  - Add `'card.unsnoozed'`, `'card.rescore_requested'`, and `'cards.bulk_updated'` to `EventTypeSchema`.
  - Update `EventSchema.cardId` to `EntityIdSchema.nullable()` (`string` for single-card events, `null` for multi-card batch events).
- `packages/shared/src/utils/dates.ts`: add `isCardDeferred(card: Pick<Card, 'deferUntil'>, now: Date): boolean`.
- `packages/shared/src/utils/recurrence.ts`:
  - Add `resolveDefaultLeadDays(recurrence, nextDueIso, completedAt, defaultTz)`: smart cadence default (`0` days for daily / `< 7` days, `1` day before for weekly / `7–13` days, `3` days before for monthly / `>= 14` days).
  - Add `computeRecurrenceDeferUntil(recurrence, nextDueIso, completedAt, defaultTz, options?)`: returns `null` if `recurrence.autoDefer === false` or if computed wake-up instant `<= completedAt`; otherwise computes DST-aware start-of-day in `tz` for `nextDue - leadDays`.
  - Add `projectNextOccurrences(recurrence, fromDate, currentDue, count, defaultTz, options?)`: projects upcoming occurrences for `cron` schedules and returns the next scheduled/estimated due for `interval_after_completion`.
- Unit tests in `packages/shared/src/__tests__/recurrence.test.ts`, `dates.test.ts`, and `schemas.test.ts` (covering DST spring-forward/fall-back, `autoDefer: false`, explicit `leadDays`, cadence defaults, and legacy v1 card fixture parsing without v1.1 fields).

**Validation Gate:**
```bash
pnpm --filter @agent-kanban/shared test
pnpm -r typecheck
pnpm lint
pnpm hygiene:check
```
- Pass criteria: All unit tests pass; legacy v1 card documents without `pinned`/`deferUntil`/`lastCompletedAt` parse cleanly with expected defaults; `computeRecurrenceDeferUntil` and `projectNextOccurrences` handle DST transitions accurately.
- If it fails: Inspect Luxon timezone conversions in `packages/shared/src/utils/recurrence.ts` and verify `EventSchema.cardId` nullability does not break existing callers.

---

### - [x] Step M6.2: API, MCP & cron — pinned-first `To-Do` sort, deferred filtering, recurring auto-defer, rescore, recurring query, `dueScanner` wake-up & Firestore index

**Goal:** Implement backend support for snoozing (`deferUntil`), recurring auto-defer and schedule projections, `pinned` & `rescore` priority nudges, and scheduled wake-up events.

**Deliverables:**
- `firebase/firestore.indexes.json`: add composite index on `cards`: `(archived ASC, deferUntil ASC)`.
- `apps/api/src/handlers/cards.ts`:
  - Update `compareTodoCards`: sort `pinned DESC` (`true` before `false`), then `priorityScore DESC` (nulls last), `due ASC` (nulls last), `createdAt ASC`, `id ASC`.
  - Update `listCardsHandler`: add `includeDeferred?: 'true' | 'false'` (default `'false'` when querying `status=todo`, `'true'` otherwise) and `hasRecurrence?: 'true' | 'false'`.
  - Update `completeCardHandler`: set `lastCompletedAt = nowIso`, clear `pinned: false`, and for recurring cards compute `deferUntil` via `computeRecurrenceDeferUntil` (clearing `deferUntil: null` on non-recurring completion).
  - Update `archiveCardHandler`: clear `pinned: false` and `deferUntil: null` when archiving.
  - Add `rescoreCardHandler` (`POST /api/cards/:id/rescore` in `apps/api/src/routes/cards.ts`): clears `priorityScore: null`, `priorityReason: null`, logs `card.rescore_requested` activity, and emits `card.rescore_requested` domain event (still suppressed for `actorType === 'agent'`).
  - Add `listRecurringCardsHandler` (`GET /api/cards/recurring?horizonDays=60`): returns visible non-archived recurring cards (with `nextOccurrences[]`, `cadence`, `effectiveLeadDays`) plus currently deferred non-recurring cards so the `Schedule` view loads in a single request.
- `apps/api/src/handlers/priorities.ts`:
  - Update `workspaceSnapshotHandler`: exclude cards with `deferUntil > now` from active `cards[]`, return them in `deferredCards[]`, include `counts.deferred` & `counts.recurring`, and include `pinned` on every card (`bulkUpdatePrioritiesHandler` must preserve `pinned` untouched).
  - Update `smartQueryCardsHandler`: exclude deferred cards from `stale_in_todo_days` and add `upcoming_recurring` query support.
- `apps/api/src/jobs/dueScanner.ts`:
  - Run wake-up pass first: query `archived == false` and `deferUntil > ''` and `deferUntil <= nowIso`; inside a transaction, clear `deferUntil: null`, update `enteredStatusAt: nowIso` & `updatedAt: nowIso`, and emit a system `card.unsnoozed` event (at most once per snooze cycle).
  - In the `due_soon`/`overdue` pass, skip `card.due_soon` while a card remains deferred (`deferUntil > nowIso`) so deferred cards only notify once awake or if actually overdue.
- `apps/api/src/mcp/server.ts`: register `list_recurring_cards` and `request_card_rescore`; update `list_cards` (`includeDeferred`, `hasRecurrence`), `create_card`/`update_card` (`pinned`, `deferUntil`), and `smart_query_cards`.
- `apps/web/src/pages/SettingsPage.tsx`: add `'card.unsnoozed'`, `'card.rescore_requested'`, and `'cards.bulk_updated'` options to webhook subscription event-type checkboxes.
- Tests: add `apps/api/tests/schedule-nudges.test.ts` (`"test:schedule"` script in `apps/api/package.json`) and update `apps/api/tests/jobs.test.ts` & `apps/api/tests/mcp.test.ts`.

**Validation Gate:**
```bash
pnpm --filter @agent-kanban/api build
firebase emulators:exec --project demo-agent-kanban --only functions,firestore "pnpm --filter @agent-kanban/api test:schedule && pnpm --filter @agent-kanban/api test:jobs && pnpm --filter @agent-kanban/api test:mcp && pnpm --filter @agent-kanban/api test:cards && pnpm --filter @agent-kanban/api test:prioritization"
pnpm -r typecheck
pnpm lint
pnpm hygiene:check
```
- Pass criteria: Tests prove pinned cards sort above score-100 cards and auto-unpin on complete/archive; completing a recurring card sets `lastCompletedAt` and `deferUntil` per `leadDays`/cadence default; deferred cards are omitted from default `To-Do` and placed in `workspaceSnapshot.deferredCards`; `runDueScanner` wakes elapsed deferred cards once with `card.unsnoozed`; `POST /api/cards/:id/rescore` emits `card.rescore_requested` for humans and suppresses it for agents.
- If it fails: Verify route ordering in `apps/api/src/routes/cards.ts` (`/cards/recurring` must be registered before `/cards/:id`) and check Firestore index queries in `dueScanner.ts`.

---

### - [ ] Step M6.3 `[HUMAN]`: Cloud deploy-and-verify gate (Firestore `deferUntil` index & updated `scanDueCards` cron)

> **AGENT STOP GATE:** Cloud deploy boundary per `cloud-deploy-gates`. Do not build M6.4 UI layers on top until the new Firestore index and scheduled function are verified live in production.

**Manual Setup & Verification Checklist:**
1. Push `main` and confirm GitHub Actions `ci.yml` and `deploy.yml` succeed.
2. In Firebase Console -> Firestore -> Indexes, confirm the new composite index on `cards` (`archived ASC`, `deferUntil ASC`) finished building and shows status **Enabled**.
3. Trigger or inspect `scanDueCards` in Cloud Scheduler / Cloud Functions logs and confirm clean execution with zero `FAILED_PRECONDITION` (missing index) or IAM errors.
4. Run:
   ```bash
   PROD_URL=https://<your-domain> SMOKE_API_KEY=<key> pnpm exec tsx scripts/smoke-prod.ts
   ```
   and confirm `GET /api/workspace/snapshot` returns HTTP `200` including `tags` and `deferredCards`.
5. Record any index build time or deployment notes in `docs/DEPLOYMENT_SETUP.md`.

**Validation Gate:**
- All 5 checklist items confirmed live in production with zero missing-index errors.

---

### - [x] Step M6.4: PWA 5th `Schedule` tab, recurrence `leadDays` editor, Snooze, Pin & Request AI Rescore UI

**Goal:** Give household humans full visibility into upcoming recurring and snoozed tasks plus zero-friction priority steering in the PWA.

**Deliverables:**
- `apps/web/src/components/AppShell.tsx`: update bottom navigation to 5 tabs (`grid-cols-5`): `To-Do` (`/`), `Active` (`/active`), `Schedule` (`/schedule`), `Done` (`/done`), `Settings` (`/settings`), preserving `>=44px` tap targets and zero horizontal overflow on `390x844`.
- `apps/web/src/lib/api.ts`: add client helpers for `fetchRecurringSchedule` (`GET /api/cards/recurring`), `rescoreCard` (`POST /api/cards/:id/rescore`), and `pinned`/`deferUntil` fields.
- `apps/web/src/pages/SchedulePage.tsx`:
  - Segmented toggle: **Upcoming** | **All Recurring**.
  - **Upcoming** mode: timeline grouped into *Due / Active Now*, *Next 7 Days*, *Next 30 Days*, and *Later* (merging snoozed cards, active recurring cards, and projected future occurrences with clear *"Wakes in 3d"* / *"Snoozed until Mon"* chips and one-tap **Wake now**).
  - **All Recurring** mode: master list of every recurring card showing human-readable cadence, `lastCompletedAt` summary, next due date, wake-up / `leadDays` info, and quick **Complete & Reset** / **Wake now** actions.
- `apps/web/src/pages/TodoPage.tsx` & `apps/web/src/components/CardRow.tsx`:
  - Display a subtle link pill on `To-Do` when deferred cards exist (e.g., `"N snoozed in Schedule →"`).
  - Display a crisp **Pinned** badge on pinned cards and a subtle cadence hint on recurring cards.
- `apps/web/src/pages/CardDetailPage.tsx` & `apps/web/src/lib/recurrenceUi.ts`:
  - Add **Pin / Unpin** toggle and **Request AI Rescore** button in the top card action panel.
  - Add **Snooze / Defer until** section (quick presets + date/time picker + **Wake now**).
  - Extend the recurrence editor with **"Auto-hide until close to due"** (`autoDefer`) and **"Reappear N days before due"** (`leadDays`, showing the smart cadence default when unset).
- Tests: update `apps/web/src/__tests__/recurrenceUi.test.ts` and update the bottom-nav link count assertion in `e2e/m4-pwa-polish.spec.ts` from `4` to `5` to reflect the new `Schedule` tab; add Playwright E2E `e2e/m6-schedule-nudges.spec.ts`.

**Validation Gate:**
```bash
pnpm --filter @agent-kanban/web test
pnpm --filter @agent-kanban/web build
pnpm --filter @agent-kanban/api build
firebase emulators:exec --project demo-agent-kanban --only hosting,functions,firestore "pnpm test:e2e -- e2e/m6-schedule-nudges.spec.ts && pnpm test:e2e -- e2e/m1-views.spec.ts"
pnpm hygiene:check
```
- Pass criteria: E2E verifies 5-tab navigation at `390x844` with zero overflow, completing a recurring card moves it out of `To-Do` into `Schedule` (`Upcoming` & `All Recurring`), **Wake now** returns it immediately to `To-Do`, **Pin** promotes a card to the top of `To-Do`, and **Request AI Rescore** clears the score and triggers feedback.
- If it fails: Inspect `SchedulePage` grouping timezone boundaries and `AppShell` route matching for `/schedule`.

---

## Milestone 7: Multi-Select & Hardened Bulk Actions (v1.1)

### - [x] Step M7.1: Hardened bulk API & MCP — assignees/`deferUntil`/`pinned`/`rescoreRequested`, recurring-safe bulk complete & visibility-grouped batch events

**Goal:** Make multi-card human and agent bulk operations safe against webhook storms, visibility leaks, and accidental recurring-card breakage.

**Deliverables:**
- `packages/shared/src/schemas/card.ts`:
  - Extend `BulkCardUpdateItemSchema` with `assignedUserIds`, `addAssignedUserIds`, `removeAssignedUserIds`, `awareUserIds`, `addAwareUserIds`, `removeAwareUserIds`, `deferUntil`, `pinned`, and `rescoreRequested`.
  - Add `BulkCompleteCardsSchema` (`{ cardIds: z.array(EntityIdSchema).min(1).max(200), note?: NoteSchema }`).
- `apps/api/src/services/events.ts`:
  - Add `writeBulkEventsInTransaction` / `buildBulkEventRecords` that groups mutated cards by canonical sorted `visibleToUserIds.join(',')` key and emits **one** `cards.bulk_updated` event per visibility group (`cardId: groupCards.length === 1 ? groupCards[0].id : null`, `payload: { cardIds, count, tags, statuses, assignedUserIds, actionSummary, rescoreRequested }`), enforcing `actorType === 'agent'` suppression and zero private-card leakage across groups.
- `apps/api/src/handlers/priorities.ts` & `apps/api/src/routes/cards.ts`:
  - Update `bulkUpdateCardsHandler`: apply assignee/aware deltas (recomputing `visibleToUserIds` and rejecting empty visibility), `deferUntil`, `pinned`, `rescoreRequested` (clearing `priorityScore`/`priorityReason`), lowercase-normalized tags, and emit visibility-grouped `cards.bulk_updated` events instead of `N` per-card `card.updated` events. Reject `status: 'done'` on a recurring card with `400` directing callers to `POST /api/cards/bulk/complete`.
  - Add `bulkCompleteCardsHandler` (`POST /api/cards/bulk/complete`): atomic idempotent transaction running the full recurring in-place reset + `computeRecurrenceDeferUntil` + checklist uncheck + `lastCompletedAt` for recurring cards, marking non-recurring cards `done` + `lastCompletedAt`, clearing `pinned: false`, logging per-card `card.completed` activity, and emitting visibility-grouped `cards.bulk_updated` (`actionSummary: 'completed'`, `completedCardIds`, `recurringResetCardIds`).
- `apps/api/src/services/webhookDispatcher.ts`: support `cards.bulk_updated` in `matchesSubscription` (tags, statuses, assignedUserIds).
- `apps/api/src/mcp/server.ts`: register `bulk_complete_cards` and update `bulk_update_cards` schema.
- Tests: add `apps/api/tests/bulk-safety.test.ts` (`"test:bulk"` script in `apps/api/package.json`) covering mixed-visibility batch event isolation, single webhook delivery on 5-card bulk edit, agent loop suppression, recurring-safe `bulk/complete`, and `PATCH /api/cards/bulk` rejecting `status: 'done'` on recurring cards.

**Validation Gate:**
```bash
pnpm --filter @agent-kanban/api build
firebase emulators:exec --project demo-agent-kanban --only functions,firestore "pnpm --filter @agent-kanban/api test:bulk && pnpm --filter @agent-kanban/api test:prioritization && pnpm --filter @agent-kanban/api test:events && pnpm --filter @agent-kanban/api test:webhooks"
pnpm -r typecheck
pnpm lint
pnpm hygiene:check
```
- Pass criteria: Bulk updating 5 shared cards by a human writes 1 `cards.bulk_updated` event (and fires 1 webhook delivery, not 5); bulk updating mixed private + shared cards emits separate visibility-scoped events so private card IDs never leak to another household member's subscription; `POST /api/cards/bulk/complete` handles mixed recurring + non-recurring selections atomically.
- If it fails: Inspect canonical visibility grouping key in `apps/api/src/services/events.ts` and `matchesSubscription` payload array handling in `webhookDispatcher.ts`.

---

### - [ ] Step M7.2: PWA Multi-Select & sticky Bulk Action Bar across all board views

**Goal:** Let desktop and mobile users select multiple tasks smoothly and apply bulk updates in one tap/click.

**Deliverables:**
- `apps/web/src/lib/api.ts`: add `bulkUpdateCards` (`PATCH /api/cards/bulk`) and `bulkCompleteCards` (`POST /api/cards/bulk/complete`) with idempotency keys.
- `apps/web/src/hooks/useCardSelection.ts`: manages selected card IDs, `Shift+Click` range selection over the current ordered list, select-all visible, route/filter reset, and mobile `selectMode` toggle.
- `apps/web/src/components/CardRow.tsx`: add accessible selection checkbox (hover-reveal on pointer devices, persistent whenever `selectedCount > 0` or `selectMode` is active; toggling checkbox or tapping row in `selectMode` selects without navigating).
- `apps/web/src/components/BulkActionBar.tsx`: sticky floating toolbar above bottom nav showing `"N selected"`, **Select All / Clear**, and actions: **Status**, **Complete**, **Archive / Unarchive**, **Tags (`+`/`-`)**, **Assign**, **Due / Snooze**, **Pin**, and **Rescore**.
- Wire multi-select + mobile `Select` toggle button into `TodoPage.tsx`, `ActivePage.tsx`, `SchedulePage.tsx`, and `DonePage.tsx`.
- Tests: unit test `apps/web/src/__tests__/useCardSelection.test.ts`; Playwright E2E `e2e/m7-multiselect.spec.ts` (desktop `Shift+Click` + `390x844` mobile `Select` mode).

**Validation Gate:**
```bash
pnpm --filter @agent-kanban/web test
pnpm --filter @agent-kanban/web build
pnpm --filter @agent-kanban/api build
firebase emulators:exec --project demo-agent-kanban --only hosting,functions,firestore "pnpm test:e2e -- e2e/m7-multiselect.spec.ts"
pnpm hygiene:check
```
- Pass criteria: E2E verifies `Shift+Click` range selection, bulk tag add via `TagPicker`, bulk status change, and bulk archive/complete across desktop and `390x844` mobile without horizontal overflow.
- If it fails: Check `<Link>` click event propagation in `CardRow.tsx` (`stopPropagation` + `preventDefault` on checkbox wrapper) and sticky `z-index` layering above bottom nav.

---

## Milestone 8: Trello-Inspired Desktop Shortcuts, Quick-Edit Popovers & `Cmd+K` Command Palette (v1.1)

### - [ ] Step M8.1: Keyboard shortcut engine, list cursor (`j`/`k`/`x`/`Enter`/`Esc`), Trello hotkeys, `g`+tab nav & Undo toast

**Goal:** Enable rapid mouse-free navigation and instant card triage on desktop while keeping typing inside inputs/modals completely safe.

**Deliverables:**
- `apps/web/src/lib/shortcuts.ts`: declarative Trello-inspired keymap registry and `isEditableTarget(target)` guard (ignores events inside `<input>`, `<textarea>`, `<select>`, `[contenteditable="true"]`, or inside open dialogs except `Esc` and `Cmd+K`).
- `apps/web/src/components/ToastProvider.tsx`: accessible toast stack supporting an **Undo** action button (used by instant `c` archive/unarchive, status change, pin toggle, and non-recurring complete).
- `apps/web/src/hooks/useListKeyboardNav.ts`: manages `focusedCardId` across list pages (syncs with mouse hover + `j`/`k`/`ArrowDown`/`ArrowUp` with `scrollIntoView`), `x` to toggle selection, `Enter`/`o` to open Card Detail, and `Esc` to close popovers -> clear selection -> clear focus.
- `apps/web/src/hooks/useGlobalShortcuts.ts`:
  - Navigation chords (`g` then `t`/`a`/`r`/`d`/`s` -> To-Do / Active / Schedule / Done / Settings within 800ms), `n` to open Quick-Add (`Cmd+Enter`/`Ctrl+Enter` submits Quick-Add), `/` to focus `FilterBar` search input, `?` to toggle shortcuts cheatsheet.
  - Instant single-key actions (`c` archive/unarchive, `Space` toggle assign-to-me, `p` pin/unpin, `r` request AI rescore, `Shift+Enter`/`v` complete/reset) acting on: multi-selection (`selectedIds.size > 0`), else focused/hovered list card, else current card on `CardDetailPage`.
- Tests: unit tests in `apps/web/src/__tests__/shortcuts.test.ts`; Playwright E2E `e2e/m8-shortcuts.spec.ts`.

**Validation Gate:**
```bash
pnpm --filter @agent-kanban/web test
pnpm --filter @agent-kanban/web build
pnpm --filter @agent-kanban/api build
firebase emulators:exec --project demo-agent-kanban --only hosting,functions,firestore "pnpm test:e2e -- e2e/m8-shortcuts.spec.ts"
pnpm hygiene:check
```
- Pass criteria: E2E proves `j`/`k` cursor navigation, `x` selection, `n` Quick-Add (`Cmd+Enter` submit), `c` archive + **Undo** toast restore, `Space` self-assign toggle, `p` pin toggle, `g`+`r` Schedule navigation, `/` search focus, and zero shortcut firing while typing in search/comment/title inputs.
- If it fails: Inspect `isEditableTarget` checks (including Shadow/dialog focus) and `e.preventDefault()` on `Space` so the page does not scroll on `Space` over a focused card.

---

### - [ ] Step M8.2: Inline quick-edit popovers (Status, Members, Tags, Due, Snooze), `Cmd+K` Command Palette & `?` Cheatsheet

**Goal:** Deliver full Trello/Linear-speed inline editing (`s`, `m`, `l`, `d`, `h`) without opening Card Detail or clicking Save, plus a `Cmd+K` command palette and `?` help modal.

**Deliverables:**
- `apps/web/src/components/QuickActionPopover.tsx`: keyboard-navigable quick-edit popovers triggered by `s` (Status: `To-Do` / `Doing` / `Blocked` / `Complete`), `m` (Members: toggle `assignedUserIds` / `awareUserIds`), `l` (Labels/Tags via `TagPicker`), `d` (Due date: `Today`, `Tomorrow`, `Next Week`, `Clear`, `Firm` toggle, date picker), and `h` (Snooze `deferUntil`: `Tomorrow AM`, `Next Monday`, `+7 days`, `Custom`, `Wake now`). Works uniformly on multi-selection (via bulk API), focused/hovered list row, and open `CardDetailPage` (persisting immediately).
- `apps/web/src/components/CommandPalette.tsx`: `Cmd+K` / `Ctrl+K` fuzzy command palette supporting:
  - Actions on active target card(s) (Status, Complete, Archive, Members, Tags, Due, Snooze, Pin, Rescore)
  - Route navigation & Quick-Add
  - Live card search (`GET /api/cards/search`) to jump straight to any card
- `apps/web/src/components/ShortcutsHelpModal.tsx`: `?` cheatsheet modal grouped by Navigation, Selection, and Card Actions (also accessible from Settings / subtle desktop header button).
- Tests: Playwright E2E `e2e/m8-palette-popovers.spec.ts` exercising an end-to-end keyboard-only triage flow.

**Validation Gate:**
```bash
pnpm --filter @agent-kanban/web test
pnpm --filter @agent-kanban/web build
pnpm --filter @agent-kanban/api build
firebase emulators:exec --project demo-agent-kanban --only hosting,functions,firestore "pnpm test:e2e -- e2e/m8-palette-popovers.spec.ts"
pnpm hygiene:check
```
- Pass criteria: E2E completes a full keyboard-only workflow (`j` -> `l` add tag -> `d` set due -> `m` assign -> `h` snooze -> `Cmd+K` jump to `Schedule` -> wake -> `c` archive -> Undo -> `?` help) with zero console errors.
- If it fails: Inspect focus return after closing popovers/command palette and optimistic cache invalidation after inline `CardDetailPage` edits.

---

## Milestone 9: Desktop Horizontally Scrollable Kanban Board (v1.1)

### - [ ] Step M9.1: Desktop `Board | List` mode, horizontally scrollable Kanban columns, inline column Quick-Add & Card Detail slide-over drawer

**Goal:** Give desktop (`>= 1024px`) users a full-width horizontally scrollable Trello-style Kanban board while keeping mobile (`< 1024px`) strictly on the single-column PWA tabs.

**Deliverables:**
- `apps/web/src/hooks/useDesktopBoardMode.ts`: media-query hook (`(min-width: 1024px)`) + `localStorage` preference (`agent-kanban:desktop-view`, default `'board'`), hotkey `b` toggle (`Board | List`), always returning `'list'` below `1024px`.
- `apps/web/src/components/AppShell.tsx`:
  - Add desktop-only (`hidden lg:inline-flex`) **Board | List** segmented toggle in the header (plus desktop nav links for `Schedule`, `Settings`, and `?` shortcuts when in Board mode).
  - Expand `<main>` container from `max-w-xl` to full viewport width (`max-w-none`) only while Desktop Board view is active; keep `Schedule`, `Settings`, and `< 1024px` List views cleanly constrained.
  - Support React Router `backgroundLocation` state so clicking a card from Desktop Board renders `CardDetailDrawer` (`/cards/:id` slide-over drawer on top of the mounted board, `Esc` closes back to exact board scroll & filters) while direct navigation or page reload renders full `CardDetailPage`.
- `apps/web/src/pages/KanbanBoardPage.tsx` & `apps/web/src/components/KanbanColumn.tsx`:
  - Sticky top filter bar (`Search`, `Person`, `Tags` chips, `Show Snoozed` column toggle, `Select` / bulk toolbar integration) filtering all columns live.
  - Full-width horizontal scroll container (`flex gap-4 overflow-x-auto pb-4`) with fixed-width (`w-80 shrink-0`) independently vertically scrollable columns:
    1. **To-Do**: Pinned + Top 5 cards above a crisp visual Top-5 divider, with remaining `To-Do` cards collapsible/expandable underneath.
    2. **Doing**: Active in-progress cards.
    3. **Blocked**: Blocked cards.
    4. **Done**: Recent non-archived completed cards with an `"Include archived"` toggle in the column header.
    5. **Snoozed** (optional, toggled from filter bar): Deferred cards (`deferUntil > now`) with wake-up chips and one-click **Wake now**.
  - Compact Kanban card rendering (`CardRow` variant or `KanbanCard`) preserving priority badge, `priorityReason` preview, due/firm chip, checklist/comment/recurrence/pinned indicators, tags, avatars, and multi-select checkbox.
  - Trello-style inline `+ Add a card` composer at the bottom of `To-Do`, `Doing`, and `Blocked`: autofocus textarea/input, `Enter` creates immediately (`assignedUserIds: [currentUser]`, "Share with household" ON adding other household members to `awareUserIds`, inherits active tag filter if set), `Esc` cancels, plus a `"More options…"` button that opens `QuickAddModal` pre-filled with the draft title, column status, and active tag filter.
- `apps/web/src/components/CardDetailDrawer.tsx`: accessible slide-over dialog/drawer wrapping `CardDetailPage` content over the live Kanban board with click-outside and `Esc` close.
- Tests: unit test `apps/web/src/__tests__/useDesktopBoardMode.test.ts`; Playwright E2E `e2e/m9-kanban-board.spec.ts` (testing `1440x900` desktop default Board, horizontal scroll, Top-5 divider, inline column Quick-Add, slide-over drawer preserving board state + reload opening full `/cards/:id`, `Board | List` toggle + `b` hotkey, and verifying `390x844` mobile hides the Board toggle and stays on List tabs with zero overflow).

**Validation Gate:**
```bash
pnpm --filter @agent-kanban/web test
pnpm --filter @agent-kanban/web build
pnpm --filter @agent-kanban/api build
firebase emulators:exec --project demo-agent-kanban --only hosting,functions,firestore "pnpm test:e2e -- e2e/m9-kanban-board.spec.ts && pnpm test:e2e -- e2e/m1-views.spec.ts"
pnpm hygiene:check
```
- Pass criteria: At `1440x900`, `/` defaults to the horizontally scrollable Kanban board with all 4 status columns (+ toggleable `Snoozed`), inline column Quick-Add persists cards into the right status with household sharing ON, clicking a card opens the slide-over drawer without losing filters/scroll, and at `390x844` the Board toggle is absent and mobile List tabs work with zero horizontal overflow.
- If it fails: Inspect React Router `location.state?.backgroundLocation` wiring in `AppShell.tsx` and ensure `QuickAddModal` accepts optional initial `status`, `initialTitle`, and `initialTags` props.

---

### - [ ] Step M9.2: Cross-column Drag-and-Drop & 2D Kanban Keyboard Navigation

**Goal:** Enable smooth Trello-style cross-column dragging (respecting multi-select, recurring resets, and snooze) alongside full 2D keyboard navigation and Trello shortcuts on the Kanban board.

**Deliverables:**
- Cross-column Drag-and-Drop (`apps/web/src/components/KanbanBoardDnd.tsx` or integrated into `KanbanBoardPage.tsx` / `KanbanColumn.tsx`, using `@dnd-kit/core` or clean pointer/HTML5 DnD with clear drop-zone highlight and drag preview badge showing `"Moving N cards"` when dragging a multi-selection):
  - Dropping onto `To-Do` / `Doing` / `Blocked` updates status (via single or `PATCH /api/cards/bulk`); if dragged out of `Snoozed`, also clears `deferUntil: null` (waking the card).
  - Dropping onto `Done` calls `POST /api/cards/:id/complete` (or `POST /api/cards/bulk/complete` for multi-selection) so recurring cards run their atomic in-place reset + auto-defer (with toast notification explaining the reset) and non-recurring cards move to `Done` (with Undo toast).
  - Dropping onto `Snoozed` opens the Snooze (`h`) preset popover targeting the dragged card(s).
  - No fake within-column vertical drag reordering (preserving AI `priorityScore` + `pinned` ordering).
- 2D Keyboard Navigation & Trello Shortcuts on Board (`apps/web/src/hooks/useKanbanKeyboardNav.ts` integrated with `useGlobalShortcuts` & `QuickActionPopover`):
  - `ArrowLeft` / `ArrowRight` move focus across visible columns (explicitly avoiding conflict with `h` Snooze and `l` Labels).
  - `j` / `k` / `ArrowDown` / `ArrowUp` move focus vertically within the active column (auto-scrolling column & horizontal board container into view).
  - `Shift+ArrowLeft` / `Shift+ArrowRight` (and `[` / `]`) move the focused/selected card(s) to the adjacent status column (calling recurring-safe `complete` when moving into `Done`).
  - Mouse hover syncs focus just like Trello desktop, so hovering any Kanban card and pressing `c`, `m`, `l`, `d`, `s`, `h`, `p`, `r`, `Space`, `x`, or `Enter` acts immediately.
- Update `ShortcutsHelpModal.tsx` and `CommandPalette.tsx` to include `b` (Toggle Board/List), `ArrowLeft`/`ArrowRight` (switch column), and `[` / `]` (move card across columns).
- Tests: Playwright E2E `e2e/m9-kanban-dnd-keys.spec.ts` proving drag-and-drop across `To-Do -> Doing -> Done` (including a recurring card resetting & deferring instead of sitting in `Done`), multi-select drag of 2 cards, drag into/out of `Snoozed`, and 2D keyboard navigation (`ArrowRight`, `j`, `]`, `l`, `c` + Undo).

**Validation Gate:**
```bash
pnpm --filter @agent-kanban/web test
pnpm --filter @agent-kanban/web build
pnpm --filter @agent-kanban/api build
firebase emulators:exec --project demo-agent-kanban --only hosting,functions,firestore "pnpm test:e2e -- e2e/m9-kanban-dnd-keys.spec.ts"
pnpm hygiene:check
```
- Pass criteria: Dragging a recurring card onto `Done` triggers in-place reset + auto-defer (never stuck in `Done`); dragging 2 selected cards moves both in one bulk call; `ArrowLeft`/`ArrowRight` + `j`/`k` + `[` / `]` + hover hotkeys work without interfering with `h` (Snooze) or `l` (Labels).
- If it fails: Verify DnD handlers ignore drags started on interactive checkboxes/buttons inside cards and confirm `Done` drop always routes through `completeCard` / `bulkCompleteCards`.

---

## Milestone 10: v1.1 Docs, Full Regression & Live Walkthrough (v1.1)

### - [ ] Step M10.1: Full v1.1 E2E regression (`pnpm ci:verify`) & repository docs update

**Goal:** Update all repository documentation with verified v1.1 features, APIs, MCP tools, indexes, and keyboard shortcuts, and pass the entire CI suite cleanly.

**Deliverables:**
- Update `README.md`:
  - Document v1.1 capabilities (`TagPicker` & shared tag vocabulary, `Schedule` view & recurring auto-defer, snooze/`deferUntil`, `pinned` & AI rescore nudges, multi-select bulk actions, Trello-style desktop shortcuts & `Cmd+K` palette, and Desktop Horizontally Scrollable Kanban Board with drag-and-drop & 2D keyboard navigation).
  - Update REST API & MCP tool tables (`GET /api/tags`, `POST /api/tags/rename`, `GET /api/cards/recurring`, `POST /api/cards/:id/rescore`, `POST /api/cards/bulk/complete`, `list_tags`, `list_recurring_cards`, `request_card_rescore`, `bulk_complete_cards`) and new webhook event types (`card.unsnoozed`, `card.rescore_requested`, `cards.bulk_updated`).
  - Add desktop keyboard shortcut reference table (including `b`, `ArrowLeft`/`ArrowRight`, and `[` / `]`).
- Update `docs/PRD.md` and `docs/DEPLOYMENT_SETUP.md` (index notes & v1.1 rollout notes).

**Validation Gate:**
```bash
pnpm ci:verify
```
- Pass criteria: Full `pnpm ci:verify` (`hygiene:check`, `lint`, `format:check`, `typecheck`, unit tests, builds, Firestore/Storage rules tests, all API emulator suites, and all Playwright E2E tests) passes with exit code `0`.
- If it fails: Root-cause any regression in the failing suite before checking off M10.1.

---

### - [ ] Step M10.2 `[HUMAN]`: Human-guided v1.1 live feature walkthrough & bug-fix pass

> **AGENT STOP GATE:** Interactive QA pass led by the user against production. Work through one functional area at a time; fix any bugs with regression tests, run `pnpm ci:verify`, deploy, and confirm live before checking off each area.

**Functional Walkthrough Areas:**
1. - [ ] **Tag Reuse, Normalization & Tag Manager:** `TagPicker` autocomplete in Quick-Add & Card Detail, lowercase normalization, `GET /api/tags` / MCP `list_tags`, Settings tag rename/merge/delete.
2. - [ ] **Snooze (`deferUntil`), Recurring Auto-Defer & Wake-Up Cron:** Completing recurring cards auto-defers with cadence defaults / custom `leadDays` / "Never auto-defer", manual snooze + Wake now, live 15-min `scanDueCards` wake-up emitting `card.unsnoozed`.
3. - [ ] **Schedule Tab (`Upcoming` & `All Recurring`):** 5-tab mobile & desktop layout (`390px` overflow check), Upcoming timeline groupings + projected occurrences, All Recurring master list (`lastCompletedAt`, cadence, quick actions).
4. - [ ] **Human Priority Nudges (Pin & Request AI Rescore):** Pinned cards stay at top of `To-Do` across agent `bulk_update_priorities` runs, auto-unpin on complete/archive, `card.rescore_requested` triggers live Chief of Staff webhook cleanly.
5. - [ ] **Multi-Select & Bulk Webhook Safety:** Desktop hover/`Shift+Click` & mobile `Select` mode, Bulk Action Bar (Status, Complete including recurring cards, Archive, Tags, Assign, Due/Snooze, Pin, Rescore), single batch `cards.bulk_updated` webhook delivery with visibility isolation.
6. - [ ] **Trello-Style Desktop Shortcuts, Quick Popovers & `Cmd+K` Palette:** `j`/`k`/`x`/`Enter`/`Esc`, `c`/`m`/`l`/`d`/`s`/`h`/`p`/`r`/`Space`/`n`/`Shift+Enter`/`/`/`g`+tab/`?`, Undo toast, instant popovers on list + detail, `Cmd+K` fuzzy command & card search, input-focus safety.
7. - [ ] **Desktop Kanban Board, Drag-and-Drop & Slide-Over Drawer:** `1440px` default Board, horizontal scroll, Top-5 divider, inline column Quick-Add, slide-over drawer preserving board state, cross-column drag including recurring card onto `Done` and `Snoozed` column, 2D keyboard nav (`ArrowLeft`/`ArrowRight`, `[` / `]`), and `< 1024px` mobile hiding Board cleanly.

**Validation Gate:**
- All 7 walkthrough areas verified live in production and checked off `- [x]`.
