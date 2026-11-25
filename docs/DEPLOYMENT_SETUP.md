# Production Deployment & Auth Setup Guide

This guide captures the manual provisioning steps and real-world gotchas for deploying `agent-kanban` to Firebase with WorkOS AuthKit and GitHub Actions (Step M0.8).

> **Public Repo Safety:** Never commit `.env` files, `.firebaserc`, service account JSON keys, real project IDs, WorkOS client IDs, or personal emails/names. Keep all deployment values in GitHub Actions Secrets, Google Secret Manager, or gitignored local files.

---

## 1. Local Privacy Guardrails & GitHub Security

1. **Local denylist (optional, gitignored):** Create `.hygiene-denylist.local` in the repository root with one personal term per line (family names, personal emails, home city, Firebase project ID). Blank lines and `#` comments are ignored.
   - `scripts/check-hygiene.mjs` performs a **case-insensitive substring match** across all git-tracked files. Avoid very short words or generic test fixtures (such as `UTC` or `America/New_York`) that legitimately appear in unit tests.
   - Run `pnpm hygiene:check` after editing to verify there are no false positives.
2. **GitHub Security:** Under **Settings → Advanced Security / Code security**, ensure both **Secret scanning** and **Push protection** are enabled.

---

## 2. Firebase & GCP Provisioning

1. Create a private Firebase project and upgrade to the **Blaze** plan.
2. Create a GCP Billing **Budget Alert** at **$5/month** scoped to the project.
3. In Firebase Console, initialize:
   - **Firestore Database:** Standard (Native mode) in `us-central1` (Start in production mode; deploy overwrites rules with deny-all `firebase/firestore.rules`).
   - **Storage:** Default bucket in `us-central1` (Start in production mode).
   - **Hosting:** Click through Get Started to initialize `https://<FIREBASE_PROJECT_ID>.web.app` (do **not** run `firebase init` in the repo).
   - **Functions:** Click Get Started.
4. In Google Cloud Console (**APIs & Services**), enable:
   - `Cloud Functions API`
   - `Cloud Build API`
   - `Cloud Run Admin API`
   - `Artifact Registry API`
   - `Eventarc API`
   - `Secret Manager API`
5. Create a deploy service account (e.g., `github-actions-deploy`) with these IAM roles:
   - `Firebase Admin` (`roles/firebase.admin`)
   - `Service Account User` (`roles/iam.serviceAccountUser`)
   - `Cloud Functions Admin` (`roles/cloudfunctions.admin`)
   - `Cloud Run Admin` (`roles/run.admin`)
   - `Artifact Registry Administrator` (`roles/artifactregistry.admin`)
   - `Cloud Build Editor` (`roles/cloudbuild.builds.editor`)
   - `Service Usage Consumer` (`roles/serviceusage.serviceUsageConsumer`)
6. Generate a JSON key, store it **outside** the repository while configuring GitHub Secrets and bootstrapping users, and delete the local file once finished.

---

## 3. WorkOS AuthKit Setup & Gotchas

### Application, Redirects & CORS
1. Under **Applications**, either use your environment's Default application or click **Create application** to give `agent-kanban` isolated redirects and sessions while sharing the same user pool.
2. Under **Applications → `<app>` → Redirects**, configure:
   - **Redirect URIs:** `https://<FIREBASE_PROJECT_ID>.web.app/callback` *(and optionally `http://localhost:5173/callback` for local Vite testing)*
   - **Sign-out URIs:** `https://<FIREBASE_PROJECT_ID>.web.app`
3. Under **Applications → `<app>` → Sessions → Cross-Origin Resource Sharing (CORS)**, add `https://<FIREBASE_PROJECT_ID>.web.app` so `@workos-inc/authkit-react` can perform browser token exchange and session refresh.
4. **No WorkOS API key is required:** The PWA uses PKCE (client ID only) and the API verifies JWTs statelessly via JWKS. Leaving **API keys** empty on the application is intentional.

### Gotcha 1: Configure the JWT Template (Required!)
By default, WorkOS AuthKit access tokens do **not** include `email` or `email_verified`. Because `apps/api/src/middleware/auth.ts` matches allowlisted users by verified email on first login, you must configure the JWT template under **Authentication → Features → JWT Template**:

```json
{
  "email": {{ user.email }},
  "email_verified": {{ user.email_verified }}
}
```

- **Template syntax:** Leave `{{ user.email }}` **unquoted**—WorkOS serializes it as a JSON string automatically (verify in the Preview pane that `"email"` renders as a string and `"email_verified"` renders as a boolean).
- **Shared WorkOS environments:** Adding `email` and `email_verified` is strictly additive and backwards-compatible with other apps in the same environment.

