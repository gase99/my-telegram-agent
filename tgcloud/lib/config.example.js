// tgcloud/lib/config.example.js — TEMPLATE ONLY.
//
// Copy this file to `tgcloud/lib/config.js` and fill in your own secrets:
//
//     cp tgcloud/lib/config.example.js tgcloud/lib/config.js
//
// `tgcloud/lib/config.js` is gitignored on purpose: it holds API keys and is
// uploaded to the platform on `push`, but never committed to Git.
// Never put a real key in this example file.

// ── AI (Google Gemini) ──────────────────────────────────────────────────────
// https://aistudio.google.com/apikey
export const GEMINI_API_KEY = '';
export const GEMINI_MODEL = 'gemini-3.5-flash';
export const GEMINI_TEMPERATURE = 0.7;
// Thinking models bill reasoning tokens too; keep this well above 512.
export const GEMINI_MAX_OUTPUT_TOKENS = 8192;

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
