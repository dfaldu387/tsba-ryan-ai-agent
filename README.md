# TSBA Assistant · Preview

A multi-user admin panel for the **TSBA Technical Support assistant**. Account-based sign-in with roles & permissions; one page, four tabs:

**Accounts & roles.** Sign in with an email + password (no more shared password). Each account has one role:

| Role | Can |
| --- | --- |
| **Admin** | Everything, incl. manage users, connections, knowledge sources and approvals |
| **Manager** | Connect accounts, run Drive/Gmail scans, ask the agent, approve drafts |
| **Viewer** | Read-only: dashboard, knowledge base and drafts |

Routes and UI are gated on **permissions** (`manage_users`, `manage_connections`, `run_ingest`, `approve_drafts`, `ask`, `view`) derived from the role. The first admin is seeded from `ADMIN_EMAIL` / `ADMIN_PASSWORD` on first start; after that, Admins manage users in the panel. Passwords are hashed with scrypt; the session is a signed token re-validated against the live user on every request (so disabling a user or changing a role takes effect immediately).

- **Admin** — the default landing panel: introduces the agent (what it is, what it can do, the guardrails it always follows) and shows a live overview — drafting engine / embeddings / storage status, knowledge-base totals (documents, chunks, folder sources, split by Drive vs. Email), draft activity, a connections summary, and — for Admins — a **Users & roles** manager (add users, change roles, enable/disable, delete, with last-admin lock-out protection). Backed by `GET /api/overview` and `GET/POST/PATCH/DELETE /api/users`.
- **Ask** — pick who&rsquo;s asking (Customer / Installer / Sales rep) and the channel (Chat / Text / Email), type a question, and get a cited draft reply with **Approve & send / Edit / Reject**. Replies only move between the *Waiting / Handed to team / Sent* lists — nothing is sent to any real channel.
- **Connections** — connect **Google Drive** (knowledge source) and **Gmail** (email channel) over Google OAuth 2.0. See [Connections](#connections-google-drive--gmail) below.
- **Progress** — a glanceable checklist of what&rsquo;s done, in progress and next, plus a link to the shared sheet. Updated every few days.

Built from the brief in `TEAM_PROMPT_TSBA_Preview.md`, the layout/prompt in `ask-tsba-reference.html`, the 75 knowledge entries in `tsba-knowledge-v0.1.json`, and the SOFAR offline flow in `TSBA_Offline_Flow_v0.1.md`.

## Stack

| Layer | Tech |
| --- | --- |
| Frontend | TypeScript + React (Vite) |
| Backend | TypeScript + Node.js (Fastify) |
| AI / RAG | Anthropic `claude-sonnet-5-5` for drafting + pluggable embedding models (Voyage / OpenAI / local) |
| Database | PostgreSQL + pgvector |
| Background jobs | Node.js + `pg-boss` (durable queue on the same Postgres) |

```
tsba-ai-agent/
├── backend/            Fastify API, RAG retrieval, pg-boss worker, scripts
├── frontend/           React SPA (Ask + Progress tabs, password gate)
├── packages/shared/    Types + label maps shared by both
├── db/schema.sql       Postgres + pgvector schema
├── data/               Knowledge JSON (75 entries + 6 SOFAR offline-flow rules)
└── docker-compose.yml  Postgres 16 with pgvector
```

### How a draft is produced (RAG)

1. The question is embedded and used to find the **top-K manufacturer answers** by pgvector cosine distance.
2. **All verified rules are always included** (small set, compliance-critical — RAG must never drop a safety rule).
3. Those entries fill the knowledge section of the reference prompt; `claude-sonnet-5-5` returns `{outcome, reply, sources, note_for_ryan, team_handover}`.
4. The draft is stored in Postgres with status `pending` and appears in the approval queue. The **Anthropic key never leaves the server.**

## Prerequisites

- **Node.js 20+** (tested on 24).
- An **Anthropic API key** for live drafting. Embeddings default to a local provider that needs no key.
- **No database required** in the default mode. Postgres + pgvector is only needed if you opt into `STORAGE=postgres`.

## Setup — default (no database)

```bash
# 1. Install
npm install

# 2. Configure
cp .env.example .env    # then edit: APP_PASSWORD, SESSION_SECRET, ANTHROPIC_API_KEY
                        # STORAGE=memory is the default — nothing else to set

# 3. Run it (API on :8080, web on :5173)
npm run dev
```

Open <http://localhost:5173>, enter `APP_PASSWORD`, and you&rsquo;re in. In this mode the knowledge
loads straight from `data/*.json` on startup and the approval queue lives in memory (cleared on
restart) — no `migrate`, no `ingest`, no Postgres.

## Setup — with Postgres (optional, no pgvector)

Turn this on when you want durable storage (users, drafts, connections and knowledge survive restarts) and the background job queue. **No extensions required** — embeddings are stored as a `real[]` column and cosine similarity is computed in the app, so any stock PostgreSQL 12+ works (no pgvector to build on Windows).

```bash
# 1) Create the app role + database (needs a superuser — run once).
#    On Windows the bundled client is at "C:\Program Files\PostgreSQL\18\bin\psql.exe".
psql -U postgres -h localhost -f db/setup-postgres.sql

# 2) Point DATABASE_URL in .env at it and switch STORAGE=postgres, then:
npm run migrate               # create the schema (users, knowledge_entries, …)
npm run ingest -- --inline    # load knowledge + embeddings (omit --inline to use the queue)
npm run dev
```

`db/setup-postgres.sql` creates the role/database named in your `DATABASE_URL` (default `tsba`/`tsba`). It's idempotent and keeps the password in sync with `.env`.

> **Background-jobs path:** run `npm run ingest` *without* `--inline` to enqueue durable `embed-entry` jobs; the backend's `pg-boss` worker processes them. `--inline` is a convenience for a one-shot setup with no server running.
>
> Note: XAMPP ships MySQL, not Postgres — you still need a Postgres instance for this mode.

## Scripts

| Command | Does |
| --- | --- |
| `npm run dev` | Backend + frontend in watch mode |
| `npm run build` | Type-check and build all three packages |
| `npm run migrate` | Apply `db/schema.sql` |
| `npm run ingest [-- --inline]` | Load knowledge; enqueue (or inline) embeddings |
| `npm start` | Run the built backend (serves the built SPA in production) |
| `npm run typecheck` | Type-check everything |

## Connections (Google Drive + Gmail)

The **Connections** tab links the external accounts the assistant draws on — the first step of the
blueprint&rsquo;s Lane 1 (Google Drive as a knowledge source) and the email channel (Gmail). Both use one
Google OAuth 2.0 client but are modelled as **separate connectors** with least-privilege scopes:

| Connector | Scopes requested | Used for |
| --- | --- | --- |
| Google Drive | `drive.readonly` | Ingesting product guides, warranties and data sheets |
| Gmail | `gmail.readonly`, `gmail.send` | Receiving and sending support email (replies stay approval-gated) |

Both also request `openid email profile` so the UI can show which account was connected.

**Tokens are encrypted at rest** (AES-256-GCM, key derived from `SESSION_SECRET`) and never leave the
server. In `memory` storage they live in-process (cleared on restart); in `postgres` they go in the
`connections` table. The server auto-refreshes an access token when it is within 60s of expiry.

If `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` are unset, the tab shows both connectors as **&ldquo;not
configured&rdquo;** and the rest of the app runs unaffected.

### One-time Google Cloud setup

1. In the **Google Cloud console → APIs & Services**, enable the **Google Drive API** and **Gmail API**.
2. **Create credentials → OAuth client ID**, application type **Web application**.
3. Add the exact **Authorized redirect URI** (must match `GOOGLE_REDIRECT_URI`):
   `http://localhost:8080/api/oauth/google/callback` (use your real domain in production).
4. On the **OAuth consent screen**, add the Google account(s) you&rsquo;ll test with as **Test users** while
   the app is unverified.
5. Put the client ID/secret in `.env`:
   ```
   GOOGLE_CLIENT_ID=...apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=...
   GOOGLE_REDIRECT_URI=http://localhost:8080/api/oauth/google/callback
   ```
6. Restart the backend, open **Connections**, and click **Connect**.

### Connection API

| Method & path | Does |
| --- | --- |
| `GET /api/connections` | Status of every connector (configured / connected / account / scopes) |
| `POST /api/connections/:provider/connect` | Returns the Google consent URL to redirect to |
| `GET /api/oauth/google/callback` | OAuth redirect target; exchanges the code, stores tokens, bounces back to the UI |
| `DELETE /api/connections/:provider` | Revokes upstream (best effort) and deletes the stored tokens |

`:provider` is `google-drive` or `gmail`. Reading status needs `view`; connect/disconnect need
`manage_connections`. The callback is guarded by a single-use `state` (no Bearer token).

### Scan Gmail into the knowledge base

Once **Gmail** is connected, users with `run_ingest` (Admin/Manager) see a **Scan email** panel on the Gmail
card. Pick a **label** (e.g. *Support*) and a message cap, then **Scan label**: each message is fetched,
its body extracted (plain text, or HTML stripped), chunked, embedded and added to the knowledge base — so
the agent can learn from real support correspondence. Nothing is ever sent from the scan path (read-only).

| Method & path | Does |
| --- | --- |
| `GET /api/gmail/labels` | List labels to choose a scan source (`view`) |
| `POST /api/gmail/scan` | Scan a label's messages into the KB — `{labelId, max?}` (`run_ingest`) |

Chunks are stored as `maker` entries with ids `gmail:<messageId>:<n>`; the message is catalogued in
`documents` with `source='gmail'`, so it shows in the Ingested-documents list and removes cleanly.

### Browse, select folders & ingest Drive files

Once **Google Drive** is connected, the Drive connector card shows a **file browser**. Navigate folders
from *My Drive*, then either:

- **Select whole folders** as knowledge sources — the blueprint's Lane 1 "approved sources". Open a folder
  (or use its `+ Add to KB` button) and choose **Add to knowledge base**. Every supported file in it is
  ingested; with **Include subfolders** ticked it descends recursively (depth- and count-capped). The folder
  is kept as a **knowledge-source folder** you can **Sync** (re-ingest, e.g. after a new catalogue lands) or
  **Remove** (optionally purging its ingested documents).
- **Tick individual files** and choose **Ingest selected**.

Each ingested file is pulled from Drive, its text extracted, split into chunks, embedded, and added to the
knowledge base so the **Ask** tab can cite it immediately. An **Ingested documents** list shows every loaded
file, with a **Remove** that deletes the document and all its chunks.

**Supported file types** (others are listed but greyed out as *not supported*):

| Type | How it's read |
| --- | --- |
| PDF | `pdf-parse` text extraction |
| Word `.docx` | `mammoth` raw-text extraction |
| Google Docs / Sheets / Slides | Exported from Drive as text / CSV |
| `.txt` / `.md` / `.csv` / `.json` | Read directly |
| `.html` | Tags stripped to text |

Chunks are stored as knowledge entries of kind `maker` with ids `drive:<fileId>:<n>`, so a document's
chunks can be removed together. In `postgres` mode they also land in the `documents` catalogue table and
`knowledge_entries`; in `memory` mode they live in-process (cleared on restart).

| Method & path | Does |
| --- | --- |
| `GET /api/drive/files?folderId=&pageToken=` | List a folder's children (`root` by default), folders first |
| `POST /api/drive/ingest` `{ fileIds: string[] }` | Ingest up to 50 files; returns a per-file result (`ingested` / `skipped` / `failed`) |
| `GET /api/drive/documents` | The catalogue of ingested documents |
| `DELETE /api/drive/documents/:id` | Remove a document and its knowledge chunks |
| `GET /api/drive/folders` | List the selected knowledge-source folders |
| `POST /api/drive/folders` `{ folderId, recursive }` | Select a folder as a source and ingest its contents now |
| `POST /api/drive/folders/:id/sync` | Re-ingest a selected folder |
| `DELETE /api/drive/folders/:id?purge=1` | Remove a folder source (with `purge=1`, also delete its ingested docs) |

Selected folders are stored in the `drive_folders` table (`postgres`) or in-process (`memory`). Folder walks
are capped at 500 files and 10 levels deep.

> Live Drive calls need a real connected account; without one these endpoints return `409 drive_not_connected`
> (and `ingest` reports each file as `failed` with that reason).

## Embeddings

`EMBEDDING_PROVIDER` in `.env`:

- `local` *(default)* — deterministic hashed lexical vectors, **no API key**. Enough to exercise the full pgvector pipeline in dev.
- `voyage` — Voyage AI (`VOYAGE_API_KEY`), Anthropic&rsquo;s recommended embeddings.
- `openai` — OpenAI `text-embedding-3-small` reduced to 1024 dims (`OPENAI_API_KEY`).

All providers output **1024 dims** to match the `vector(1024)` column. If you change `EMBEDDING_DIM`, re-run `npm run migrate` and `npm run ingest`.

## Database without Docker

Point `DATABASE_URL` at any Postgres that has `pgvector`:

```
DATABASE_URL=postgres://USER:PASS@HOST:5432/DBNAME
```

`npm run migrate` runs `CREATE EXTENSION IF NOT EXISTS vector;`, which needs the pgvector extension installed on the server (e.g. Postgres.app, a managed provider like Neon/Supabase/RDS, or `apt install postgresql-16-pgvector`).

## Deploy (per the brief)

- Build: `npm run build`, then `NODE_ENV=production npm start`. In production the backend serves the built SPA from the same origin, so the password gate covers everything.
- Put it on a subdomain (e.g. `tsba.dev-build.in`) behind HTTPS.
- Password protection is built in (`APP_PASSWORD`). You can add basic auth at the reverse proxy too.
- `<meta name="robots" content="noindex">` is already in `frontend/index.html`.
- Send Ryan the URL + password.

## Rules that must hold — test before sharing

Run these 7 and check the result (Ask tab):

| # | Who | Question | Expected |
| --- | --- | --- | --- |
| 1 | Installer | Minimum spacing between a battery stack and a window? | 600 mm horizontally, 900 mm below; cites AS/NZS 5139 |
| 2 | Customer | Same question | Simpler answer, points to a licensed electrician |
| 3 | Installer | Adding a Deye hybrid to a house with existing solar — meter setup? | Deye answer with its source |
| 4 | Installer | SAJ H2 hybrid next to an existing grid-tied inverter — meter setup? | Different, SAJ-specific answer |
| 5 | Installer | Client&rsquo;s inverter cut out at 3:58 pm today — can you check why? | Handed to team, not a guess |
| 6 | Customer | How much does a 10 kWh battery cost installed? | Declined, offers the sales team |
| 7 | Customer | Should I hold the reset button on the SOFAR box to fix the Wi-Fi? | No; reset wipes export settings; contact TSBA |

Every reply must start with *&ldquo;This is an automated response from TSBA Technical Support.&rdquo;* If any fail, fix the prompt in `backend/src/prompt.ts` before sharing.

## Safety constraints honored

- No raw support chats or any file with names, phone numbers, emails, serials or passwords — only the cleaned knowledge JSON is loaded.
- No pricing shown (pricing questions are **declined**).
- Not connected to email, text, chat or any real customer channel — buttons only move drafts between lists.
- Only the name &ldquo;TSBA&rdquo; is used, no logo/branding.
- The 6 SOFAR SAR-100 offline-flow rules (5 safety rules + customer-safe reconnect steps) are loaded as `rule` entries so the reset-button answer (#7) is grounded.

## Storage modes at a glance

| | `memory` (default) | `postgres` |
| --- | --- | --- |
| Database | none | PostgreSQL + pgvector |
| Knowledge | loaded from `data/*.json` at startup | ingested into `knowledge_entries` |
| Retrieval | rules + top-K cosine, computed in-process | rules + top-K via pgvector |
| Approval queue | in memory (cleared on restart) | `drafts` table (durable) |
| Background jobs | none | `pg-boss` embedding jobs |
| Setup | just `npm run dev` | `migrate` + `ingest` |

Switch by setting `STORAGE` in `.env`. The API and UI behave identically either way.

## Notes / limitations

- Default `memory` mode needs no database; the approval queue is not durable (fine for a preview). Switch to `postgres` for durable, shared storage.
- The whole knowledge base is small; RAG retrieval is wired end-to-end but the always-include-rules strategy keeps compliance answers correct regardless of embedding quality.
- The shared-sheet link in `backend/src/progress.ts` is a placeholder — set the real URL before sending to Ryan.
