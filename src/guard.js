// The guard: checks a tool's rules before it runs, whatever the model was convinced of.
//
//   const guard = new Guard({ approvals: new FileApprovals('var/approvals'), journal: new FileJournal('var/journal.jsonl') });
//   const refund = guard.wrap('refund', [limit('amount', { max: 50, above: APPROVAL, min: 0 })],
//     async ({ order, amount }) => payments.refund(order, amount));
//
// `refund` takes the same arguments object as before. Within the rules it runs; otherwise it does not run and
// returns, for the model, a plain message telling it not to retry and to tell the user.

import { Decision, ToolCallBlocked } from './decision.js';
import { APPROVAL, DENY as ABOVE_DENY, PER_TOOL, describe } from './rules.js';
import {
  APPROVED, FAILED, PENDING, REJECTED, SCOPES, MemoryApprovals, MemoryCounter, MemoryJournal,
  describeStop, expired, newApproval, nowIso, stopMatches,
} from './stores.js';

export const ENFORCE = 'enforce';
export const OBSERVE = 'observe';
export const AI = 'ai';
export const CODE = 'code';

export class Guard {
  #tools = new Map();

  constructor({
    approvals = new MemoryApprovals(), journal = new MemoryJournal(), stops = null, counter = new MemoryCounter(),
    isGranted = null, currentUser = null, mode = ENFORCE, maxPendingPerUser = 3, expireAfter = null,
    agents = null, allowUnknownAgent = false, fourEyes = false,
  } = {}) {
    if (mode !== ENFORCE && mode !== OBSERVE) throw new TypeError('mode must be "enforce" or "observe"');
    if (!(maxPendingPerUser >= 1)) throw new TypeError('maxPendingPerUser must be at least 1');
    Object.assign(this, { approvals, journal, stops, counter, isGranted, currentUser, mode, maxPendingPerUser, expireAfter, agents: agents ?? {}, allowUnknownAgent, fourEyes });
  }

  // Wrap a tool's function (it takes one arguments object). Blocked: resolves to the message for the model,
  // or rejects with ToolCallBlocked when { throwBlocked: true }. Extra parameters (a framework's context) pass through.
  wrap(name, rules, fn, { throwBlocked = false, user = null, agent = null } = {}) {
    if (typeof fn !== 'function') throw new TypeError('wrap(name, rules, fn): fn must be a function');
    this.#tools.set(name, { fn, rules: [...rules] });
    const guarded = async (args = {}, ...rest) => {
      const who = typeof user === 'function' ? await user(args, ...rest) : user;
      const decision = await this.decide(name, args ?? {}, { user: who, agent: typeof agent === 'function' ? agent(args, ...rest) : agent });
      if (!decision.allowed) {
        if (throwBlocked) throw new ToolCallBlocked(decision, name);
        return decision.messageForModel();
      }
      return fn(args, ...rest);
    };
    Object.defineProperty(guarded, 'name', { value: name });
    return guarded;
  }

  // Run a registered tool from your own code; rejects with ToolCallBlocked when it may not run.
  async call(name, args, { user = null, agent = null, channel = AI } = {}) {
    const t = this.#tools.get(name);
    if (!t) throw new Error(`tool "${name}" is not registered with this guard`);
    const decision = await this.decide(name, args, { user, agent, channel });
    if (!decision.allowed) throw new ToolCallBlocked(decision, name);
    return t.fn(args);
  }

  async decide(tool, args, { user = null, agent = null, channel = AI } = {}) {
    if (user == null && this.currentUser) user = (await this.currentUser()) ?? null;
    const rules = this.#tools.get(tool)?.rules ?? [];
    const stopped = this.#stopped(tool, agent, channel === AI);
    let decision = stopped ?? (await this.#evaluate(tool, rules, args, user, agent, channel));
    let would = null;
    if (!stopped && this.mode === OBSERVE && !decision.allowed) {
      [would, decision] = [decision, Decision.allow()];
    } else if (decision.held) {
      decision = this.#hold(tool, args, user, agent, channel, decision.reason);
    }
    const entry = { event: 'call', channel, tool, user, arguments: args, verdict: decision.verdict, reason: (would ?? decision).reason, approval: decision.approvalId };
    if (would) entry.would = would.verdict;
    if (agent != null) entry.agent = agent;
    if (stopped) entry.stopped = true;
    this.journal.record(entry);
    return decision;
  }

  #stopped(tool, agent, byAi) {
    if (!this.stops) return null;
    let stops;
    try { stops = this.stops.all(); } catch { return Decision.deny('the stop state cannot be read'); } // fail closed
    const s = stops.find((x) => stopMatches(x, tool, agent, byAi));
    return s ? Decision.deny(describeStop(s)) : null;
  }

