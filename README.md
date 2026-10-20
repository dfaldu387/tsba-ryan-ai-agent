# TSBA Assistant · Preview

A password-protected web preview of the **TSBA Technical Support assistant**. One page, two tabs:

- **Ask** — pick who&rsquo;s asking (Customer / Installer / Sales rep) and the channel (Chat / Text / Email), type a question, and get a cited draft reply with **Approve & send / Edit / Reject**. Replies only move between the *Waiting / Handed to team / Sent* lists — nothing is sent to any real channel.
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

## Setup — with Postgres + pgvector (optional)

Turn this on when you want durable storage and the background job queue. Set `STORAGE=postgres` in `.env`, then:

```bash
docker compose up -d          # or point DATABASE_URL at your own Postgres — see below
npm run migrate               # create the schema
npm run ingest -- --inline    # load knowledge + embeddings (omit --inline to use the background queue)
npm run dev
```

> **Background-jobs path:** run `npm run ingest` *without* `--inline` to enqueue durable `embed-entry` jobs. Start the backend (`npm run dev`) and its `pg-boss` worker processes them in the background. `--inline` is just a convenience for a one-shot setup with no server running.
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
