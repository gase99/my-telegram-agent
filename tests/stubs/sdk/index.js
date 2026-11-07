// tests/stubs/sdk/index.js — an offline stand-in for the platform `sdk`.
//
// Only used by `npm test`: it lets the tgcloud modules be imported, linked and
// exercised in plain Node without the Telegram runtime. It implements just
// enough of the real surface (`db`, `api`, `fetch`, `EndpointError`, `InputFile`)
// to catch broken imports, bad SQL-builder usage and logic errors.

// `fetch` is a thin wrapper so tests can inject canned provider responses.
let fetchMock = null;
export const __setFetchMock = (fn) => { fetchMock = fn; };
export const fetch = (url, init) => (fetchMock ? fetchMock(url, init) : globalThis.fetch(url, init));

export class EndpointError extends Error {
  constructor(description, parameters = {}) {
    super(description);
    this.name = 'EndpointError';
    this.description = description;
    this.parameters = parameters;
    this.code = parameters?.code;
    this.status = parameters?.status;
  }
}

export class BotApiError extends Error {
  constructor(message, { code = 400, method = 'unknown' } = {}) {
    super(message);
    this.name = 'BotApiError';
    this.code = code;
    this.method = method;
  }
}

export class InputFile {
  constructor(bytes, filename, options = {}) {
    this.bytes = bytes;
    this.filename = filename;
    this.type = options.type;
  }
}

// ── a tiny in-memory table store ────────────────────────────────────────────

const store = new Map(); // tableName → rows[]
let autoId = 1;

function tableRows(name) {
  if (!store.has(name)) store.set(name, []);
  return store.get(name);
}

export function __resetDatabase() {
  store.clear();
  autoId = 1;
}

function column(name, options = {}) {
  const self = {
    name,
    options,
    __isColumn: true,
    primaryKey(opts) { self.options.primaryKey = opts || true; return self; },
    notNull() { self.options.notNull = true; return self; },
    unique() { self.options.unique = true; return self; },
    default(value) { self.options.default = value; return self; },
    references() { throw new Error('foreign keys are not supported'); },
    deprecated() { return self; },
    constraint() { return self; },
    generatedAlwaysAs() { return self; },
  };
  return self;
}

export function table(name, columns = {}, extras = () => ({})) {
  // The real SDK exposes each column as a property of the descriptor
  // (`chats.userId`), which is what `eq(chats.userId, id)` relies on.
  const descriptor = { __isTable: true, __tableName: name, name, columns: { ...columns } };
  for (const [key, columnRef] of Object.entries(columns)) {
    columnRef.__key = key; // JS property name, as rows are keyed by it
    descriptor[key] = columnRef;
  }
  descriptor.extras = extras(descriptor);
  return descriptor;
}

export const integer = (name, options) => column(name, { type: 'integer', ...options });
export const text = (name, options) => column(name, { type: 'text', ...options });
export const real = (name, options) => column(name, { type: 'real', ...options });
export const numeric = column;
export const blob = (name, options) => column(name, { type: 'blob', ...options });
export const json = (name, options) => column(name, { type: 'json', mode: 'json', ...options });
export const boolean = (name, options) => column(name, { type: 'boolean', mode: 'boolean', ...options });
export const index = (name) => ({ name, on: () => ({ name }), where: () => ({ name }) });
export const uniqueIndex = index;
export const unique = (name) => ({ name, on: () => ({ name }) });
export const primaryKey = () => ({});
export const check = (name) => ({ name });
export const sql = (strings, ...values) => ({ __sql: true, strings, values });
sql.raw = (text) => ({ __sql: true, raw: text });

// Rows are keyed by the JS property name (`userId`), so filters must use it too.
const keyOf = (columnRef) => columnRef?.__key ?? columnRef?.name;

