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

const num = (value, fallback) => (Number.isFinite(Number(value)) && value !== '' && value !== null ? Number(value) : fallback);

const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);

const url = (value, fallback) => (str(value) || fallback).replace(/\/+$/, '');

/** Telegram user ids from config, accepting numbers or numeric strings. */
const idList = (value) =>
  (Array.isArray(value) ? value : [])
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item) && item > 0);

/** Every provider name the failover chain understands, in canonical form. */
export const AI_PROVIDERS = ['gemini', 'grok', 'deepseek'];

/** Aliases accepted in AI_FALLBACK_ORDER (people write 'xai', 'google', …). */
const PROVIDER_ALIASES = {
  gemini: 'gemini',
  google: 'gemini',
  'google-gemini': 'gemini',
  grok: 'grok',
  xai: 'grok',
  'x-ai': 'grok',
  'x.ai': 'grok',
  deepseek: 'deepseek',
  'deep-seek': 'deepseek',
};

const DEFAULT_FALLBACK_ORDER = ['gemini', 'grok', 'deepseek'];

/**
 * Normalise AI_FALLBACK_ORDER: lowercase, resolve aliases, drop names we do
 * not implement, drop duplicates. An empty/absent value means the default
 * order, so an older config.js keeps working.
 */
export function normaliseFallbackOrder(value) {
  const source = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const order = [];
  for (const raw of source) {
    const name = PROVIDER_ALIASES[String(raw ?? '').toLowerCase().trim()];
    if (name && !order.includes(name)) order.push(name);
  }
  return order.length ? order : [...DEFAULT_FALLBACK_ORDER];
}

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

// Generation knobs: the AI_* names win, GEMINI_* keeps older configs working.
const temperature = num(
  config.AI_TEMPERATURE ?? config.GEMINI_TEMPERATURE,
  0.7
);
const maxOutputTokens = int(
  config.AI_MAX_OUTPUT_TOKENS ?? config.GEMINI_MAX_OUTPUT_TOKENS,
  8192,
  { min: 512, max: 65536 }
);

// Gemini 3+ replaced numeric thinking budgets with a discrete level.
const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high'];
const thinkingLevel = (value) => {
  const level = String(value ?? '').toLowerCase().trim();
  return THINKING_LEVELS.includes(level) ? level : 'low';
};

export const settings = {
  // ── AI: Google Gemini ────────────────────────────────────────────────────
  geminiApiKey: str(config.GEMINI_API_KEY),
  geminiModel: str(config.GEMINI_MODEL) || 'gemini-3.5-flash',
  geminiBaseUrl: url(config.GEMINI_BASE_URL, 'https://generativelanguage.googleapis.com/v1beta'),

  // ── AI: xAI Grok (OpenAI compatible) ─────────────────────────────────────
  xaiApiKey: str(config.XAI_API_KEY),
  xaiModel: str(config.XAI_MODEL) || 'grok-4.3',
  xaiBaseUrl: url(config.XAI_BASE_URL, 'https://api.x.ai/v1'),

  // ── AI: DeepSeek (OpenAI compatible) ─────────────────────────────────────
  deepseekApiKey: str(config.DEEPSEEK_API_KEY),
  deepseekModel: str(config.DEEPSEEK_MODEL) || 'deepseek-flash',
  deepseekBaseUrl: url(config.DEEPSEEK_BASE_URL, 'https://api.deepseek.com'),

  // ── AI: failover ─────────────────────────────────────────────────────────
  // Tried left to right; providers without a key are skipped.
  aiFallbackOrder: normaliseFallbackOrder(config.AI_FALLBACK_ORDER),
  // Per-provider deadline; a hanging provider is aborted and the next runs.
  aiTimeoutMs: int(config.AI_TIMEOUT_MS, 15000, { min: 1000, max: 60000 }),
  aiTemperature: temperature,
  aiMaxOutputTokens: maxOutputTokens,
  // Gemini 3+ `thinkingConfig.thinkingLevel`; older Gemini models ignore it.
  aiThinkingLevel: thinkingLevel(config.AI_THINKING_LEVEL),

  // Kept for modules/tests written before the failover layer existed.
  geminiTemperature: temperature,
  geminiMaxOutputTokens: maxOutputTokens,

  // GitHub
  githubToken: str(config.GITHUB_TOKEN),
  githubDefaultRepo: str(config.GITHUB_DEFAULT_REPO),
  githubDefaultBranch: str(config.GITHUB_DEFAULT_BRANCH) || 'main',

  // GitLab
  gitlabToken: str(config.GITLAB_TOKEN),
  gitlabDefaultProject: str(config.GITLAB_DEFAULT_PROJECT),
  gitlabBaseUrl: url(config.GITLAB_BASE_URL, 'https://gitlab.com'),
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

/** The API key a provider name maps to (never returned to a client). */
export function providerKey(name) {
  switch (name) {
    case 'gemini': return settings.geminiApiKey;
    case 'grok': return settings.xaiApiKey;
    case 'deepseek': return settings.deepseekApiKey;
    default: return '';
  }
}

/** The model id a provider name maps to. */
export function providerModel(name) {
  switch (name) {
    case 'gemini': return settings.geminiModel;
    case 'grok': return settings.xaiModel;
    case 'deepseek': return settings.deepseekModel;
    default: return '';
  }
}

/** True when the key required for a service is present. Never exposes it. */
export function isConfigured(service) {
  switch (service) {
    case 'github': return Boolean(settings.githubToken);
    case 'gitlab': return Boolean(settings.gitlabToken);
    case 'gdrive': return Boolean(settings.googleServiceAccount?.client_email && settings.googleServiceAccount?.private_key);
    case 'gemini':
    case 'grok':
    case 'deepseek': return Boolean(providerKey(service));
    default: return false;
  }
}

/**
 * Model ids that the provider has retired. They still look valid in an old
 * config.js, so the failure would only show up as a 404 mid-conversation.
 * Returned as data (never thrown) so a status call can surface it.
 */
const RETIRED_MODELS = {
  grok: (model) => /^grok-4-fast/.test(model),
  deepseek: (model) => /^deepseek-(chat|reasoner)$/.test(model),
};

/** `[{ provider, model, replacement }]` for models that no longer resolve. */
export function retiredModels() {
  return Object.entries(RETIRED_MODELS)
    .filter(([provider, isRetired]) => isRetired(providerModel(provider)))
    .map(([provider]) => ({ provider, model: providerModel(provider), replacement: defaultModel(provider) }));
}

/** The built-in model id for a provider (used as the migration hint). */
function defaultModel(name) {
  switch (name) {
    case 'gemini': return 'gemini-3.5-flash';
    case 'grok': return 'grok-4.3';
    case 'deepseek': return 'deepseek-flash';
    default: return '';
  }
}

/** Provider names that have a key, in failover order. */
export function configuredProviders() {
  return settings.aiFallbackOrder.filter((name) => Boolean(providerKey(name)));
}

/** Which integrations have credentials configured (values never returned). */
export function integrationStatus() {
  return {
    gemini: isConfigured('gemini'),
    grok: isConfigured('grok'),
    deepseek: isConfigured('deepseek'),
    github: isConfigured('github'),
    gitlab: isConfigured('gitlab'),
    gdrive: isConfigured('gdrive'),
  };
}
