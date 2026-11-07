# TERMINAL-AI — AI Coding Agent Mini App (Telegram Serverless)

An autonomous coding agent that runs entirely on **Telegram Serverless (tgcloud)** —
no server, no npm packages at runtime. It chats in Persian, writes code, and can
actually operate on **GitHub**, **GitLab** and **Google Drive**, all from a
dark "hacker terminal" Mini App.

```
Telegram chat ──► tgcloud/handlers/message.js ──┐
                                                ├──► lib/ai.js (failover)
Mini App (miniapp/) ──► tgcloud/endpoints/*.js ─┘        │
                                                          ▼
                                    lib/actions.js (whitelist)
                                                          │
                        ┌─────────────────────────────────┼──────────────────┐
                        ▼                                 ▼                  ▼
                  github.js                          gitlab.js           gdrive.js
                (REST v3)                           (REST v4)        (v3 + JWT auth)
```

## What it does

| Area | Features |
|------|----------|
| **Chat** | Persian-first agent, full conversation memory, history in the Mini App and in the bot |
| **Code** | Writes complete files, reads existing ones before editing, explains commits |
| **GitHub** | list/read files, commits, issues, Actions runs, create/update/delete files, branches, PRs, issues, workflow dispatch |
| **GitLab** | same shape: files, commits, branches, merge requests, pipelines |
| **Google Drive** | list/search/read, upload text, update, create folders, trash, share |
| **Safety** | per-operation whitelist, one-shot approval tokens for destructive writes, secret redaction everywhere |

## Project layout

```
tgcloud.jsonc                 static: "miniapp" → Mini App hosting
miniapp/index.html            the whole terminal UI (no build step)
tgcloud/
  schema.js                   chats · messages · agent_actions · approvals
  lib/
    config.example.js         template — copy to config.js
    settings.js               single reader of config.js, with defaults
    ai.js                     Gemini/Grok/DeepSeek transport + failover + agent loop
    prompt.js                 system prompt + action protocol + action catalog
    actions.js                whitelist + executor (the trust boundary)
    github.js  gitlab.js  gdrive.js
    jwt.js                    RS256 signer (WebCrypto or pure JS) for Google
    http.js                   fetch wrapper: retries, timeouts, Persian errors
    encoding.js  text.js      UTF-8/base64, JSON scanning, Telegram markdown
    security.js               allowlist, redaction, integration status
    store.js  approvals.js    persistence + confirmation flow
  endpoints/                  agent · getHistory · getStatus · approve · clearHistory
  handlers/                   message · callback_query
tests/                        node:test suite with an offline `sdk` stub
```

## Setup (Termux)

```bash
pkg install nodejs git
git clone <this repo> && cd my-telegram-agent
npm install                 # only the tgcloud CLI (dev only)
npx tgcloud login           # link the bot
cp tgcloud/lib/config.example.js tgcloud/lib/config.js
```

Fill in `tgcloud/lib/config.js` (it is gitignored — never commit it):

| Key | Where to get it |
|-----|-----------------|
| `GEMINI_API_KEY` | https://aistudio.google.com/apikey |
| `XAI_API_KEY` | https://console.x.ai — Grok (OpenAI-compatible) |
| `DEEPSEEK_API_KEY` | https://platform.deepseek.com/api_keys |
| `AI_FALLBACK_ORDER` | default `['gemini', 'grok', 'deepseek']` — the order providers are tried in |
| `GEMINI_MODEL` / `XAI_MODEL` / `DEEPSEEK_MODEL` | model ids; defaults are in the template |
| `GITHUB_TOKEN` | classic token with `repo` + `workflow`, or fine-grained Contents/PR/Actions RW |
| `GITHUB_DEFAULT_REPO` | `owner/name` used when the user does not name a repo |
| `GITLAB_TOKEN`, `GITLAB_DEFAULT_PROJECT` | GitLab PAT with `api` scope |
| `GOOGLE_SERVICE_ACCOUNT` | service-account JSON object (share the target folder with its `client_email`) |
| `GOOGLE_DRIVE_FOLDER_ID` | the folder id from the Drive URL |
| `MINIAPP_URL` | printed by `npx tgcloud push` as `Static: https://app<id>.tgcloud.ai/` |
| `ALLOWED_USER_IDS` | **[1]** — strongly recommended; empty means anyone who finds the bot |

Deploy:

