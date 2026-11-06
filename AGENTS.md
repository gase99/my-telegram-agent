# AGENTS.md

Repo-specific operating notes for coding agents. Keep this file aligned with the executable code; the SDK reference is in [docs/tgcloud-sdk.md](docs/tgcloud-sdk.md).

## Runtime and layout

- This is a `tgcloud` serverless Telegram bot plus a Telegram Mini App, not a conventional Node server. Bot modules run in a V8 isolate; do not use Node built-ins, filesystem access, or npm packages from `tgcloud/` at runtime. Only the platform `sdk` and project modules are available.
- Deployed code is under `tgcloud/`: `schema.js`, `handlers/`, `endpoints/`, and `lib/`. The Mini App static directory is `miniapp/`, selected by `tgcloud.jsonc` (`"static": "miniapp"`); it is served as-is, with no build step currently configured.
- Main flow: `handlers/message.js` stores Telegram text messages, loads the latest 20 messages for the chat, calls `lib/beatapi.js`, stores the assistant reply, then sends it through the Telegram Bot API. The Mini App calls `endpoints/agent.js` with `{ prompt }`; that endpoint calls the same `chat()` helper and returns `{ output }`. `endpoints/history.js` reads the `messages` table for the verified Mini App user.
- `lib/beatapi.js` calls the Gemini Generative Language API; the model identifier and request format are defined there. Verify provider/model compatibility before changing them.

## Non-obvious platform rules

- Import project modules with relative paths **including `.js`** (for example, `../schema.js`); import platform modules by name (for example, `sdk`, `sdk/db`).
- A handler receives the update-type payload as its first argument (for `handlers/message.js`, a Telegram `Message`), not the full `Update`; use `ctx.update` if the full update is needed.
- An endpoint receives `(input, ctx)`; the Mini App JSON body is `input`, and verified Telegram identity is `ctx.initData.user`. There is no `ctx.user`.
- Await every database operation. Foreign keys are unsupported and declarations using `.references()` / `foreignKey()` fail. Schema changes are applied only by the explicit migration command, not by deploy.
- Do not import Mini App code into `tgcloud/`; the Mini App communicates with server modules through `Telegram.WebApp.Serverless.call()` and named endpoints.

## Setup and commands

- Root `package.json` has only `deploy`, `status`, and `run` scripts; it defines no test, lint, typecheck, or build script. The CLI is the `@tgcloud/cli` dev dependency (Node.js >=18).
- Install local dependencies with `npm install`; link the project to a bot with `npx tgcloud login`.
- Inspect pending changes with `npx tgcloud status`.
- Run an endpoint locally with the CLI, supplying a test context when it reads Telegram identity, e.g.:
  `npx tgcloud run endpoints/agent '{"prompt":"ping"}' --ctx '{ initData: { user: { id: 1 } } }'`
- `npm run deploy` is an alias for `tgcloud push`. Push deploys modules and the current `miniapp/` static files; it does **not** build the front end or migrate the database.
- After changing `tgcloud/schema.js`, inspect status, push the modules, then run `npx tgcloud migrate` and review the interactive migration before applying it. Never assume deploy applied schema changes.
- Useful operational checks: `npx tgcloud webhook` to inspect webhook alignment; `npx tgcloud webhook sync` to repair drift.

## Project-specific cautions

- `tgcloud/lib/config.js` is intentionally gitignored and imported by `lib/beatapi.js` for `GEMINI_API_KEY`. Never print, log, commit, or expose its contents; do not replace it with a hard-coded key.
- Current persistence is asymmetric: the Telegram handler stores messages by `msg.chat.id`, while Mini App history reads by `ctx.initData.user.id` (these match in a private chat, not necessarily in a group). The Mini App `agent` endpoint currently does not persist its prompts or responses. Preserve this behavior unless the requested change explicitly addresses conversation storage.
- The Mini App sends endpoint requests through the official `Telegram.WebApp.Serverless.call()` API. Keep Telegram init-data verification in the platform path; do not invent a client-supplied user ID as authentication.
- The message handler sends assistant text with Telegram `parse_mode: 'Markdown'`; account for Telegram Markdown constraints when changing response formatting.
- No source files should be changed during a read-only audit. Report findings and a prioritized plan first, and wait for explicit approval before implementation. Never delete existing code or expose credentials.
