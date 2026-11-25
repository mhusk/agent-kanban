# agent-kanban

An **agent-first, mobile-first Kanban board** built to be operated jointly by people and AI agents. Human household members capture and prioritize tasks from an installable PWA, while AI assistants interact natively over a **Streamable HTTP MCP server**, **REST API**, **filtered HMAC/Bearer webhooks**, and an **incremental event polling API**.

Built cleanly for public self-hosting on Firebase (Cloud Functions v2, Firestore, Cloud Storage, Hosting) and WorkOS AuthKit.

---

## Architecture

```mermaid
flowchart LR
  PWA["React 19 PWA (Vite + Tailwind)"] -->|WorkOS JWT| Hosting["Firebase Hosting"]
  Agent["AI Agent / MCP Client"] -->|WorkOS OAuth / API Key| Hosting
  Hosting -->|"/api/**, /mcp, /.well-known/**"| API["Cloud Functions v2 Express API"]
  API --> Shared["@agent-kanban/shared (Zod Schemas & Rules)"]
  API --> Firestore["Cloud Firestore (Deny-All Client Rules)"]
  API --> Storage["Cloud Storage (Signed URLs Only)"]
  Firestore -->|"onDocumentCreated events/{id}"| Dispatcher["Webhook Dispatcher (AES-256-GCM + Retries)"]
  Scheduler["Cloud Scheduler"] -->|"15m due scan / daily archive & export"| API
```

### Core Security & Design Invariants

- **Strict API-Only Storage & Database Access:** Both `firebase/firestore.rules` and `firebase/storage.rules` deny all direct client SDK reads/writes (`allow read, write: if false`). Every human request and agent request flows through `apps/api`.
- **Per-User Visibility Isolation:** Cards are visible strictly to `visibleToUserIds` (`assignedUserIds ∪ awareUserIds`). Unauthorized card IDs always return `404 Not Found`.
- **Agent Loop Suppression:** Writes with `actorType === 'agent'` (API keys and `/mcp` calls) are attributed in `activity` (`"<agentName> via <platform> (agent)"`) and **never** emit events to `events/{eventId}` or trigger webhooks.
- **No Plaintext Secrets:** Agent API keys are stored only as SHA-256 hashes; webhook secrets are envelope-encrypted with AES-256-GCM using `WEBHOOK_ENCRYPTION_KEY`.
- **Fail-Closed Emulator Guard:** `AUTH_MODE=emulator` is strictly refused at boot outside `FUNCTIONS_EMULATOR=true` or `NODE_ENV=test`.

---

## 5-Minute Local Development (Firebase Emulators)

### Prerequisites

- Node.js `>= 22` and `pnpm`
- Firebase CLI (`firebase-tools`) installed globally (`npm install -g firebase-tools`)
- Java runtime (required by the local Firestore Emulator)

### Quickstart

```bash
# 1. Install workspace dependencies & install Chromium for Playwright if needed
pnpm install

# 2. Build shared package, API bundle, and PWA assets
pnpm build

# 3. Start Firebase Emulators (Firestore, Functions, Storage, Hosting)
firebase emulators:start --only firestore,storage,functions,hosting

# 4. In another terminal, seed fictional household users & sample cards
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 pnpm exec tsx scripts/seed-emulator.ts --reset
```

Open **`http://127.0.0.1:5050`** and sign in with the **Emulator User Switcher** as **Alex Rivera (`@alex`)** or **Sam Rivera (`@sam`)**.

### Full Verification Suite

Run the entire CI verification pipeline locally (hygiene scanner, ESLint, Prettier, TypeScript typechecks, Vitest unit tests, Firestore/Storage Security Rules tests, API emulator integration tests, and Playwright mobile E2E tests):

```bash
pnpm ci:verify
```

---

## Self-Hosting Deployment Guide

Detailed step-by-step cloud provisioning and WorkOS AuthKit gotchas live in [`docs/DEPLOYMENT_SETUP.md`](docs/DEPLOYMENT_SETUP.md) and [`docs/PRD.md`](docs/PRD.md). Summary:

1. **Firebase Project (Blaze Plan):**
   - Enable Firestore (Native mode), Cloud Storage, Hosting, and Cloud Functions v2.
   - Set a GCP Billing Budget Alert (e.g., `$5/month`).
   - Enable required GCP APIs (`Cloud Functions`, `Cloud Build`, `Cloud Run`, `Artifact Registry`, `Eventarc`, `Secret Manager`).
