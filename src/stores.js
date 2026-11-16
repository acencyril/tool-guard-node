// Where Tool Guard keeps its state. File stores work across processes; memory stores are for tests and scripts.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const PENDING = 'pending';
export const APPROVED = 'approved';
export const REJECTED = 'rejected';
export const FAILED = 'failed';

export const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

export function newApproval({ tool, args, user, reason, channel, agent }) {
  return {
    id: randomBytes(4).toString('hex'), tool, arguments: args, requestedBy: user ?? null, reason,
    requestedAt: nowIso(), channel, agent: agent ?? null, status: PENDING, decidedBy: null, decidedAt: null, result: null,
  };
}

export function expired(a, seconds, at = Date.now()) {
  return a.status === PENDING && seconds != null && at - Date.parse(a.requestedAt) >= seconds * 1000;
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function withLock(file, fn) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  for (let i = 0; ; i++) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 10_000) fs.rmSync(lock, { recursive: true, force: true }); // left by a crash
      } catch { /* gone meanwhile */ }
      if (i > 500) throw new Error(`cannot lock ${file}`);
      sleep(10);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8') || 'null') ?? fallback;
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
};

export class MemoryApprovals {
  #items = new Map();
  save(a) { this.#items.set(a.id, structuredClone(a)); }
  get(id) { const a = this.#items.get(id); return a ? structuredClone(a) : null; }
  all(status = null) {
    return [...this.#items.values()].map((a) => structuredClone(a))
      .sort((x, y) => y.requestedAt.localeCompare(x.requestedAt))
      .filter((a) => status === null || a.status === status);
  }
}

const ID = /^[0-9a-f]{1,32}$/;

export class FileApprovals {
  constructor(dir) { this.dir = dir; }
  save(a) {
    if (!ID.test(a.id)) throw new Error('bad approval id');
    writeAtomic(path.join(this.dir, `${a.id}.json`), JSON.stringify(a));
  }
  get(id) {
    if (!ID.test(String(id ?? ''))) return null;
    return readJson(path.join(this.dir, `${id}.json`), null);
  }
  all(status = null) {
    let names = [];
    try { names = fs.readdirSync(this.dir).filter((n) => n.endsWith('.json')); } catch { return []; }
    const out = [];
    for (const n of names) {
      try { out.push(JSON.parse(fs.readFileSync(path.join(this.dir, n), 'utf8'))); } catch { /* skip a broken file */ }
    }
    return out.sort((x, y) => y.requestedAt.localeCompare(x.requestedAt)).filter((a) => status === null || a.status === status);
  }
}

export class MemoryJournal {
  entries = [];
  record(entry) { this.entries.push({ at: nowIso(), ...entry }); }
  tail(n = 50) { return this.entries.slice(-n); }
}

export class FileJournal {
  constructor(file) { this.file = file; }
  record(entry) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, `${JSON.stringify({ at: nowIso(), ...entry })}\n`);
  }
  tail(n = 50) {
    let text = '';
    try { text = fs.readFileSync(this.file, 'utf8'); } catch { return []; }
    return text.split('\n').filter((l) => l.trim()).slice(-n).map((l) => JSON.parse(l));
  }
}

export const SCOPES = ['all', 'agents', 'tool', 'agent'];

export function stopMatches(s, tool, agent, byAi) {
  return s.scope === 'all' || (s.scope === 'agents' && byAi) || (s.scope === 'tool' && s.target === tool)
    || (s.scope === 'agent' && agent != null && s.target === agent);
}

export function describeStop(s) {
  const what = { all: 'every tool is stopped', agents: 'AI agents are stopped', tool: `tool "${s.target}" is stopped`, agent: `agent "${s.target}" is stopped` }[s.scope];
  return what + (s.reason ? ` (${s.reason})` : '');
}

export class MemoryStops {
  #items = [];
  all() { return [...this.#items]; }
  stop(s) { this.#items = [...this.#items.filter((x) => x.scope !== s.scope || x.target !== s.target), s]; }
  resume(scope, target = null) {
    const before = this.#items.length;
    this.#items = this.#items.filter((x) => x.scope !== scope || x.target !== target);
    return this.#items.length !== before;
  }
}

export class FileStops {
  constructor(file) { this.file = file; }
  all() { return readJson(this.file, []); }
  stop(s) {
    withLock(this.file, () => writeAtomic(this.file, JSON.stringify([...this.all().filter((x) => x.scope !== s.scope || x.target !== s.target), s])));
  }
  resume(scope, target = null) {
    return withLock(this.file, () => {
      const items = this.all();
      const kept = items.filter((x) => x.scope !== scope || x.target !== target);
      writeAtomic(this.file, JSON.stringify(kept));
      return kept.length !== items.length;
    });
  }
}

// Fixed window: it starts at the first call.
export class MemoryCounter {
  #w = new Map();
  consume(key, limit, seconds, at = Date.now()) {
    let [start, n] = this.#w.get(key) ?? [at, 0];
    if (at - start >= seconds * 1000) [start, n] = [at, 0];
    if (n >= limit) return false;
    this.#w.set(key, [start, n + 1]);
    return true;
  }
}

export class FileCounter {
  constructor(file) { this.file = file; }
  consume(key, limit, seconds, at = Date.now()) {
    return withLock(this.file, () => {
      const data = readJson(this.file, {});
      let [start, n] = data[key] ?? [at, 0];
      if (at - start >= seconds * 1000) [start, n] = [at, 0];
      if (n >= limit) return false;
      data[key] = [start, n + 1];
      for (const k of Object.keys(data)) if (at - data[k][0] >= 86_400_000) delete data[k];
      writeAtomic(this.file, JSON.stringify(data));
      return true;
    });
  }
}