// Operators are opaque markers: the stub filter understands the common ones.
export const eq = (columnRef, value) => ({ op: 'eq', column: keyOf(columnRef), value });
export const ne = (columnRef, value) => ({ op: 'ne', column: keyOf(columnRef), value });
export const gt = (columnRef, value) => ({ op: 'gt', column: keyOf(columnRef), value });
export const gte = (columnRef, value) => ({ op: 'gte', column: keyOf(columnRef), value });
export const lt = (columnRef, value) => ({ op: 'lt', column: keyOf(columnRef), value });
export const lte = (columnRef, value) => ({ op: 'lte', column: keyOf(columnRef), value });
export const like = eq;
export const notLike = ne;
export const isNull = (columnRef) => ({ op: 'isNull', column: keyOf(columnRef) });
export const isNotNull = (columnRef) => ({ op: 'isNotNull', column: keyOf(columnRef) });
export const and = (...parts) => ({ op: 'and', parts: parts.flat().filter(Boolean) });
export const or = (...parts) => ({ op: 'or', parts: parts.flat().filter(Boolean) });
export const not = (part) => ({ op: 'not', parts: [part] });
export const between = eq;
export const notBetween = eq;
export const inArray = (columnRef, values) => ({ op: 'in', column: keyOf(columnRef), values });
export const notInArray = (columnRef, values) => ({ op: 'notIn', column: keyOf(columnRef), values });
export const count = (columnRef) => ({ count: keyOf(columnRef) });
export const sum = count;
export const avg = count;
export const min = count;
export const max = count;
export const asc = (columnRef) => ({ dir: 'asc', column: keyOf(columnRef) });
export const desc = (columnRef) => ({ dir: 'desc', column: keyOf(columnRef) });

function matches(row, filter) {
  if (!filter) return true;
  switch (filter.op) {
    case 'and': return filter.parts.every((part) => matches(row, part));
    case 'or': return filter.parts.some((part) => matches(row, part));
    case 'not': return !matches(row, filter.parts[0]);
    case 'eq': return row[filter.column] === filter.value;
    case 'ne': return row[filter.column] !== filter.value;
    case 'gt': return row[filter.column] > filter.value;
    case 'gte': return row[filter.column] >= filter.value;
    case 'lt': return row[filter.column] < filter.value;
    case 'lte': return row[filter.column] <= filter.value;
    case 'isNull': return row[filter.column] === null || row[filter.column] === undefined;
    case 'isNotNull': return row[filter.column] !== null && row[filter.column] !== undefined;
    case 'in': return filter.values.includes(row[filter.column]);
    case 'notIn': return !filter.values.includes(row[filter.column]);
    default: return true;
  }
}

function nextId(rows) {
  return rows.reduce((max, row) => Math.max(max, row.id || 0), 0) + 1;
}

function materialise(descriptor, values) {
  const row = { ...values };
  const columns = descriptor.columns || {};
  for (const [key, col] of Object.entries(columns)) {
    if (row[key] === undefined && col.options?.default !== undefined && !col.options.default?.__sql) {
      row[key] = col.options.default;
    }
    if (col.options?.primaryKey && row[key] === undefined) row[key] = autoId++;
    if (col.options?.mode === 'timestamp' && !(row[key] instanceof Date)) row[key] = new Date();
    if (col.options?.mode === 'boolean') row[key] = Boolean(row[key]);
  }
  return row;
}

class SelectBuilder {
  constructor(projection) { this.projection = projection; this.filters = null; this._order = []; this._limit = null; this._offset = 0; }
  from(descriptor) { this.descriptor = descriptor; return this; }
  where(...filters) { this.filters = filters.length === 1 ? filters[0] : and(...filters); return this; }
  orderBy(...items) { this._order = items.flat(); return this; }
  limit(n) { this._limit = n; return this; }
  offset(n) { this._offset = n; return this; }
  groupBy() { return this; }
  having() { return this; }
  distinct() { return this; }
  _rows() {
    const rows = tableRows(this.descriptor?.__tableName || this.descriptor?.name).filter((row) => matches(row, this.filters));
    let out = rows.slice();
    for (const item of [...this._order].reverse()) {
      if (!item) continue;
      out.sort((a, b) => {
        const av = a[item.column]; const bv = b[item.column];
        if (av === bv) return 0;
        const cmp = av > bv ? 1 : -1;
        return item.dir === 'desc' ? -cmp : cmp;
      });
    }
    if (this._offset) out = out.slice(this._offset);
    if (this._limit != null) out = out.slice(0, this._limit);
    return out;
  }
  async all() { return this._rows(); }
  async get() { return this._rows()[0] ?? null; }
  async values() { return this._rows().map((row) => Object.values(row)); }
  then(resolve, reject) { return this.all().then(resolve, reject); }
}