2. **WorkOS AuthKit:**
   - Configure Redirect URIs (`https://<FIREBASE_PROJECT_ID>.web.app/callback`), Sign-out URIs, and CORS origins.
   - Add `"email"` and `"email_verified"` to your WorkOS JWT Template so `/api/me` can match allowlisted household accounts on first sign-in.
3. **Environment Variables & Secrets:**
   - Generate a 32-byte key (`openssl rand -base64 32`) and save it in Google Secret Manager as `WEBHOOK_ENCRYPTION_KEY`.
   - Configure GitHub Actions Secrets (`FIREBASE_PROJECT_ID`, `FIREBASE_SERVICE_ACCOUNT`, `VITE_WORKOS_CLIENT_ID`, `WORKOS_JWKS_URL`, `WORKOS_ISSUER`, `HOUSEHOLD_TIMEZONE`, optional `AUTO_ARCHIVE_DAYS`, optional `BACKUP_BUCKET`).
4. **Bootstrap Initial Users:**
   ```bash
   GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json \
   pnpm exec tsx scripts/bootstrap-user.ts \
     --project <FIREBASE_PROJECT_ID> \
     --email alex@example.test \
     --display-name "Alex Rivera" \
     --handle alex \
     --role admin
   ```
5. **Deploy & Verify:**
   - Run **Actions → Deploy → Run workflow** on `main` (`.github/workflows/deploy.yml`).
   - Run the non-destructive production smoke check:
     ```bash
     PROD_URL=https://<FIREBASE_PROJECT_ID>.web.app \
     SMOKE_API_KEY=<OPTIONAL_API_KEY> \
     pnpm exec tsx scripts/smoke-prod.ts
     ```

---

## API & MCP Quick Reference

### 1. Hosted MCP Clients (Claude, ChatGPT, Cursor)

- **Endpoint:** `https://<your-domain>/mcp` (Stateless Streamable HTTP)
- **Discovery Metadata:** `https://<your-domain>/.well-known/oauth-protected-resource` (RFC 9728)
- **Authentication:** WorkOS OAuth 2.1 Bearer JWT or personal API key (`Authorization: Bearer <token>`), plus optional `X-Agent-Name` header for activity attribution.
- Includes 20 shared-handler tools: `list_cards`, `get_card`, `get_card_by_trello`, `search_cards`, `query_smart`, `workspace_snapshot`, `create_card`, `update_card`, `bulk_update_cards`, `bulk_update_priorities`, `change_status`, `complete_card`, `archive_card`, `list_activity`, `add_comment`, `manage_checklist`, `toggle_checklist_item`, `manage_link`, `list_events`, and `manage_subscriptions`.

### 2. Custom Agents via REST API Key

1. Open **Settings → Agent Connections (API Keys)** in the PWA and create a key (shown once).
2. Send requests with:
   ```http
   Authorization: Bearer ak_example_placeholder
   X-Agent-Name: Chief of Staff
   ```
3. Useful endpoints:
   - `GET /api/workspace/snapshot` — single-request prioritized workspace context (`todo` top cards, `doing`, `blocked`, due soon, overdue, recent activity, household roster).
   - `PATCH /api/cards/priorities` & `PATCH /api/cards/bulk` — batch prioritization/updates with `Idempotency-Key` support.
   - `GET /api/events?since=<eventId>&limit=50` — incremental 30-day polling fallback.

### 3. Filtered Webhooks & Signature Verification

Create filtered subscriptions via `POST /api/subscriptions` (or **Settings → Webhook Subscriptions** / MCP `manage_subscriptions`) filtering by `eventTypes`, `tags`, `statuses`, `assignedUserIds`, and `mentionedUserIds`.

- **`hmac` deliveries** include:
  - `X-Agent-Kanban-Event-Id`
  - `X-Agent-Kanban-Event-Type`
  - `X-Agent-Kanban-Timestamp` (Unix seconds)
  - `X-Agent-Kanban-Signature`: `t=<unixSeconds>,v1=<hex(hmac_sha256(secret, `${t}.${rawBody}`))>`
- **`bearer` deliveries** include `Authorization: Bearer <secret>`.
- Failed deliveries (`non-2xx` or 5s timeout) automatically retry at `1m`, `5m`, `15m`, and `60m` (up to 5 attempts) preserving the exact same `eventId`.

---

## License

[MIT](LICENSE)
