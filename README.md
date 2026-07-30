# SynthiaClaw

SynthiaClaw is a local-first chat workspace with a Fastify backend, React/Vite
frontend, shared Zod contracts, SQLite conversation persistence, and an
OpenAI-compatible streaming model provider. Agent conversations can use either
an API key or a ChatGPT subscription through the official Codex app-server
OAuth flow.

## Requirements

- Node.js 22 or newer
- One model-provider option:
  - An OpenAI-compatible chat-completions endpoint and API key
  - The Codex CLI plus a ChatGPT plan that supports Codex

## Configure

Copy `.env.example` to `.env`, then choose one provider.

### ChatGPT/Codex subscription

Install the Codex CLI and make sure `codex --version` works in the same shell
that starts SynthiaClaw. Select subscription mode:

```powershell
$env:MODEL_PROVIDER = "codex"
npm.cmd run dev
```

Open `http://127.0.0.1:5173` and select **Connect ChatGPT**. SynthiaClaw asks
the local Codex app-server to start OpenAI's browser OAuth flow. Codex stores
and refreshes the credentials; OAuth tokens are never sent to the frontend or
stored in SynthiaClaw's SQLite database.

`CODEX_COMMAND` can point to a specific Codex executable.
`CODEX_WORKING_DIRECTORY` controls the working directory supplied to Codex and
defaults to the backend process directory. `CODEX_MODEL` is optional; when it
is omitted, Codex chooses its configured default model.

Each completion uses an ephemeral, read-only Codex thread with approvals
disabled. The four SynthiaClaw server tools are exposed through Codex dynamic
tools; Codex itself does not receive unrestricted filesystem access. Previously
persisted messages are injected as conversation context. Assistant text and
tool activity stream to the UI while the turn runs, but only the final
assistant response is persisted. Cancelled and disconnected runs discard
partial assistant text. Subscription mode requires a ChatGPT-authenticated
Codex account; an API-key Codex login is deliberately rejected to prevent
accidental API billing.

### OpenAI-compatible API

API-key mode remains the default. Set `OPENAI_API_KEY` and `OPENAI_MODEL`;
`OPENAI_BASE_URL` defaults to `https://api.openai.com/v1`:

```powershell
$env:MODEL_PROVIDER = "openai"
$env:OPENAI_API_KEY = "your-key"
$env:OPENAI_MODEL = "your-model"
$env:OPENAI_BASE_URL = "https://api.openai.com/v1"
npm.cmd run dev
```

PowerShell does not automatically load `.env`, so either load these values
into the backend process as shown or use your preferred environment loader.

The backend binds to `127.0.0.1:3001`, the frontend binds to
`127.0.0.1:5173`, and SQLite data is stored at `data/synthia.sqlite` by
default. Override these with `HOST`, `PORT`, and `DATABASE_PATH`.

## Agent tools and limits

The server registry exposes `current_time`, `list_files`, `read_file`, and
`write_file`. Every tool argument object is validated on the backend.
Filesystem paths must be relative and stay inside `TOOL_WORKSPACE_ROOT`, which
defaults to `CODEX_WORKING_DIRECTORY` and then the backend process directory.

Agent runs default to at most 8 model iterations and 30 seconds. Override these
with positive integer values in `AGENT_MAX_ITERATIONS` and
`AGENT_TIMEOUT_MS`. Tool calls and results are sent to the browser as they
occur so they remain visible between the user request and final response.

Open `http://127.0.0.1:5173`, create a conversation, and send a message.
Sessions and messages remain available after refreshing the page or restarting
the backend.

## Commands

```powershell
npm.cmd install --cache .npm-cache
npm.cmd run dev
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
```

REST endpoints:

- `GET /api/health`
- `GET /api/provider`
- `POST /api/provider/codex/login`
- `POST /api/provider/codex/logout`
- `GET /api/sessions`
- `POST /api/sessions`
- `GET /api/sessions/:id`
- `GET /api/sessions/:id/messages`

Chat uses WebSocket endpoint `/api/chat`. Model credentials and SQLite access
remain backend-only.

The WebSocket protocol uses request and run IDs for correlation:

- Client events: `chat.send`, `run.cancel`
- Server lifecycle events: `run.started`, `assistant.delta`, `tool.call`,
  `tool.result`, `assistant.completed`, `run.cancelled`, `run.failed`

The backend aborts the upstream provider when a run is cancelled or its socket
disconnects. Request IDs are idempotency keys: retrying a completed request
replays its terminal event without duplicating either persisted message.
