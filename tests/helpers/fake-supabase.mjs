import { randomUUID } from "node:crypto";

// A minimal in-memory stand-in for the Supabase JS client, supporting exactly the
// chained query-builder calls used by lib/finder-service.ts, lib/gemini-vision.ts,
// and the app/api/finder/** route handlers. Not a general Supabase mock — extend the
// Builder methods below if a new call shape shows up.

function compare(a, b) {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function matchesFilters(row, filters) {
  return filters.every((filter) => {
    const value = row[filter.col];
    if (filter.type === "eq") return value === filter.val;
    if (filter.type === "in") return filter.val.includes(value);
    if (filter.type === "is") return (value ?? null) === filter.val;
    if (filter.type === "not" && filter.op === "is") return !((value ?? null) === filter.val);
    if (filter.type === "not" && filter.op === "ov") return !(Array.isArray(value) && value.some((v) => filter.val.includes(v)));
    if (filter.type === "lte") return value != null && value <= filter.val;
    if (filter.type === "gte") return value != null && value >= filter.val;
    if (filter.type === "overlaps") return Array.isArray(value) && value.some((v) => filter.val.includes(v));
    if (filter.type === "neq") return value !== filter.val;
    if (filter.type === "or") return filter.clauses.some((clause) => matchesFilters(row, [clause]));
    return true;
  });
}

class Builder {
  constructor(store, table) {
    this.store = store;
    this.table = table;
    this.filters = [];
    this._op = "select";
    this._payload = null;
    this._onConflict = null;
    this._ignoreDuplicates = false;
    this._order = null;
    this._limit = null;
    this._single = null;
    this._head = false;
    this._count = null;
  }

  _rows() { return this.store._table(this.table); }

  select(_cols, opts) { if (opts?.count) this._count = opts.count; if (opts?.head) this._head = true; return this; }
  eq(col, val) { this.filters.push({ type: "eq", col, val }); return this; }
  in(col, val) { this.filters.push({ type: "in", col, val }); return this; }
  is(col, val) { this.filters.push({ type: "is", col, val }); return this; }
  not(col, op, val) { this.filters.push({ type: "not", col, op, val }); return this; }
  lte(col, val) { this.filters.push({ type: "lte", col, val }); return this; }
  gte(col, val) { this.filters.push({ type: "gte", col, val }); return this; }
  overlaps(col, val) { this.filters.push({ type: "overlaps", col, val }); return this; }
  // Minimal PostgREST-style `.or("col.is.null,col.eq.value")` parser — only supports the
  // `is.null` / `eq.<value>` clause shapes this test suite's callers actually use.
  or(expression) {
    const clauses = expression.split(",").map((clause) => {
      const [col, op, rawVal] = clause.split(".");
      if (op === "is") return { type: "is", col, val: rawVal === "null" ? null : rawVal };
      if (op === "eq") return { type: "eq", col, val: rawVal };
      if (op === "neq") return { type: "neq", col, val: rawVal };
      throw new Error(`Unsupported .or() clause in fake-supabase: "${clause}"`);
    });
    this.filters.push({ type: "or", clauses });
    return this;
  }
  order(col, opts) { this._order = { col, ascending: opts?.ascending !== false }; return this; }
  limit(n) { this._limit = n; return this; }
  single() { this._single = "single"; return this; }
  maybeSingle() { this._single = "maybeSingle"; return this; }
  upsert(rows, opts) { this._op = "upsert"; this._payload = Array.isArray(rows) ? rows : [rows]; this._onConflict = opts?.onConflict; this._ignoreDuplicates = Boolean(opts?.ignoreDuplicates); return this; }
  update(values) { this._op = "update"; this._payload = values; return this; }
  insert(values) { this._op = "insert"; this._payload = Array.isArray(values) ? values : [values]; return this; }
  delete() { this._op = "delete"; return this; }

  async _execute() {
    const table = this._rows();

    if (this._op === "update") {
      const matched = table.filter((row) => matchesFilters(row, this.filters));
      matched.forEach((row) => Object.assign(row, this._payload));
      return { data: matched, error: null };
    }
    if (this._op === "delete") {
      const matched = table.filter((row) => matchesFilters(row, this.filters));
      this.store.tables[this.table] = table.filter((row) => !matched.includes(row));
      return { data: matched, error: null };
    }
    if (this._op === "insert") {
      const inserted = this._payload.map((row) => ({ id: row.id ?? randomUUID(), created_at: row.created_at ?? new Date().toISOString(), ...row }));
      table.push(...inserted);
      return this._single ? { data: inserted[0] ?? null, error: null } : { data: inserted, error: null };
    }
    if (this._op === "upsert") {
      const key = this._onConflict;
      const results = [];
      for (const incoming of this._payload) {
        const existingIndex = key ? table.findIndex((row) => row[key] === incoming[key]) : -1;
        if (existingIndex >= 0) {
          if (this._ignoreDuplicates) continue;
          table[existingIndex] = { ...table[existingIndex], ...incoming };
          results.push(table[existingIndex]);
        } else {
          const created = { id: incoming.id ?? randomUUID(), created_at: incoming.created_at ?? new Date().toISOString(), ...incoming };
          table.push(created);
          results.push(created);
        }
      }
      if (this._single === "single") return results.length ? { data: results[0], error: null } : { data: null, error: { message: `No rows found in "${this.table}".` } };
      if (this._single === "maybeSingle") return { data: results[0] ?? null, error: null };
      return { data: results, error: null };
    }

    // Plain select.
    let rows = table.filter((row) => matchesFilters(row, this.filters));
    if (this._order) {
      const { col, ascending } = this._order;
      rows = [...rows].sort((a, b) => (ascending ? compare(a[col], b[col]) : compare(b[col], a[col])));
    }
    if (this._limit != null) rows = rows.slice(0, this._limit);
    if (this._head) return { data: null, error: null, count: rows.length };
    if (this._single === "single") return rows.length ? { data: rows[0], error: null } : { data: null, error: { message: `No rows found in "${this.table}".` } };
    if (this._single === "maybeSingle") return { data: rows[0] ?? null, error: null };
    return { data: rows, error: null };
  }

  then(onFulfilled, onRejected) { return this._execute().then(onFulfilled, onRejected); }
  catch(onRejected) { return this._execute().catch(onRejected); }
}

class RpcCall {
  constructor(result) { this.result = result; }
  single() { return this; }
  then(onFulfilled, onRejected) { return Promise.resolve(this.result).then(onFulfilled, onRejected); }
}

// Minimal in-memory stand-in for supabase-js's Storage API — only the calls
// lib/gemini-vision.ts's referenceImagePart and the gaucho-reference-images route actually use.
function createFakeStorage(files) {
  return {
    from(bucket) {
      const key = (path) => `${bucket}/${path}`;
      return {
        async download(path) {
          const file = files.get(key(path));
          if (!file) return { data: null, error: { message: `Not found: ${key(path)}` } };
          return { data: { size: file.data.length, type: file.contentType, arrayBuffer: async () => file.data.buffer.slice(file.data.byteOffset, file.data.byteOffset + file.data.byteLength) }, error: null };
        },
        async upload(path, data, opts) {
          if (files.has(key(path)) && !opts?.upsert) return { data: null, error: { message: "The resource already exists" } };
          const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
          files.set(key(path), { data: bytes, contentType: opts?.contentType || "application/octet-stream" });
          return { data: { path }, error: null };
        },
        async remove(paths) {
          for (const path of paths) files.delete(key(path));
          return { data: paths.map((path) => ({ name: path })), error: null };
        },
        async createSignedUrl(path) {
          if (!files.has(key(path))) return { data: null, error: { message: `Not found: ${key(path)}` } };
          return { data: { signedUrl: `https://fake-storage.test/${key(path)}` }, error: null };
        },
      };
    },
  };
}

export function createFakeSupabase(seed = {}) {
  const store = {
    tables: Object.fromEntries(Object.entries(seed).map(([name, rows]) => [name, rows.map((row) => ({ ...row }))])),
    _table(name) { if (!this.tables[name]) this.tables[name] = []; return this.tables[name]; },
  };
  const rpcHandlers = new Map();
  const files = new Map();

  return {
    tables: store.tables,
    from(table) { return new Builder(store, table); },
    rpc(name, params) {
      const handler = rpcHandlers.get(name);
      if (!handler) throw new Error(`No fake rpc handler registered for "${name}".`);
      return new RpcCall(handler(params));
    },
    setRpc(name, handler) { rpcHandlers.set(name, handler); },
    storage: createFakeStorage(files),
    // Test-only helper: seed a fake storage file directly, bypassing upload().
    setFile(bucket, path, data, contentType = "image/jpeg") { files.set(`${bucket}/${path}`, { data: data instanceof Uint8Array ? data : new Uint8Array(data), contentType }); },
  };
}
