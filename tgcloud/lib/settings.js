// tgcloud/lib/settings.js — the one place that reads lib/config.js.
//
// Why a layer: `config.js` is gitignored, so a deployment can have an older
// copy without a key that newer code expects. Reading it through this module
// means every missing value gets a sane default instead of `undefined` leaking
// into a request, and every module imports one object instead of nine
// constants.

import * as config from './config.js';

const str = (value, fallback = '') => (typeof value === 'string' ? value : fallback);

const int = (value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), min), max);
};

const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);

/** Telegram user ids from config, accepting numbers or numeric strings. */
const idList = (value) =>
  (Array.isArray(value) ? value : [])
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item) && item > 0);

/** A service-account key can be an object or a JSON string; normalise to an object. */
function serviceAccount(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return normaliseAccount(raw);
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' ? normaliseAccount(parsed) : null;
  } catch {
    return null;
  }
}

function normaliseAccount(account) {
  const copy = { ...account };
  // A key pasted into JSON often keeps escaped newlines.
  if (typeof copy.private_key === 'string') copy.private_key = copy.private_key.replace(/\\n/g, '\n');
  return copy;
}

export const settings = {
  // AI
  geminiApiKey: str(config.GEMINI_API_KEY),
  geminiModel: str(config.GEMINI_MODEL) || 'gemini-3.5-flash',
  geminiTemperature: Number.isFinite(Number(config.GEMINI_TEMPERATURE)) ? Number(config.GEMINI_TEMPERATURE) : 0.7,
  geminiMaxOutputTokens: int(config.GEMINI_MAX_OUTPUT_TOKENS, 8192, { min: 512, max: 65536 }),

  // GitHub
  githubToken: str(config.GITHUB_TOKEN),
  githubDefaultRepo: str(config.GITHUB_DEFAULT_REPO),
  githubDefaultBranch: str(config.GITHUB_DEFAULT_BRANCH) || 'main',

  // GitLab
  gitlabToken: str(config.GITLAB_TOKEN),
  gitlabDefaultProject: str(config.GITLAB_DEFAULT_PROJECT),
  gitlabBaseUrl: (str(config.GITLAB_BASE_URL) || 'https://gitlab.com').replace(/\/+$/, ''),
  gitlabDefaultBranch: str(config.GITLAB_DEFAULT_BRANCH) || 'main',

  // Google
  googleServiceAccount: serviceAccount(config.GOOGLE_SERVICE_ACCOUNT),
  googleDriveFolderId: str(config.GOOGLE_DRIVE_FOLDER_ID),

  // Telegram Mini App
  miniappUrl: str(config.MINIAPP_URL),

  // Agent behaviour
  allowedUserIds: idList(config.ALLOWED_USER_IDS),
  maxHistory: int(config.MAX_HISTORY, 18, { min: 2, max: 100 }),
  maxActionsPerTurn: int(config.MAX_ACTIONS_PER_TURN, 4, { min: 1, max: 10 }),
  maxAgentSteps: int(config.MAX_AGENT_STEPS, 3, { min: 1, max: 6 }),
  requireConfirmation: bool(config.REQUIRE_CONFIRMATION, true),
  timezone: str(config.TIMEZONE) || 'UTC',
};

/** True when the key required for a service is present. Never exposes it. */
export function isConfigured(service) {
  switch (service) {
    case 'github': return Boolean(settings.githubToken);
    case 'gitlab': return Boolean(settings.gitlabToken);
    case 'gdrive': return Boolean(settings.googleServiceAccount?.client_email && settings.googleServiceAccount?.private_key);
    case 'gemini': return Boolean(settings.geminiApiKey);
    default: return false;
  }
}

/** Which integrations have credentials configured (values never returned). */
export function integrationStatus() {
  return {
    gemini: isConfigured('gemini'),
    github: isConfigured('github'),
    gitlab: isConfigured('gitlab'),
    gdrive: isConfigured('gdrive'),
  };
}