class InsertBuilder {
  constructor(descriptor) { this.descriptor = descriptor; this._values = null; }
  values(values) { this._values = values; return this; }
  returning(projection) { this._projection = projection || true; return this; }
  onConflictDoNothing() { return this; }
  onConflictDoUpdate() { return this; }
  async _run() {
    const rows = tableRows(this.descriptor.__tableName || this.descriptor.name);
    const list = Array.isArray(this._values) ? this._values : [this._values];
    const inserted = list.map((values) => {
      const row = materialise(this.descriptor, values || {});
      rows.push(row);
      return { ...row };
    });
    if (!this._projection) return { rowsAffected: inserted.length, lastInsertRowid: inserted[0]?.id || 0, rows: [] };
    return inserted;
  }
  run() { return this._run(); }
  then(resolve, reject) { return this._run().then(resolve, reject); }
}

class UpdateBuilder {
  constructor(descriptor) { this.descriptor = descriptor; this._set = {}; this.filters = null; }
  set(values) { this._set = values; return this; }
  where(...filters) { this.filters = filters.length === 1 ? filters[0] : and(...filters); return this; }
  returning() { this._returning = true; return this; }
  async _run() {
    const changed = [];
    for (const row of tableRows(this.descriptor.__tableName || this.descriptor.name)) {
      if (matches(row, this.filters)) {
        for (const [key, value] of Object.entries(this._set)) row[key] = value;
        changed.push({ ...row });
      }
    }
    if (!this._returning) return { rowsAffected: changed.length, lastInsertRowid: 0, rows: [] };
    return changed;
  }
  run() { return this._run(); }
  then(resolve, reject) { return this._run().then(resolve, reject); }
}

class DeleteBuilder {
  constructor(descriptor) { this.descriptor = descriptor; this.filters = null; }
  where(...filters) { this.filters = filters.length === 1 ? filters[0] : and(...filters); return this; }
  async _run() {
    const rows = tableRows(this.descriptor.__tableName || this.descriptor.name);
    const keep = rows.filter((row) => !matches(row, this.filters));
    const affected = rows.length - keep.length;
    store.set(this.descriptor.__tableName || this.descriptor.name, keep);
    return { rowsAffected: affected, lastInsertRowid: 0, rows: [] };
  }
  run() { return this._run(); }
  then(resolve, reject) { return this._run().then(resolve, reject); }
}

export const db = {
  select(projection) { return new SelectBuilder(projection); },
  insert(descriptor) { return new InsertBuilder(descriptor); },
  update(descriptor) { return new UpdateBuilder(descriptor); },
  delete(descriptor) { return new DeleteBuilder(descriptor); },
  async $count(descriptor, filter) {
    return tableRows(descriptor.__tableName || descriptor.name).filter((row) => matches(row, filter)).length;
  },
  async run() { return { rowsAffected: 0, lastInsertRowid: 0, rows: [] }; },
  async all() { return []; },
  async get() { return null; },
  async values() { return []; },
};

// ── Bot API stub: records calls, never touches the network ───────────────────

export const sentMessages = [];

export const api = new Proxy(
  {},
  {
    get(_target, method) {
      return async (params) => {
        sentMessages.push({ method, params });
        if (method === 'getMe') return { id: 1, is_bot: true, username: 'test_bot' };
        return { ok: true, message_id: sentMessages.length };
      };
    },
  }
);

export const console = globalThis.console;
export default { db, api, fetch, EndpointError, InputFile, BotApiError };