### Gotcha 2: Multi-Application `iss` and JWKS Use the Default Client ID
If you created a separate `agent-kanban` Application inside an existing WorkOS environment:
- The access token's `client_id` claim is the **`agent-kanban` application's Client ID**, **but**
- The access token's `iss` claim still references the **environment's Default Application Client ID** (`https://api.workos.com/user_management/<DEFAULT_APP_CLIENT_ID>`).

Configure your secrets accordingly:
- `VITE_WORKOS_CLIENT_ID` → the **`agent-kanban` application's** Client ID.
- `WORKOS_ISSUER` → `https://api.workos.com/user_management/<DEFAULT_APP_CLIENT_ID>` (must match the JWT `iss` claim exactly, or `/api/me` returns `401 INVALID_TOKEN` and the UI auto-signs out).
- `WORKOS_JWKS_URL` → `https://api.workos.com/sso/jwks/<DEFAULT_APP_CLIENT_ID>` (open in a browser to confirm it returns `{"keys":[...]}`).

*(If you only have a single Default application in your WorkOS environment, all three values use that same Client ID.)*

### Gotcha 3: PKCE `Invalid code verifier`
If you see `400 Bad Request` (`{"error":"invalid_grant","error_description":"Invalid code verifier."}`) on `POST /user_management/authenticate`, the one-time PKCE `code_verifier` in `sessionStorage` did not match the callback `code` (caused by reloading `/callback?code=...`, hitting Back mid-login, or finishing an email verification link in a different tab). Fix by navigating cleanly to `https://<FIREBASE_PROJECT_ID>.web.app/` in a single tab and signing in fresh.

---

## 4. Secrets Configuration

1. **Google Secret Manager:**
   - Generate a 32-byte key: `openssl rand -base64 32`
   - Create secret `WEBHOOK_ENCRYPTION_KEY` in GCP Secret Manager with that value.
2. **GitHub Actions Secrets** (**Settings → Secrets and variables → Actions**):

| Secret Name | Purpose |
| :--- | :--- |
| `FIREBASE_PROJECT_ID` | Target Firebase/GCP project ID |
| `FIREBASE_SERVICE_ACCOUNT` | Full JSON contents of the deploy service account key |
| `VITE_WORKOS_CLIENT_ID` | `agent-kanban` WorkOS application Client ID (also passed as `WORKOS_CLIENT_ID` to the API) |
| `WORKOS_JWKS_URL` | `https://api.workos.com/sso/jwks/<DEFAULT_APP_CLIENT_ID>` |
| `WORKOS_ISSUER` | Exact JWT `iss` claim (`https://api.workos.com/user_management/<DEFAULT_APP_CLIENT_ID>`) |
| `HOUSEHOLD_TIMEZONE` | Valid IANA timezone (e.g., `America/New_York`, `UTC`) |
| `AUTO_ARCHIVE_DAYS` *(optional)* | Days before completed non-recurring cards auto-archive (defaults to `30`) |
| `BACKUP_BUCKET` *(optional)* | GCS bucket URI (`gs://...`) for scheduled Firestore backups (used in M3.4) |

---

## 5. Bootstrapping Household Users

Run `scripts/bootstrap-user.ts` locally against production Firestore (make sure `FIRESTORE_EMULATOR_HOST` is **unset**):

```bash
GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json \
pnpm exec tsx scripts/bootstrap-user.ts \
  --project <FIREBASE_PROJECT_ID> \
  --email alex@example.test \
  --display-name "Alex Rivera" \
  --handle alex \
  --role admin
```

### Gotchas
- **Avoid curly/smart quotes:** Copy-pasting commands through macOS Notes or rich-text editors can convert straight `"..."` quotes into typographic `“...”` quotes, which the shell passes literally into `displayName`. Always use straight ASCII quotes (pass `--upsert` to fix an existing user).
- **No manual WorkOS user creation required:** When WorkOS **Sign-up** is enabled, household members can register with their allowlisted email on first visit, and the API automatically links their `workosUserId` on first `/api/me` request.

---

## 6. Deploy & Verify

1. Trigger **Actions → Deploy → Run workflow** on `main` and confirm both `Verify before deploy` and `Deploy to Firebase` pass.
2. Open `https://<FIREBASE_PROJECT_ID>.web.app`, sign in with an allowlisted household email, and confirm your profile loads from `/api/me`.
3. *(Recommended)* Verify an unallowlisted email receives `403` and sees the **"Household access required"** screen.
