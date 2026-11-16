// The rules of a tool. Each helper only describes a rule; the Guard enforces them.
//
//   execute: guard.wrap('refund', [limit('amount', { max: 50, above: APPROVAL, min: 0 })], async ({ order, amount }) => ...)

export const APPROVAL = 'approval';
export const DENY = 'deny';
export const PER_USER = 'user';
export const PER_TOOL = 'tool';

export function granted(permission, { subject = null, message = null } = {}) {
  if (!permission) throw new TypeError('granted() needs a permission');
  return { kind: 'granted', permission, subject, message };
}

export function limit(argument, { max, above = DENY, min = null } = {}) {
  if (typeof max !== 'number' || !Number.isFinite(max)) throw new TypeError('limit() needs a numeric max');
  if (above !== DENY && above !== APPROVAL) throw new TypeError('limit(): above must be "deny" or "approval"');
  if (min !== null && (typeof min !== 'number' || !Number.isFinite(min))) throw new TypeError('limit(): min must be a number');
  return { kind: 'limit', argument, max, above, min };
}

export function rateLimit(limit, { perSeconds, per = PER_USER } = {}) {
  if (!(limit >= 1) || !(perSeconds >= 1) || (per !== PER_USER && per !== PER_TOOL)) {
    throw new TypeError('rateLimit() needs limit ≥ 1, perSeconds ≥ 1, per "user" or "tool"');
  }
  return { kind: 'rate', limit, seconds: perSeconds, per };
}

export function requiresApproval(reason = null) {
  return { kind: 'approval', reason };
}

const num = (v) => (Number.isInteger(v) ? String(v) : String(v));

export function describe(rules) {
  const out = [];
  for (const r of rules) {
    if (r.kind === 'granted') out.push(`granted ${r.permission}${r.subject ? ` on ${r.subject}` : ''}`);
    if (r.kind === 'rate') out.push(`rateLimit ${r.limit} per ${r.seconds}s, per ${r.per}`);
    if (r.kind === 'limit') out.push(`limit ${r.min !== null ? `${num(r.min)} ≤ ` : ''}${r.argument} ≤ ${num(r.max)}, above: ${r.above === DENY ? 'refused' : 'held for a human'}`);
    if (r.kind === 'approval') out.push(`requiresApproval${r.reason ? ` ${r.reason}` : ''}`);
  }
  return out;
}
