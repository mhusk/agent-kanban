# PRD: `agent-kanban` (v2.0 — Implementation Ready)

*v2.0, Public Open-Source Spec. Repo: `mhusk/agent-kanban` (MIT License).*

## 1. Project Brief & Product Thesis

Paying ~$120/yr for Trello Standard (2 users) comes with an API that is awkward for AI agents (dual ID formats, no server-side due-date queries, no native recurring-card resets, and polling instead of event triggers). More fundamentally, Trello relies on manual list-shuffling, which leads to card bloat and clutter.

**`agent-kanban`** replaces Trello with a small, private, **agent-first task system** on **Firebase, Node.js, and WorkOS**, built for a single household and any AI agent harness each user plugs in (Claude, ChatGPT, custom API/webhook bots, etc.). Instead of multiple boards and manual lists, `agent-kanban` uses **one unified pool of cards** sliced by tags, fixed execution states (`todo`, `doing`, `blocked`, `done`), and **continuous AI reprioritization** (Bring Your Own Agent). Agents reprioritize open cards daily—and on new card creation—so humans only focus on the top few concrete actions.

- **Timeline:** Iterative, non-deadline-driven build-in-public project.
- **Cutover:** Run in parallel with Trello until proven; cancel Trello prior to the next annual renewal.
- **Open Source:** Public building-in-public monorepo designed for easy single-household self-hosting, with all configuration, timezone, secrets, and user data kept strictly outside the repository.

### Success Metrics

- Household runs on `agent-kanban` daily and retires Trello prior to renewal.
- Existing household automation bots migrated (e.g., Chief of Staff, Meal & Grocery, Email Triage).
- Hosting cost on Firebase Blaze well under $120/yr (budget alert at $5/mo).
- Daily `To-Do` view stays uncluttered by surfacing the top ~5 AI-ranked cards by default.

### Non-Goals

Multi-tenant SaaS, billing, marketplaces, native iOS/Android apps, push/email notifications, built-in LLM orchestration, or Trello feature parity.

---

## 2. Locked Architectural Decisions (v1.1 -> v2.0)

| Area | Decision | Rationale |
| :--- | :--- | :--- |
| **Data Structure** | **Single unified card pool** sliced by tags/views (no boards or custom lists). | Eliminates board-switching on mobile and simplifies cross-cutting agent queries. |
| **Workflow & Clutter** | Fixed states (`todo`, `doing`, `blocked`, `done`) + **`0–100` `priorityScore`** and `priorityReason`. UI shows top 5 `todo` cards by default. | Replaces manual `Back-Log`/`To-Do` shuffling and WIP-limit overrides with continuous AI ranking; `0–100` avoids renumbering writes on mid-day inserts. |
| **Prioritization Engine** | **Bring Your Own Agent (BYOA).** | Keeps `agent-kanban` a fast, cheap, LLM-agnostic data and event layer. |
| **People & Visibility** | Configurable household roster; card-level **`assignedUserIds[]`** (drivers) and **`awareUserIds[]`** (viewers). | Scales cleanly from 2 adults to an entire household; replaces per-board ACLs cleanly. |
| **API-First Layer** | **All reads and writes** (human UI and agents) go through the Cloud Functions API. | Single source of truth for permissions, validation, activity logs, and webhooks; Firestore client SDK locked down. |
| **Auth** | **WorkOS AuthKit** for human login and MCP OAuth 2.1; revocable **API keys** for non-OAuth harnesses. | One identity and JWT verification pipeline (JWKS) on the backend. |
| **Agent Permissions** | **User-Owned (Delegated):** every agent connection and webhook belongs to an `ownerUserId` and inherits their card visibility. | Aligns 1:1 with MCP OAuth; zero extra ACL logic; scales as each user adds their own agents. |
| **Due Dates** | **Optional** (no 14-day default), with `dueFirm` (`true` = real consequences if missed) and `dueHasTime`. | Prevents artificial defaults from firing false `due_soon`/`overdue` webhooks and misleading agents. |
| **Recurring Cards** | **In-place reset** via a `recurrence` rule on the card itself. | Preserves one permanent URL and full comment history while resetting checklists and advancing the due date on completion. |
| **Events & Loops** | Webhooks fire on **human actions** and **scheduled time events** only; agent writes suppress webhooks. Per-subscription filtering (`eventTypes`, `tags`, `status`, `assigned`). | Prevents infinite agent loops and avoids wasting automated agent runs / token budgets. |
| **Repo & CI/CD** | Public **monorepo** (`mhusk/agent-kanban`) deployed via **GitHub Actions**. | Keeps web UI, API, MCP server, and shared types in sync. |

