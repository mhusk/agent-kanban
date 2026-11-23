# Agent Operating Guide (`agent-kanban`)

This repository is built step-by-step by coding agents following [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md) and [`docs/PRD.md`](docs/PRD.md).

## 1. Mandatory Execution Loop

For every coding session:

1. **Read `docs/IMPLEMENTATION_PLAN.md`** and locate the **first unchecked step** (`- [ ]`).
2. **Check for `[HUMAN]` gate:**
   - If the next unchecked step is tagged `[HUMAN]`, **STOP IMMEDIATELY**.
   - Do not skip past it and do not fabricate cloud credentials or external accounts.
   - Present the exact checklist from that `[HUMAN]` step to the user and wait until the user confirms it is complete (and checks it off or asks you to verify and check it off).
3. **Work on exactly one step at a time.** Do not batch multiple steps into a single commit or jump ahead to future milestones.
4. **Build & write tests for the step** following the step's Deliverables and Acceptance Criteria.
5. **Run the Validation Gate:**
   - Execute **every** command listed in the step's **Validation Gate**, plus the baseline checks (`pnpm lint`, `pnpm -r typecheck`, `pnpm hygiene:check` once created, and existing regression tests).
   - **NEVER** mark a step `- [x]` unless every validation command passes with exit code `0`.
   - **NEVER** weaken, skip, or delete an existing test to make a step pass. If a prior test breaks, fix the regression before proceeding.
6. **Check off & commit directly to `main`:**
   - Change `- [ ]` to `- [x]` in **both** the Milestone Summary table and the step heading in `docs/IMPLEMENTATION_PLAN.md`.
   - Run `git diff --staged` sanity check for accidental secrets or personal details before committing.
   - Commit all changes (including `docs/IMPLEMENTATION_PLAN.md`) directly to `main` with commit message format:
     ```text
     step(M<milestone>.<step>): <concise imperative summary>
     ```
     Example: `step(M1.2): implement core card CRUD and visibility enforcement`
   - Ensure `git status` is clean before moving to the next step.

## 2. Hard Architectural, Privacy & Security Invariants

Never violate these rules while implementing any step:

- **Public Repo Privacy & Secret Hygiene (ZERO TOLERANCE):**
  - This is a **public open-source repository** (`mhusk/agent-kanban`) built in public.
  - **NEVER** commit `.env` files, `.firebaserc` containing real production project IDs, API keys, service account JSON, WorkOS client/API secrets, webhook secrets, private keys, personal or family member names, real email addresses, home city/location, hardcoded personal timezones, personal calendar/renewal dates, or real household tasks/notes.
  - All deployment-specific values (Firebase project ID, WorkOS issuer/JWKS/client ID, `HOUSEHOLD_TIMEZONE`, backup bucket, `WEBHOOK_ENCRYPTION_KEY`) MUST come from environment variables or Google Secret Manager—never hardcoded in source, config, or docs.
  - Use strictly fictional fixture data in tests, docs, and seed scripts (e.g., `Alex Rivera`, `Sam Rivera`, `alex@example.test`, `sam@example.test`, `example.test` domains, generic `America/New_York` or `UTC` for DST unit tests).
  - Run `pnpm hygiene:check` before every commit (and never bypass or weaken it).
- **API-Only Data Access:**
  - `firebase/firestore.rules` MUST remain `allow read, write: if false;` for all client SDK paths.
  - `firebase/storage.rules` MUST remain `allow read, write: if false;` for direct client SDK paths (uploads/downloads happen strictly via API-minted short-lived signed URLs).
  - All human UI and agent reads/writes MUST go through the Cloud Functions API (`apps/api`).
- **Strict Emulator Auth Guard:**
  - `AUTH_MODE=emulator` (local RSA test keypair + Dev User Switcher) is permitted **ONLY** when `FUNCTIONS_EMULATOR === 'true'` or `NODE_ENV === 'test'`.
  - The API MUST throw and refuse to boot if `AUTH_MODE=emulator` is set outside emulator/test mode.
- **Visibility Isolation:**
  - Every card query, single-card read/write, search, comment, attachment, activity query, snapshot, and event poll MUST filter by `visibleToUserIds` containing the caller's `userId` (or `ownerUserId` for agents).
  - Unauthorized card IDs MUST return `404 Not Found` (never leak card existence via `403` on card ID lookups).
- **Agent Loop Suppression:**
  - Writes with `actorType === 'agent'` MUST **NEVER** emit events to `events/{eventId}` or trigger webhooks.
  - Only `actorType === 'human'` writes and scheduled time checks (`card.due_soon`, `card.overdue`) emit events.
- **Shared Handlers for REST & MCP:**
  - MCP tools in `/mcp` MUST call the exact same typed handler/service functions as the Express REST routes—never duplicate business logic, validation, or visibility checks.
- **No Plaintext Webhook Secrets:**
  - Subscription secrets MUST be envelope-encrypted (AES-256-GCM) with `WEBHOOK_ENCRYPTION_KEY` before writing to Firestore, and API keys MUST be stored only as SHA-256 hashes.

## 3. When You Get Stuck

If a validation command fails and you cannot resolve it cleanly after investigating:
- Do **not** check off the step.
- Do **not** leave broken code committed to `main`.
- Summarize the exact failing command, error output, root cause hypothesis, and options, and stop to ask the user.