  async #evaluate(tool, rules, args, user, agent, channel) {
    for (const g of rules.filter((r) => r.kind === 'granted')) {
      if (!this.isGranted) return Decision.deny(`permission "${g.permission}" cannot be checked (no isGranted)`);
      if (g.subject && !(g.subject in args)) return Decision.deny(`argument "${g.subject}" missing for the permission check`);
      let ok = false;
      try { ok = Boolean(await this.isGranted(g.permission, g.subject ? args[g.subject] : null, user)); } catch { ok = false; }
      if (!ok) return Decision.deny(g.message ?? `permission "${g.permission}" not granted${g.subject ? ` for ${g.subject} "${args[g.subject]}"` : ''}`);
    }
    if (Object.keys(this.agents).length && channel === AI) {
      if (agent == null || !(agent in this.agents)) {
        if (!this.allowUnknownAgent) return Decision.deny(agent == null ? `no agent identified for this call to "${tool}"` : `agent "${agent}" is not declared`);
      } else if (!this.agents[agent].includes(tool) && !this.agents[agent].includes('*')) {
        return Decision.deny(`agent "${agent}" may not call "${tool}"`);
      }
    }
    const rate = rules.find((r) => r.kind === 'rate');
    if (rate) {
      const who = rate.per === PER_TOOL ? '*' : (user ?? 'anonymous');
      if (!this.counter.consume(`${tool}:${who}`, rate.limit, rate.seconds)) return Decision.deny(`more than ${rate.limit} calls in ${duration(rate.seconds)}`);
    }
    let hold = null;
    for (const l of rules.filter((r) => r.kind === 'limit')) {
      const v = args[l.argument];
      const f = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
      if (!Number.isFinite(f)) return Decision.deny(`"${l.argument}" must be a number`);
      if (l.min !== null && f < l.min) return Decision.deny(`${l.argument} ${f} is below the minimum of ${l.min}`);
      if (f > l.max) {
        const why = `${l.argument} ${f} is above the limit of ${l.max}`;
        if (l.above === ABOVE_DENY) return Decision.deny(why);
        hold ??= why;
      }
    }
    const approval = rules.find((r) => r.kind === 'approval');
    if (hold === null && approval) hold = approval.reason ?? `every "${tool}" is approved by a human`;
    return hold !== null ? Decision.pending(hold) : Decision.allow();
  }

  #hold(tool, args, user, agent, channel, reason) {
    const mine = this.approvals.all(PENDING).filter((a) => a.requestedBy === (user ?? null) && !expired(a, this.expireAfter));
    if (mine.length >= this.maxPendingPerUser) return Decision.deny(`${mine.length} requests already wait for a human`);
    const a = newApproval({ tool, args: JSON.parse(JSON.stringify(args ?? {})), user, reason, channel, agent });
    this.approvals.save(a);
    return Decision.pending(reason, a.id);
  }

  // A human approves: the tool runs now, with the arguments it was asked with.
  async approve(id, by) {
    const a = this.#waiting(id, by);
    const t = this.#tools.get(a.tool);
    if (!t) throw new Error(`tool "${a.tool}" is not registered with this guard`);
    try {
      const result = await t.fn(a.arguments);
      Object.assign(a, { status: APPROVED, result: result == null ? null : String(typeof result === 'object' ? JSON.stringify(result) : result).slice(0, 2000) });
    } catch (e) {
      Object.assign(a, { status: FAILED, result: `${e?.name ?? 'Error'}: ${e?.message ?? e}`.slice(0, 2000) });
    }
    Object.assign(a, { decidedBy: by, decidedAt: nowIso() });
    this.approvals.save(a);
    this.journal.record({ event: 'approval', tool: a.tool, approval: a.id, status: a.status, by });
    return a;
  }

  reject(id, by) {
    const a = this.#waiting(id, by);
    Object.assign(a, { status: REJECTED, decidedBy: by, decidedAt: nowIso() });
    this.approvals.save(a);
    this.journal.record({ event: 'approval', tool: a.tool, approval: a.id, status: a.status, by });
    return a;
  }

  #waiting(id, by) {
    const a = this.approvals.get(id);
    if (!a) throw new Error(`no request ${id}`);
    if (a.status !== PENDING) throw new Error(`request ${id} is already ${a.status}`);
    if (expired(a, this.expireAfter)) throw new Error(`request ${id} has expired`);
    if (this.fourEyes && by === a.requestedBy) throw new Error('four eyes: the person who asked cannot approve their own request');
    return a;
  }

  stop(scope = 'all', target = null, { by = null, reason = null } = {}) {
    if (!this.stops) throw new Error('no stop store configured');
    if (!SCOPES.includes(scope) || ((scope === 'tool' || scope === 'agent') !== Boolean(target))) {
      throw new TypeError('stop: scope all|agents (no target) or tool|agent (with a target)');
    }
    this.stops.stop({ scope, target, by, reason, at: nowIso() });
    this.journal.record({ event: 'stop', scope, target, by, reason });
  }

  resume(scope = 'all', target = null, { by = null } = {}) {
    if (!this.stops) return false;
    const done = this.stops.resume(scope, target);
    if (done) this.journal.record({ event: 'resume', scope, target, by });
    return done;
  }

  rules() {
    return Object.fromEntries([...this.#tools.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([n, t]) => [n, describe(t.rules)]));
  }
}

function duration(s) {
  for (const [unit, n] of [['day', 86400], ['hour', 3600], ['minute', 60]]) {
    if (s >= n && s % n === 0) return `${s / n} ${unit}${s / n > 1 ? 's' : ''}`;
  }
  return `${s} seconds`;
}

export { APPROVAL };