---

## 3. Users & Agents

- **Household Humans (expandable family roster):** Full v1 users from day one via a mobile-friendly PWA. Can view, create, edit, comment (`@mention`), change state, complete, and upload files. Any user may connect their own AI agents.
- **Chief of Staff Bot:** Primary daily reprioritization engine, morning briefs, calendar-to-card linking, and mid-day triage.
- **Meal & Grocery Bot:** Weekly meal plan and recurring grocery checklist management.
- **Email Triage Bot & Future Harnesses:** Creates/updates cards from external workflows. All agents operate via their owner's platform connection and sign every write with their `agentName` (e.g., `"Chief of Staff via Automation Bot (agent)"`).

---

## 4. Scope

| Phase | Features |
| :--- | :--- |
| **MVP (v1)** | Monorepo + GitHub Actions CI/CD; WorkOS AuthKit login + household user allowlist; unified card pool with fixed states (`todo`, `doing`, `blocked`, `done`), tags, `assignedUserIds` / `awareUserIds`; `priorityScore` (`0–100`) + `priorityReason` with bulk priority update; optional due dates (`dueFirm`, `dueHasTime`); comments with `@mentions`; checklists with toggling; in-place recurring card resets; link attachments + real file uploads (photos/PDFs, 10 MB limit) via GCS signed URLs; full-text token search (titles, descriptions, checklists); activity log with `lastTouchedAt` and `enteredStatusAt`; REST API + MCP server over shared handlers; user-owned agent connections (MCP OAuth + API keys); filtered webhooks (`Bearer` or `HMAC`) + 30-day polling fallback; minimal mobile-friendly PWA (Top 5 `To-Do` default view, tag/person filters). |
| **Later** | One-time Trello import; mobile drag-and-drop; comment search; per-person priority scores (if shared-card ranking conflicts arise); household-wide auto-visibility tags; additional UI polish. |
| **Out of Scope** | Native mobile apps; push/email notifications; multi-board/custom-list hierarchies; hard WIP caps; built-in LLM calls; multi-tenant SaaS / billing. |

---

## 5. Functional Requirements

### Cards, States & Views

- **States:** Every card has one `status`: `todo`, `doing`, `blocked`, or `done`.
- **Visibility:** A user can read/write a card if their `userId` is in `assignedUserIds` (one or more drivers) or `awareUserIds` (viewers).
- **Prioritization:** Single `priorityScore` (`0–100`, nullable when newly created/unscored) and `priorityReason` (short string). Default `To-Do` sort: `priorityScore DESC`, `due ASC`, `createdAt ASC`. UI displays the top 5 `To-Do` cards with remaining cards collapsed beneath.
- **Due Dates:** Optional. Stored in UTC ISO 8601 with `dueFirm` (boolean—indicates real consequences if missed) and `dueHasTime` (boolean). Date-only dues evaluate to end-of-day in the configured household IANA timezone (`HOUSEHOLD_TIMEZONE`, DST-aware).
- **Stable Identity:** One permanent card ID and human URL (used in calendar events). Optional `trelloUrl` and `trelloShortLink` fields allow resolving legacy links during parallel run.
- **Auto-Archive:** Non-recurring `done` cards auto-archive after `N` days (default: 30).

### Recurring Cards (In-Place Reset)

- Any card may carry a `recurrence` rule (cron/calendar schedule like *"Saturday 7:00 AM"* or interval-after-completion like *"30 days after done"*, evaluated in the card's or household's configured IANA timezone).
- **On completion (`status -> done`):**
  1. Log a `card.completed` entry in `activity` (preserving the completion record).
  2. Uncheck all checklist items on the card.
  3. Compute and set the next `due` date.
  4. Reset `status` to `todo` and clear `priorityScore` / `priorityReason` so the next agent pass rescores it.
  5. Keep all comments, attachments, and the permanent card URL intact.

### Comments, Attachments & Activity

- **Comments:** Humans and agents read/write comments; each shows its author (e.g., `"Sam Rivera"` or `"Chief of Staff via Automation Bot (agent)"`). `@mentions` are parsed into `mentions[]` user IDs.
- **Attachments:** Link attachments stored directly on the card (`links[]`). File uploads (images and PDFs, max 10 MB) stored in Cloud Storage via short-lived signed upload/download URLs minted by the API after verifying card visibility.
- **Activity Log:** Records actor (`human` or `agent` + `agentName` + `platform`), action, field diff (`from`/`to`), optional `note` ("why"), and timestamp.

---

## 6. API, MCP & Agent Events

### Auth & Identity

