// Tool Guard in front of an MCP server you did not write (mail, drive, CRM, bank...). Same behaviour and same
// config file as the Python gateway:
//   - tools/call: the rules of the config are checked first; refused or held, the call never reaches the server
//     and the model gets Tool Guard's message as the tool's answer;
//   - tools/list: every tool is fingerprinted; a tool that appears or changes after it was trusted, or whose
//     description gives the model orders, cannot be called until a person trusts it again.
// Approved requests run here, at the next check, and their result is stored with the request.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import { Decision } from './decision.js';
import { Guard } from './guard.js';
import { allowedValues, limit, rateLimit, requiresApproval } from './rules.js';
import { FileApprovals, FileCounter, FileJournal, FileStops, nowIso } from './stores.js';
import { globMatch } from './rules.js';

export const SUSPICIOUS = [
  /ignore (all |any )?(the |your )?(previous|prior|above) (instructions|rules)/,
  /(do not|don't|never) (tell|inform|mention|reveal)[^.]{0,40}(user|human)/,
  /<\s*(important|system|instructions?)\s*>/,
  /(send|forward|copy|upload|post)[^.]{0,60}(to|at) (https?:\/\/|[\w.+-]+@[\w-]+\.)/,
  /(read|open|include|attach)[^.]{0,40}(\.ssh|id_rsa|\.env|password|api[_ -]?key|token|credentials)/,
  /before (using|calling) (this|any other) tool/,
  /ignore[sz]? (toutes |les )?(instructions|consignes) (précédentes|ci-dessus)/,
  /ne (le )?dis pas à l'utilisateur/,
];

const sorted = (v) => (Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v);

export function fingerprint(tool) {
  const keep = sorted({ name: tool.name ?? null, description: tool.description ?? null, inputSchema: tool.inputSchema ?? null });
  return createHash('sha256').update(JSON.stringify(keep)).digest('hex').slice(0, 16);
}

export function suspicious(tool) {
  const text = JSON.stringify({ d: tool.description ?? null, s: tool.inputSchema ?? null }).toLowerCase();
  for (const re of SUSPICIOUS) {
    const m = text.match(re);
    if (m) return m[0];
  }
  return null;
}

export class Pins {
  constructor(file) { this.file = file; }
  load() {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8') || '{}'); } catch (e) { return e.code === 'ENOENT' ? {} : { _corrupt: true }; }
  }
  save(data) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
    fs.renameSync(tmp, this.file);
  }
  review(tools, trustOnFirstUse) {
    const data = this.load();
    if (data._corrupt) return Object.fromEntries(tools.map((t) => [t.name, 'the trusted tools file cannot be read']));
    const first = !data.trusted || !Object.keys(data.trusted).length;
    data.trusted ??= {};
    data.seen = {};
    const blocked = {};
    for (const t of tools) {
      const name = String(t.name);
      const fp = fingerprint(t);
      const bad = suspicious(t);
      data.seen[name] = { fingerprint: fp, description: t.description ?? null, inputSchema: t.inputSchema ?? null, suspicious: bad };
      const known = data.trusted[name];
      if (known && known.fingerprint === fp) continue;
      if (first && trustOnFirstUse && !bad) {
        data.trusted[name] = { fingerprint: fp, at: nowIso(), by: 'first use' };
        continue;
      }
      blocked[name] = bad ? `tool "${name}" is not trusted: its description gives the model instructions ("${bad}")`
        : known ? `tool "${name}" changed since it was trusted on ${known.at.slice(0, 10)}; a person must review it`
          : `tool "${name}" is new and not trusted yet; a person must review it`;
    }
    data.blocked = blocked;
    this.save(data);
    return blocked;
  }
  trust(names, by) {
    const data = this.load();
    const done = [];
    for (const [name, t] of Object.entries(data.seen ?? {})) {
      if (names === null || names.includes(name)) {
        (data.trusted ??= {})[name] = { fingerprint: t.fingerprint, at: nowIso(), by };
        if (data.blocked) delete data.blocked[name];
        done.push(name);
      }
    }
    this.save(data);
    return done;
  }
}

export function rulesFor(config, tool) {
  const tools = config.tools ?? {};
  let spec = tools[tool];
  if (spec === undefined) spec = Object.entries(tools).find(([k]) => globMatch(tool, k))?.[1];
  if (spec === undefined) {
    const def = config.default ?? 'allow';
    if (def === 'deny') return { rules: [], refused: `"${tool}" has no rule and the default is to refuse` };
    if (def === 'approval') spec = { approval: `"${tool}" has no rule and the default is a human approval` };
    else return { rules: [], refused: null };
  }
  if ('deny' in spec) return { rules: [], refused: String(spec.deny) };
  const rules = [];
  for (const [arg, l] of Object.entries(spec.limit ?? {})) rules.push(limit(arg, { max: Number(l.max), above: l.above ?? 'deny', min: l.min ?? null }));
  for (const [arg, av] of Object.entries(spec.allowed_values ?? {})) {
    rules.push(Array.isArray(av) ? allowedValues(arg, av) : allowedValues(arg, av.patterns, { otherwise: av.otherwise ?? 'approval' }));
  }
  if (spec.rate) rules.push(rateLimit(Number(spec.rate.limit), { perSeconds: Number(spec.rate.per_seconds), per: spec.rate.per ?? 'user' }));
  if ('approval' in spec) rules.push(requiresApproval(typeof spec.approval === 'string' ? spec.approval : null));
  return { rules, refused: null };
}

