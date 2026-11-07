# AGENTS.md

Repo-specific operating notes for coding agents. Keep this file aligned with the
executable code; the SDK reference is in [docs/tgcloud-sdk.md](docs/tgcloud-sdk.md).

## Runtime and layout

- This is a `tgcloud` serverless Telegram bot plus a Telegram Mini App, not a conventional Node server. Bot modules run in a V8 isolate; do not use Node built-ins, filesystem access, or npm packages from `tgcloud/` at runtime. Only the platform `sdk` and project modules are available.
- Deployed code is under `tgcloud/`: `schema.js`, `handlers/`, `endpoints/`, and `lib/`. The Mini App static directory is `miniapp/`, selected by `tgcloud.jsonc` (`"static": "miniapp"`); it is served as-is, with no build step.
- Main flow: `handlers/message.js` handles commands (`/start`, `/status`, `/clear`, `/id`), otherwise stores the message and calls `lib/ai.js#runAgent`; the Mini App calls `endpoints/agent.js` with `{ prompt }`, which runs the same agent and persists both sides of the conversation. Both read `recentMessages` **before** inserting the new prompt, because `runAgent` receives that prompt separately and the stored copy would otherwise be sent twice.
- The agent loop lives in `lib/ai.js`: `generate()` → `generateWithFallback()` asks the providers in `AI_FALLBACK_ORDER` (gemini → grok → deepseek → kimi by default) until one answers, `parseActions()` extracts the model's requested operations, `lib/actions.js` validates and executes them, and the results are fed back for a Persian summary. `runAgent` is bounded by `MAX_AGENT_STEPS`, `MAX_ACTIONS_PER_TURN`, and a 42s wall-clock budget. Running out of budget (or a failed narrating round-trip) never discards executed work: the reply is built from the tool results by `fallbackSummary()` and `fallback: true` says so.
- Failover contract: the chain is `AI_FALLBACK_ORDER` followed by every keyed provider that the order omits (`chainFor()`), so pasting a new provider's key into a `config.js` that predates it still puts it last in the chain; an explicitly listed position always wins. One provider call = one attempt, no retries. A 401/403/404/429/5xx, a network error, a timeout (`AI_TIMEOUT_MS`, 15s), or an empty/blocked answer records the failure in `attempts`, logs it with `console.warn`, and moves to the next provider. `generateWithFallback` returns `{ text, provider, model, usage, attempts }`; `summariseAttempts()` turns that into the `active`/`failed`/`skipped`/`idle` badges the Mini App paints; `endpoints/agent.js` exposes it as `provider`, `providerLabel`, `providers`.
- The model may only request the operations listed in the `CATALOG` of `lib/actions.js`. There is deliberately no generic HTTP action: adding one would break the security model.
- Destructive operations go through `lib/approvals.js`: a one-shot token is stored, returned to the Mini App, and only `endpoints/approve.js` executes it. The token row is deleted inside the approve call, so replays fail.
- Integration clients: `lib/github.js`, `lib/gitlab.js`, `lib/gdrive.js`. Their HTTP goes through `lib/http.js` (retries on 429/5xx, timeouts, Persian error messages). The AI providers are the deliberate exception: `lib/ai.js` calls `fetch` from `sdk` directly so it can abort one provider at its own deadline (`AbortController` + a `Promise.race` guard), avoid retries that would eat the next provider's time, and keep the key in a header (`x-goog-api-key`, `Authorization: Bearer …`) instead of a URL. `lib/jwt.js` signs Google's service-account assertion because the isolate has no `crypto` module — WebCrypto is used when present, otherwise a local RS256 implementation (verified against Node's crypto in `tests/`).

## Non-obvious platform rules

- Import project modules with relative paths **including `.js`** (for example, `../schema.js`); import platform modules by name (for example, `sdk`, `sdk/db`).
- A handler receives the update-type payload as its first argument (for `handlers/message.js`, a Telegram `Message`), not the full `Update`; use `ctx.update` if the full update is needed.
- An endpoint receives `(input, ctx)`; the Mini App JSON body is `input`, and verified Telegram identity is `ctx.initData.user`. There is no `ctx.user`.
- Await every database operation. Foreign keys are unsupported and declarations using `.references()` / `foreignKey()` fail. Schema changes are applied only by the explicit migration command, not by deploy.
- Do not import Mini App code into `tgcloud/`; the Mini App communicates with server modules through `Telegram.WebApp.Serverless.call()` and named endpoints.
- A table descriptor exposes its columns as properties (`chats.userId`); query helpers compare those column refs, never raw strings.

## Configuration and secrets

- `tgcloud/lib/config.js` is intentionally gitignored and deployed with the code. `tgcloud/lib/config.example.js` is the committed template — keep the two in sync when adding a key. `npm test` copies the template to `config.js` when the file is missing, so a fresh clone runs offline.
- AI keys: `GEMINI_API_KEY`, `XAI_API_KEY`, `DEEPSEEK_API_KEY`, `MOONSHOT_API_KEY` (alias `KIMI_API_KEY`). Empty primary values must not mask populated aliases (use string `||`, not `??`). Any subset may be set; providers without a key are skipped (never counted as failures). `AI_FALLBACK_ORDER` decides the order and accepts `xai` / `moonshot` as aliases for `grok` / `kimi`. Each has its own `*_MODEL` and `*_BASE_URL`, so a model rename never needs a code change.
- Every module reads configuration through `lib/settings.js`, never from `config.js` directly. That layer supplies defaults for keys a stale local config may lack.
- Never print, log, commit, or expose a key. `lib/security.js#redactSecrets` masks configured values and known token shapes; call it on any provider error before it reaches a response, a Telegram message, or a log line.
- `ALLOWED_USER_IDS` is the only authorization gate. An endpoint must check it *and* derive the user from `ctx.initData.user`, never from client input.

## Mini App rules

- The page is a single `miniapp/index.html` with no build step. It must not reference `localhost` or any backend URL: endpoints are called by name through `Telegram.WebApp.Serverless.call`.
- Everything rendered from model output goes through `escapeHtml`/`renderMarkdown`; never inject raw text into `innerHTML`.
- Keep `direction: ltr; unicode-bidi: isolate` on code, ids, timestamps, and prompt symbols — the page is RTL and mixed content reorders otherwise.
- Layout must follow `tg.viewportHeight` (live, not stable) plus `visualViewport`/`100dvh` outside Telegram so the composer stays above the keyboard, and use `env(safe-area-inset-*)` together with Telegram content insets for notches/chrome.
- The `#splash` overlay is dismissed by an independent 3-second timer; do not make its removal await history, status or any network request. It must remain removable when `prefers-reduced-motion` suppresses `transitionend`.

## Setup and commands

- Root `package.json` has `deploy`, `status`, `run`, and `test` scripts; `type: module`.
- Install local dependencies with `npm install`; link the project to a bot with `npx tgcloud login`.
- `npm test` links `tests/stubs/sdk` into `node_modules` and runs `node --test`. The stub implements enough of `db`/`api`/`fetch` to exercise the modules offline; it also allows injecting canned HTTP responses (`__setFetchMock`).
- Run an endpoint locally with the CLI, supplying a test context when it reads Telegram identity, e.g.:
  `npx tgcloud run endpoints/agent '{"prompt":"ping"}' --ctx '{ initData: { user: { id: 1 } } }'`
- `npm run deploy` is an alias for `tgcloud push`. Push deploys modules and the current `miniapp/` static files; it does **not** build the front end or migrate the database.
- After changing `tgcloud/schema.js`, inspect status, push the modules, then run `npx tgcloud migrate` and review the interactive migration before applying it. Never assume deploy applied schema changes.
- Useful operational checks: `npx tgcloud webhook` to inspect webhook alignment; `npx tgcloud webhook sync` to repair drift.

## Project-specific cautions

- Current persistence has two key styles: new rows carry `userId` + `chatRef` (and `chatId` for the Telegram column), while pre-agent rows carry `chatId` only. `lib/store.js` reads both (`OR` branch) and `handlers/message.js` adopts legacy rows on first contact. Do not drop the `chatId` writes — they keep history visible in both clients.
- The Telegram handler sends HTML after escaping, not Markdown: model output with a stray `*` or `_` makes Telegram reject the whole message.
- Gemini 3+ replaced the numeric `thinkingConfig.thinkingBudget` with the discrete `thinkingConfig.thinkingLevel` (`minimal`/`low`/`medium`/`high`, `AI_THINKING_LEVEL`, default `low`). Sending a budget to a 3.x/4.x model can answer `400 INVALID_ARGUMENT`, and since Gemini 3.6 custom `temperature` is ignored then rejected. `thinkingConfigFor()` in `lib/ai.js` therefore picks the knob per model family and `acceptsSamplingParams()` drops `temperature` where it is not honoured. Gemini 2.5 and earlier keep their numeric budget.
- DeepSeek V4 and Kimi K2.6+/K3 think by default, which overruns the failover deadline; the OpenAI adapter sends `thinking: { type: 'disabled' }` for those two vendor families only (`xai` rejects unknown fields), gated by `supportsThinkingSwitch()` on the model id — not on the provider name, because the switch is a property of the model.
- Model ids rot faster than this file: `grok-4-fast-*`, `deepseek-chat`/`deepseek-reasoner` and `kimi-k2-preview` were retired by their providers. The defaults are `gemini-3.5-flash` / `grok-4.3` / `deepseek-flash` / `kimi-k2.6` (Moonshot host `https://api.moonshot.ai/v1`); `settings.retiredModels()` flags a stale id from an old `config.js` in `/status` and `getStatus.model.retiredModels` instead of letting it fail as a 404 mid-conversation.
- `lib/beatapi.js` was removed in the agent rewrite; do not resurrect it. The single model entry point is `lib/ai.js` — do not add provider calls anywhere else.
- Provider payload shapes differ and the adapters are tested: Gemini uses `contents: [{ role: 'user'|'model', parts: [{ text }] }]` plus `systemInstruction` and `generationConfig`; Grok and DeepSeek are OpenAI-compatible (`messages: [{ role, content }]`, `max_tokens`, `Authorization: Bearer <key>`). Only add a provider by extending `PROVIDERS` in `lib/ai.js`, `providerKey`/`providerModel` in `lib/settings.js`, and the badge list in `miniapp/index.html` — all three places, or the UI silently drops it.
- Tests must not require network access or credentials: `settings.*` fields are mutable for the duration of a test and restored in `finally`.
