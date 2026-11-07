// tgcloud/lib/text.js — string helpers shared by the agent runtime.
// No Node built-ins: the runtime is a V8 isolate.

/** Escape user/model text before it goes into Telegram HTML or the Mini App DOM. */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Telegram legacy `Markdown` is fragile with model output (a stray `_` in a
 * file name breaks the whole message). Strip the characters that carry meaning
 * and send plain text instead — see `sendSafe` in handlers/message.js.
 */
export function stripTelegramMarkdown(value) {
  return String(value ?? '')
    .replace(/```/g, '')
    .replace(/(^|\n)#{1,6}\s/g, '$1')
    .replace(/(\*\*|__|`|~~)/g, '')
    .replace(/(^|[\s(])[*_](\S)/g, '$1$2')
    .replace(/(\S)[*_]($|[\s).,!?:;])/g, '$1$2');
}

/** Cut a string to `max` characters, keeping the tail marker short. */
export function truncate(value, max = 4000) {
  const s = String(value ?? '');
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 20))}\n… (${s.length - max} chars cut)`;
}

/** Base64-ish byte budget helper: how many UTF-8 bytes a string takes. */
export function byteLength(value) {
  const s = String(value ?? '');
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.codePointAt(i);
    if (code > 0xffff) i++; // surrogate pair consumed
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/**
 * Find JSON objects in model output by matching braces, ignoring braces inside
 * strings. Returns `{ value, start, end }` for every object that parses.
 * A scan, not a regex: model text is full of braces inside code samples.
 */
export function findJsonObjects(text) {
  const src = String(text ?? '');
  const out = [];
  for (let i = 0; i < src.length; i++) {
    if (src[i] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < src.length; j++) {
      const ch = src[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          const raw = src.slice(i, j + 1);
          if (raw.length <= 200000) {
            try {
              out.push({ value: JSON.parse(raw), start: i, end: j + 1 });
              i = j; // do not rescan a parsed object
            } catch {
              /* not JSON — keep scanning from the next brace */
            }
          }
          break;
        }
      }
    }
  }
  return out;
}

/** `owner/repo` or a GitLab `group/project` path → trimmed, no scheme, no .git. */
export function normalizeRepoPath(value) {
  return String(value ?? '')
    .trim()
    .replace(/^https?:\/\/[^/]+\//i, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+|\/+$/g, '');
}

/** Human-readable one-liner for logs/actions ("acme/site@main › docs/README.md"). */
export function joinTarget(...parts) {
  return parts.filter(Boolean).join(' › ');
}

/** True when a value looks like it was never filled in. */
export function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === '';
}
