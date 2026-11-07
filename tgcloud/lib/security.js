// tgcloud/lib/security.js — access control and secret hygiene.
//
// Two rules the whole project follows:
//   1. A caller is identified only by the platform-verified init data
//      (`ctx.initData.user.id`) — never by an id the client sends.
//   2. Nothing that leaves the agent (API responses, Telegram messages, logs)
//      may contain a configured secret.

import { settings, integrationStatus as configuredStatus } from './settings.js';

/** Config values that must never appear in any output. */
const SECRET_CONFIG_KEYS = [
  'GEMINI_API_KEY',
  'XAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'GITHUB_TOKEN',
  'GITLAB_TOKEN',
];

/** Token shapes worth masking even when the value is unknown to us. */
const SECRET_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, // GitHub classic tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, // GitHub fine-grained tokens
  /\bglpat-[A-Za-z0-9_-]{16,}\b/g, // GitLab personal access tokens
  /\bAIza[0-9A-Za-z_-]{30,}\b/g, // Google API keys
  /\bxai-[0-9A-Za-z_-]{20,}\b/g, // xAI (Grok) API keys
  /\bsk-[0-9A-Za-z_-]{20,}\b/g, // OpenAI-compatible keys (DeepSeek, …)
  /\bya29\.[0-9A-Za-z_-]{20,}\b/g, // Google OAuth tokens
  /\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g, // Bot API token "<bot_id>:<secret>"
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/** Secrets known to this deployment, longest first so nesting can't leak a tail. */
function knownSecrets() {
  const values = [
    settings.geminiApiKey,
    settings.xaiApiKey,
    settings.deepseekApiKey,
    settings.githubToken,
    settings.gitlabToken,
    settings.googleServiceAccount?.private_key,
  ];
  return values.filter((value) => typeof value === 'string' && value.length >= 8).sort((a, b) => b.length - a.length);
}

/** True when `userId` may use the bot. An empty allowlist means "everyone". */
export function isUserAllowed(userId) {
  const list = settings.allowedUserIds;
  if (!list.length) return true;
  if (userId === undefined || userId === null) return false;
  return list.map(Number).includes(Number(userId));
}

/** Persian rejection message, so the Mini App can show it directly. */
export const ACCESS_DENIED_MESSAGE =
  '⛔️ دسترسی ندارید. شناسه تلگرام شما در فهرست کاربران مجاز این ربات نیست.';

/** Which integrations have credentials configured (never the values). */
export function integrationStatus() {
  return configuredStatus();
}

/** Mask configured secrets and anything that looks like a credential. */
export function redactSecrets(text) {
  let out = String(text ?? '');
  for (const secret of knownSecrets()) out = out.split(secret).join('[REDACTED]');
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[REDACTED]');
  return out;
}

/** Constant-time-ish comparison, for values we compare ourselves. */
export function safeEqual(a, b) {
  const x = String(a ?? '');
  const y = String(b ?? '');
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

/** Reject absurd inputs before they reach the model or the database. */
export const MAX_PROMPT_LENGTH = 8000;