- **Humans:** WorkOS AuthKit JWT in `Authorization: Bearer <jwt>`.
- **Agents:**
  - **MCP OAuth 2.1:** WorkOS AuthKit JWT (mapped to `ownerUserId`).
  - **API Keys:** Platform-level revocable, hashed key bound to an `ownerUserId` (e.g., an owner's `"Automation Bot"` connection).
  - Every agent request includes `agentName` (HTTP header `X-Agent-Name` or MCP tool argument) so actions are logged as `"<agentName> via <platform> (agent)"`.
- **Visibility Enforcement:** Every API/MCP query automatically filters to cards where `ownerUserId` is in `assignedUserIds` or `awareUserIds`.

### Core Endpoints & MCP Tools

*(MCP server wraps the exact same handler functions as the Express REST API.)*

- **Read:** List cards (filters: `status`, `tag`, `assignedTo`, `awareOf`, `dueBefore`, `dueAfter`, `updatedSince`, `archived`); get card by ID or legacy Trello URL; search (tokenized title/description/checklists); activity log (card or global); **smart queries** (`overdue_or_due_within_days`, `stale_in_todo_days`); **workspace snapshot** (all open cards with scores, dues, and last activity in one call).
- **Write:** Create, update, change status, complete, archive; add comment; checklist CRUD + item toggle; attach link; request signed URL for file upload/download; **bulk priority update** (`PATCH /cards/priorities` taking `[{ cardId, priorityScore, priorityReason }]`) and bulk status/field updates.
- **Reliability:** Idempotency keys on create and bulk endpoints; optional `ifUpdatedAt` precondition on updates; optional `note` ("why") on every write.

### Agent Events & Webhooks

- **Trigger Policy:** Events publish **only on human actions** (all household users treated equally) and **scheduled time checks** (`card.due_soon`, `card.overdue`). Agent-initiated writes do **not** emit webhooks, preventing loops.
- **Event Types:** `card.created` (triggers mid-day AI scoring), `card.updated`, `card.status_changed`, `card.commented` (includes `mentions[]`), `card.completed`, `card.due_soon` (default 2 days in `HOUSEHOLD_TIMEZONE`), `card.overdue` (fires once when past due, or configurable daily).
- **Subscriptions (User-Owned):** Managed via API/MCP (listed in UI). Each subscription specifies:
  - `ownerUserId`, `webhookUrl` (HTTPS only)
  - `authType`: `bearer` (for routine/bearer-authenticated triggers) or `hmac` (signed body + timestamp for custom harnesses)
  - Encrypted secret (envelope-encrypted via a master key in Secret Manager)
  - **Filters:** `eventTypes[]`, plus optional `tags[]`, `statuses[]`, `assignedUserIds[]`, or `mentionedUserIds[]`.
- **Delivery & Fallback:** Retries with exponential backoff using the same `eventId` for receiver idempotency. Polling fallback `GET /events?since=<cursor>` retained for 30 days.

---

## 7. Architecture & Monorepo Layout

### Stack

- **Firebase Hosting** (React/TypeScript mobile-first PWA)
- **Cloud Functions v2 (Node.js / Express)** — REST API, MCP server, scheduled jobs, and webhook dispatcher
- **Cloud Firestore** — locked down via security rules (`allow read, write: if false;`); accessed exclusively by the API using Admin SDK
- **Cloud Storage** — accessed exclusively via API-minted signed URLs
- **WorkOS AuthKit** — human SSO + MCP OAuth 2.1
- **Google Secret Manager** — master webhook encryption key, WorkOS configuration/secrets

### Monorepo Structure (`mhusk/agent-kanban`)

```text
agent-kanban/
├── apps/
│   ├── web/              # Mobile-first PWA (WorkOS AuthKit client, REST client)
│   └── api/              # Cloud Functions v2 (Express REST, MCP server, cron, webhooks)
├── packages/
│   └── shared/           # Zod schemas, TypeScript types, recurrence & search helpers
├── firebase/             # firestore.rules, storage.rules, firestore.indexes.json
└── .github/workflows/    # CI (lint, typecheck, emulator tests) + CD (Firebase deploy)
```

### Firestore Data Model

- `users/{userId}`: `workosUserId`, `email`, `displayName`, `handle` (for `@mentions`), `role` (`admin` | `member`), `createdAt`
- `cards/{cardId}`: `title`, `description`, `status` (`todo`|`doing`|`blocked`|`done`), `tags[]`, `assignedUserIds[]`, `awareUserIds[]`, `visibleToUserIds[]`, `priorityScore` (0–100 | null), `priorityReason`, `due`, `dueFirm`, `dueHasTime`, `recurrence` (`{ type, rule, timezone }` | null), `links[]`, `checklists[]`, `archived`, `enteredStatusAt`, `lastTouchedAt`, `createdBy`, `updatedAt`, `searchTokens[]`, `trelloUrl`, `trelloShortLink`, `dueSoonNotifiedAt`, `overdueNotifiedAt`
- `cards/{cardId}/comments/{commentId}`: `actorType`, `actorId`, `agentName`, `platform`, `text`, `mentions[]`, `createdAt`
- `cards/{cardId}/attachments/{attachmentId}`: `storagePath`, `fileName`, `contentType`, `size`, `uploadedBy`, `createdAt`
- `activity/{activityId}`: `cardId`, `visibleToUserIds[]`, `actorType`, `actorId`, `agentName`, `platform`, `action`, `diff`, `note`, `createdAt`
- `agentConnections/{connectionId}`: `ownerUserId`, `platform`, `authType` (`oauth`|`api_key`), `keyPrefix`, `hashedKey`, `revoked`, `rotatedAt`, `createdAt`
- `subscriptions/{subscriptionId}`: `ownerUserId`, `connectionId`, `webhookUrl`, `authType` (`bearer`|`hmac`), `encryptedSecret`, `filters` (`eventTypes`, `tags`, `statuses`, `assignedUserIds`, `mentionedUserIds`), `active`
- `events/{eventId}`: `type`, `cardId`, `visibleToUserIds[]`, `actor`, `note`, `payload`, `createdAt`, `deliveries`

### Scheduled Jobs (Cloud Functions)

- **Every 15 minutes:** Check for `card.due_soon` and `card.overdue` transitions (idempotent flags on card so events don't duplicate).
- **Daily:** Auto-archive non-recurring `done` cards older than 30 days; clean up `events` older than 30 days; daily Firestore export backup.

---

## 8. Milestones & Parallel Migration

| Milestone | Target Size | Done When |
| :--- | :--- | :--- |
| **M0: Monorepo, CI/CD & Auth** | 2–3 days | Public `mhusk/agent-kanban` repo (MIT), GitHub Actions deploy pipeline, Firebase project with locked Firestore rules, WorkOS AuthKit login working for household members, fake seed data. |
| **M1: Core API & Minimal PWA** | 1–1.5 weeks | Full card CRUD via API (`status`, `tags`, `assigned`/`aware`, `dueFirm`, checklists, comments with `@mentions`, token search, in-place recurring resets); mobile PWA shows Top 5 `To-Do` + filters. |
| **M2: Agent Connections & Prioritization API** | 1 week | User-owned API keys + `X-Agent-Name` logging, bulk `PATCH /cards/priorities`, smart queries, workspace snapshot. Chief of Staff agent can run daily reprioritization and briefs. |
| **M3: MCP Server & Filtered Webhooks** | 1.5–2 weeks | MCP server (WorkOS OAuth + API key) over REST handlers; `Bearer`/`HMAC` webhook dispatcher with tag/status filters + polling fallback; `card.created` triggers mid-day scoring; `due_soon`/`overdue` cron active. |
| **M4: File Uploads, Onboarding & Polish** | 1 week | GCS signed-URL photo/PDF uploads (10 MB limit, client-side photo resize); PWA installability polish; household users + Chief of Staff running daily. |
| **M5: Parallel Run** | 4+ weeks | Run alongside Trello; recreate active cards organically (storing `trelloUrl` where helpful); migrate Meal & Grocery and Email Triage bots. |
| **M6: Cutover** | Before renewal | Turn off Trello auto-renew and cancel subscription once proven. |

---

## 9. Key Risks & Mitigations

- **Shared-card visibility gap:** Under user-owned connections, if one household member creates a `#groceries` card without adding the other adult(s) to `awareUserIds`, a bot owned by another member won't see it. *Mitigation:* Default new cards in the UI with a "Share with household" toggle (**default ON**) that adds other household members to `awareUserIds`.
- **Public repo secret & PII leaks:** No `.env` files, keys, project IDs, personal names, home location/timezone, or real household data in git; automated hygiene check in CI; GitHub secret scanning enabled; all secrets in Secret Manager; fake seed data only.
- **Blaze / Storage cost spikes:** $5/month budget alert; 10 MB per-file cap with client-side image compression; event-driven webhooks eliminate heavy bot polling.
- **Webhook security & replay:** HTTPS only; `Bearer` or timestamped `HMAC` signatures; unique `eventId` on retries; revocable secrets.
- **Scope creep toward Trello parity:** Keep `agent-kanban` opinionated—add features only when daily use demands them.