export function loadConfig(file) {
  return { config: JSON.parse(fs.readFileSync(file, 'utf8')), base: path.dirname(path.resolve(file)) };
}

export function buildGuard(config, base) {
  const state = path.resolve(base, config.state_dir ?? 'var/tool-guard');
  const guard = new Guard({
    approvals: new FileApprovals(path.join(state, 'approvals')), journal: new FileJournal(path.join(state, 'journal.jsonl')),
    stops: new FileStops(path.join(state, 'stops.json')), counter: new FileCounter(path.join(state, 'rate.json')),
    maxPendingPerUser: Number(config.max_pending_per_user ?? 3), expireAfter: config.expire_after ?? null, fourEyes: Boolean(config.four_eyes),
  });
  guard.deferred = true;
  return { guard, pins: new Pins(path.join(state, 'pins.json')) };
}

export class Gateway {
  constructor(config, base, { input = process.stdin, output = process.stdout, poll = Number(config.poll_seconds ?? 2) } = {}) {
    Object.assign(this, { config, base, input, output, poll });
    ({ guard: this.guard, pins: this.pins } = buildGuard(config, base));
    this.listIds = new Set();
    this.internal = new Map();
    this.blocked = {};
    this.ready = false;
  }

  toClient(msg) { this.output.write(`${JSON.stringify(msg)}\n`); }
  toUpstream(msg) { this.proc.stdin.write(`${typeof msg === 'string' ? msg.trimEnd() : JSON.stringify(msg)}\n`); }

  run() {
    const up = this.config.upstream;
    this.proc = spawn(up.command, up.args ?? [], { env: { ...process.env, ...(up.env ?? {}) }, cwd: up.cwd ?? undefined, stdio: ['pipe', 'pipe', 'inherit'] });
    readline.createInterface({ input: this.proc.stdout }).on('line', (line) => this.fromUpstream(line));
    const timer = setInterval(() => this.runApproved(), this.poll * 1000);
    let queue = Promise.resolve();
    const rl = readline.createInterface({ input: this.input });
    rl.on('line', (line) => { queue = queue.then(() => this.fromClient(line)); });
    return new Promise((resolve) => {
      rl.on('close', async () => {
        await queue;
        clearInterval(timer);
        this.proc.stdin.end();
        this.proc.on('exit', () => resolve(0));
        setTimeout(() => { this.proc.kill(); resolve(0); }, 5000).unref();
      });
    });
  }

  async fromClient(line) {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { this.toUpstream(line); return; }
    if (msg?.method === 'tools/list' && 'id' in msg) this.listIds.add(msg.id);
    if (msg?.method === 'notifications/initialized') this.ready = true;
    if (msg?.method === 'tools/call' && 'id' in msg) {
      const p = msg.params ?? {};
      const args = p.arguments && typeof p.arguments === 'object' ? p.arguments : {};
      const decision = await this.decide(String(p.name), args);
      if (!decision.allowed) {
        this.toClient({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: decision.messageForModel() }], isError: true } });
        return;
      }
    }
    this.toUpstream(msg);
  }

  async decide(tool, args) {
    const { rules, refused } = rulesFor(this.config, tool);
    const reason = this.blocked[tool] ?? this.pins.load().blocked?.[tool] ?? refused;
    if (reason) {
      const d = Decision.deny(reason);
      this.guard.journal.record({ event: 'call', channel: 'ai', tool, user: this.config.user ?? null, arguments: args, verdict: d.verdict, reason, approval: null, ...(this.config.agent ? { agent: this.config.agent } : {}) });
      return d;
    }
    return this.guard.decide(tool, args, { rules, user: this.config.user ?? null, agent: this.config.agent ?? null });
  }

  fromUpstream(line) {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { this.output.write(`${line}\n`); return; }
    const id = msg?.id;
    if (typeof id === 'string' && this.internal.has(id)) {
      this.finish(this.internal.get(id), msg);
      this.internal.delete(id);
      return;
    }
    if (this.listIds.has(id)) {
      this.listIds.delete(id);
      this.blocked = this.pins.review(msg.result?.tools ?? [], this.config.trust_on_first_use ?? true);
      for (const [tool, reason] of Object.entries(this.blocked)) this.guard.journal.record({ event: 'untrusted', tool, reason });
    }
    this.toClient(msg);
  }

  runApproved() {
    if (!this.ready) return;
    const running = new Set(this.internal.values());
    for (const a of this.guard.approvals.all('approved')) {
      if (a.queued && !running.has(a.id)) {
        const rid = `tool-guard-${a.id}`;
        this.internal.set(rid, a.id);
        this.toUpstream({ jsonrpc: '2.0', id: rid, method: 'tools/call', params: { name: a.tool, arguments: a.arguments } });
      }
    }
  }

  finish(approvalId, msg) {
    const a = this.guard.approvals.get(approvalId);
    if (!a) return;
    if (msg.error) Object.assign(a, { status: 'failed', result: JSON.stringify(msg.error).slice(0, 2000) });
    else {
      const text = (msg.result?.content ?? []).map((c) => c?.text ?? '').join(' ');
      a.result = (text || JSON.stringify(msg.result)).slice(0, 2000);
      if (msg.result?.isError) a.status = 'failed';
    }
    a.queued = false;
    this.guard.approvals.save(a);
    this.guard.journal.record({ event: 'approved_run', tool: a.tool, approval: a.id, status: a.status });
  }
}