```bash
npx tgcloud status          # see what will change
npx tgcloud push            # modules + miniapp/
npx tgcloud migrate         # apply the schema (push never does)
```

Then send `/start` to the bot: the button opens the Mini App, and the chat menu
button is set to it as well.

## Model failover

One turn is answered by the first provider in `AI_FALLBACK_ORDER` that works:

```
gemini ──429/403/5xx/timeout──► grok ──403/5xx/timeout──► deepseek ──► one error
```

- a provider call is **one** attempt: no retries, so a rate-limited provider is
  skipped immediately instead of eating the next provider's time;
- a call that hangs for more than `AI_TIMEOUT_MS` (default **15s**) is aborted
  (`AbortController`) and the next provider runs;
- an OpenAI-compatible provider answers through the same neutral prompt: the
  adapters in `lib/ai.js` convert it to `contents`/`parts` for Gemini and to
  `messages`/`max_tokens` with `Authorization: Bearer <key>` for Grok and DeepSeek;
- the Mini App shows `[System: Handled by Grok 🚀]` under the answer, paints the
  answering badge green and the failed-over ones red, and the bot adds a short
  "🔁 پاسخ از X آمد" line when a fallback happened;
- if every provider fails, the turn raises one error that lists what each
  provider said, with keys redacted.

## How the agent executes real work

The model cannot call APIs directly. It emits a fenced JSON block:

````
```action
{"service":"github","action":"create_file","params":{"repo":"acme/site","path":"src/a.js","content":"..."}}
```
````

`lib/actions.js` validates the name against a **closed whitelist** and runs the
typed function; the result is fed back to the model for a human summary. There is
no generic "call this URL" action, so a prompt-injected model still cannot reach
an arbitrary host. Limits: `MAX_ACTIONS_PER_TURN`, `MAX_AGENT_STEPS`, and a
42-second wall-clock budget per turn.

Destructive operations (`delete_file`, `trash_file`, `share_file`, workflow and
pipeline triggers, and `update_file` when `REQUIRE_CONFIRMATION` is on) are not
executed: they come back as a **one-shot approval token** bound to the caller's
verified Telegram id, and only `endpoints/approve.js` runs them.

## Mini App

Open it from the bot. It provides:

- a scrolling terminal with markdown-ish rendering, syntax-tinted code blocks and copy buttons
- a typing indicator while the agent works, plus one line per executed operation
- connection badges (GitHub / GitLab / Drive) that probe the real APIs, plus live **AI provider badges** (Gemini · Grok · DeepSeek): green for the model that answered the last request, red for the ones that failed over, faded when no key is configured
- approval cards for destructive actions, a quick-command panel, JSON history export
- safe-area handling, keyboard-aware layout, haptics, and a message queue so nothing typed is lost

The page talks to the backend only through `Telegram.WebApp.Serverless.call(...)`,
which sends the verified init data; the Mini App never sees a token or key.

## Tests

```bash
npm test        # 43 tests, offline: links tests/stubs/sdk and runs node:test
```

The suite covers base64/UTF-8 round-trips, SHA-256 and RSA vectors, the action
parser, the approval token lifecycle, secret redaction, conversation storage,
and the GitHub/GitLab/Drive clients against a mocked HTTP layer — verifying that
tokens travel in headers and never in URLs or error messages.

## Endpoints

| Name | Input | Purpose |
|------|-------|---------|
| `agent` | `{ prompt }` | one agent turn; returns `{ output, actions, pending }` |
| `getHistory` | `{ limit?, before? }` | paginated conversation for the terminal |
| `getStatus` | `{}` | live connection status for each integration |
| `approve` | `{ token, decision }` | run or reject a pending destructive action |
| `clearHistory` | `{ confirm: true }` | wipe the caller's conversation |

Run one locally:

```bash
npx tgcloud run endpoints/agent '{"prompt":"سلام"}' --ctx '{ initData: { user: { id: 1 } } }'
```

## Notes and limits

- **No npm at runtime.** Only `sdk` (`db`, `api`, `fetch`) and project modules.
  Google auth uses a hand-written RS256 signer because the isolate has no
  `crypto` module; WebCrypto is used when the runtime provides it.
- **Files up to ~900 KB** through the GitHub contents API. Larger files would
  need the Git Data API (blobs + trees).
- **One conversation per user** (`chats.user_id` is unique); the Telegram chat
  and the Mini App share it.
- Persian responses are the default; the model mirrors the user's language.
