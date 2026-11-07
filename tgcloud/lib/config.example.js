// tgcloud/lib/config.example.js — TEMPLATE ONLY.
//
// Copy this file to `tgcloud/lib/config.js` and fill in your own secrets:
//
//     cp tgcloud/lib/config.example.js tgcloud/lib/config.js
//
// `tgcloud/lib/config.js` is gitignored on purpose: it holds API keys and is
// uploaded to the platform on `push`, but never committed to Git.
// Never put a real key in this example file.

// ── AI providers (automatic failover) ───────────────────────────────────────
// Every provider is optional: only the ones with a key are attempted, in the
// order of AI_FALLBACK_ORDER below. A provider that answers 429 / 403 / 5xx,
// hangs for longer than AI_TIMEOUT_MS, or returns an empty answer is logged
// and skipped, and the next provider answers instead. `lib/ai.js` holds the
// adapters (Gemini uses `contents`/`parts`; Grok and DeepSeek are
// OpenAI-compatible and use `messages`).

// Google Gemini — https://aistudio.google.com/apikey
// Endpoint: {GEMINI_BASE_URL}/models/{GEMINI_MODEL}:generateContent
export const GEMINI_API_KEY = '';
export const GEMINI_MODEL = 'gemini-3.5-flash';
export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

// xAI Grok (OpenAI compatible) — https://console.x.ai
// Endpoint: {XAI_BASE_URL}/chat/completions  (Authorization: Bearer <key>)
// The default is xAI's fast non-reasoning model; swap it for another id from
// https://docs.x.ai/docs/models if your account does not have it.
export const XAI_API_KEY = '';
export const XAI_MODEL = 'grok-4-fast-non-reasoning';
export const XAI_BASE_URL = 'https://api.x.ai/v1';

// DeepSeek (OpenAI compatible) — https://platform.deepseek.com/api_keys
// Endpoint: {DEEPSEEK_BASE_URL}/chat/completions  (Authorization: Bearer <key>)
// `deepseek-chat` is the general model; `deepseek-reasoner` is slower and
// often exceeds the 15s provider timeout, so it is a poor failover target.
export const DEEPSEEK_API_KEY = '';
export const DEEPSEEK_MODEL = 'deepseek-chat';
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

// Which provider answers first. Names: 'gemini' | 'grok' | 'deepseek'
// ('xai' is accepted as an alias for 'grok'). Unknown names are ignored and
// providers without a key are skipped without counting as a failure.
export const AI_FALLBACK_ORDER = ['gemini', 'grok', 'deepseek'];
// Per-provider deadline. A provider that hangs is aborted and the next one is
// tried. Keep this well under the platform's endpoint limit (the agent turn
// itself is capped at 42s and shares this budget across the chain).
export const AI_TIMEOUT_MS = 15000;

// ── Generation knobs (shared by all providers) ──────────────────────────────
// The GEMINI_* names are kept for older deployments; the AI_* values win.
export const GEMINI_TEMPERATURE = 0.7;
// Thinking models bill reasoning tokens too; keep this well above 512.
export const GEMINI_MAX_OUTPUT_TOKENS = 8192;
// export const AI_TEMPERATURE = 0.7;
// export const AI_MAX_OUTPUT_TOKENS = 8192;

// ── GitHub ──────────────────────────────────────────────────────────────────
// Classic token with `repo` + `workflow` scopes, or a fine-grained token with
// Contents / Pull requests / Actions / Issues read-write.
export const GITHUB_TOKEN = '';
// Default target, e.g. 'gase99/my-telegram-agent' (used when the model omits it).
export const GITHUB_DEFAULT_REPO = '';
export const GITHUB_DEFAULT_BRANCH = 'main';

// ── GitLab ──────────────────────────────────────────────────────────────────
// Personal access token with `api` scope.
export const GITLAB_TOKEN = '';
// 'group/project' or the numeric project id.
export const GITLAB_DEFAULT_PROJECT = '';
export const GITLAB_BASE_URL = 'https://gitlab.com';
export const GITLAB_DEFAULT_BRANCH = 'main';

// ── Google Drive (service account) ──────────────────────────────────────────
// Paste the whole service-account JSON, either as an object or as a string.
// Share the target Drive folder with the `client_email` of the account.
export const GOOGLE_SERVICE_ACCOUNT = null;
// export const GOOGLE_SERVICE_ACCOUNT = {
//   client_email: 'bot@project.iam.gserviceaccount.com',
//   private_key: '-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----\n',
// };
// Folder every Drive operation defaults to. The service account must have
// access to it (Editor) or Drive will answer 403/404.
export const GOOGLE_DRIVE_FOLDER_ID = '';

// ── Telegram Mini App ───────────────────────────────────────────────────────
// The URL printed by `npx tgcloud push` as "Static: https://app<id>.tgcloud.ai/".
// Used by the /app button and the chat menu button.
export const MINIAPP_URL = '';

// ── Agent behaviour / security ──────────────────────────────────────────────
// Optional allowlist of Telegram user ids allowed to use the bot. Empty = the
// owner of the token only? No: empty means everyone who finds the bot. Set it.
export const ALLOWED_USER_IDS = [];
// How many previous messages are sent to the model.
export const MAX_HISTORY = 18;
// How many actions one user turn may execute (hard stop against loops).
export const MAX_ACTIONS_PER_TURN = 4;
// Extra model round-trips after the first answer (1 = execute, then summarise).
export const MAX_AGENT_STEPS = 3;
// Destructive actions (delete file/branch, overwrite a repo file) require the
// user to approve them from the Mini App.
export const REQUIRE_CONFIRMATION = true;
export const TIMEZONE = 'Europe/Berlin';
