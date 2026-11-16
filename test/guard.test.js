import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  APPROVAL, FileApprovals, FileCounter, FileJournal, FileStops, Guard, MemoryStops, OBSERVE, PER_TOOL, ToolCallBlocked,
  granted, limit, rateLimit, requiresApproval,
} from '../src/index.js';

function make(opts = {}) {
  const paid = [];
  const guard = new Guard({ stops: new MemoryStops(), ...opts });
  const refund = guard.wrap('refund', [limit('amount', { max: 50, above: APPROVAL, min: 0 })], async ({ order, amount }) => {
    paid.push([order, amount]);
    return `refunded ${amount}`;
  });
  const transfer = guard.wrap('transfer', [limit('amount', { max: 1000 })], () => 'sent');
  return { guard, refund, transfer, paid };
}

test('within the rules it runs', async () => {
  const { guard, refund, paid } = make();
  assert.equal(await refund({ order: 'A-1', amount: 30 }), 'refunded 30');
  assert.deepEqual(paid, [['A-1', 30]]);
  assert.equal(guard.journal.entries.at(-1).verdict, 'allow');
});

test('above the limit it waits for a human, then runs once approved', async () => {
  const { guard, refund, paid } = make();
  const msg = await refund({ order: 'A-2', amount: 180 });
  assert.match(msg, /NOT done yet/);
  assert.match(msg, /amount 180 is above the limit of 50/);
  assert.deepEqual(paid, []);
  const [waiting] = guard.approvals.all('pending');
  const done = await guard.approve(waiting.id, 'sophie');
  assert.equal(done.status, 'approved');
  assert.deepEqual(paid, [['A-2', 180]]);
  await assert.rejects(guard.approve(waiting.id, 'sophie'), /already approved/);
});

test('refused rules never run', async () => {
  const { refund, transfer, paid } = make();
  assert.match(await transfer({ amount: 2000 }), /Refused by policy: amount 2000 is above the limit of 1000/);
  assert.match(await refund({ order: 'A', amount: -5 }), /below the minimum of 0/);
  for (const bad of ['lots', true, NaN, Infinity, null, '', {}]) {
    assert.match(await refund({ order: 'A', amount: bad }), /"amount" must be a number/, String(bad));
  }
  assert.match(await refund({ order: 'A', amount: '120' }), /NOT done yet/, 'a numeric string is read as a number');
  assert.deepEqual(paid, []);
});

test('throwBlocked and call()', async () => {
  const { guard } = make();
  await assert.rejects(guard.call('refund', { order: 'B', amount: 99 }), (e) => e instanceof ToolCallBlocked && e.held);
  assert.equal(await guard.call('refund', { order: 'B', amount: 10 }), 'refunded 10');
  const strict = guard.wrap('strict', [limit('n', { max: 1 })], () => 'ok', { throwBlocked: true });
  await assert.rejects(strict({ n: 2 }), ToolCallBlocked);
});

test('a flood of waiting requests is refused', async () => {
  const { refund } = make({ maxPendingPerUser: 2 });
  await refund({ order: 'x', amount: 100 });
  await refund({ order: 'x', amount: 100 });
  assert.match(await refund({ order: 'x', amount: 100 }), /2 requests already wait for a human/);
});

test('permissions', async () => {
  let current = 'visitor';
  const guard = new Guard({ isGranted: (perm, subject, user) => user === 'admin' && perm === 'finance', currentUser: () => current });
  const close = guard.wrap('close', [granted('finance')], () => 'closed');
  assert.match(await close({ account: 'C1' }), /permission "finance" not granted/);
  current = 'admin';
  assert.equal(await close({ account: 'C1' }), 'closed');
  const bare = new Guard();
  assert.match(await bare.wrap('x', [granted('X')], () => 1)({}), /cannot be checked/);
});

test('rate limits, per user and per tool, shared across processes', async () => {
  const guard = new Guard();
  const ping = guard.wrap('ping', [rateLimit(2, { perSeconds: 60 })], () => 'pong');
  assert.equal(await ping({}), 'pong');
  assert.equal(await ping({}), 'pong');
  assert.match(await ping({}), /more than 2 calls in 1 minute/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-'));
  const c = new FileCounter(path.join(dir, 'rate.json'));
  assert.ok(c.consume('k', 1, 60, 1_000_000));
  assert.ok(!new FileCounter(path.join(dir, 'rate.json')).consume('k', 1, 60, 1_010_000));
  assert.ok(c.consume('k', 1, 60, 1_061_000), 'a new window');
  let who = 'a';
  const g2 = new Guard({ currentUser: () => who });
  const f = g2.wrap('f', [rateLimit(1, { perSeconds: 60, per: PER_TOOL })], () => 'ok');
  assert.equal(await f({}), 'ok');
  who = 'b';
  assert.match(await f({}), /more than 1 calls/);
});

test('requires approval', async () => {
  const guard = new Guard();
  assert.match(await guard.wrap('wipe', [requiresApproval('wiping is reviewed')], () => 'wiped')({}), /human approval \(wiping is reviewed\)/);
});

test('stop button', async () => {
  const { guard, refund, transfer } = make();
  guard.stop('tool', 'refund', { by: 'cyril', reason: 'incident' });
  assert.match(await refund({ order: 'A', amount: 1 }), /tool "refund" is stopped \(incident\)/);
  assert.equal(await transfer({ amount: 1 }), 'sent');
  guard.stop('agents', null, { by: 'cyril' });
  assert.match(await transfer({ amount: 1 }), /AI agents are stopped/);
  assert.equal(await guard.call('transfer', { amount: 1 }, { channel: 'code' }), 'sent', "the app's own code is no agent");
  guard.resume('agents');
  guard.resume('tool', 'refund');
  assert.equal(await refund({ order: 'A', amount: 1 }), 'refunded 1');
  assert.throws(() => guard.stop('tool'), TypeError);
  const broken = new Guard({ stops: { all() { throw new Error('disk'); } } });
  assert.match(await broken.wrap('t', [], () => 1)({}), /stop state cannot be read/, 'fails closed');
});

test('agents and their tools', async () => {
  const guard = new Guard({ agents: { support: ['refund'] } });
  guard.wrap('refund', [], () => 'ok');
  guard.wrap('transfer', [], () => 'ok');
  assert.equal(await guard.call('refund', { amount: 1 }, { agent: 'support' }), 'ok');
  await assert.rejects(guard.call('transfer', { amount: 1 }, { agent: 'support' }), ToolCallBlocked);
  await assert.rejects(guard.call('refund', { amount: 1 }), ToolCallBlocked);
});

test('observe mode lets it run and writes what it would have done', async () => {
  const { guard, refund } = make({ mode: OBSERVE });
  assert.equal(await refund({ order: 'A', amount: 500 }), 'refunded 500');
  assert.equal(guard.journal.entries.at(-1).would, 'pending');
});

test('four eyes and expiry', async () => {
  const { guard, refund } = make({ fourEyes: true, currentUser: () => 'tom' });
  await refund({ order: 'A', amount: 100 });
  const [a] = guard.approvals.all('pending');
  await assert.rejects(guard.approve(a.id, 'tom'), /four eyes/);
  guard.reject(a.id, 'sophie');
  assert.equal(guard.approvals.get(a.id).status, 'rejected');
  const { guard: g2, refund: r2 } = make({ expireAfter: 0 });
  await r2({ order: 'A', amount: 100 });
  await assert.rejects(g2.approve(g2.approvals.all('pending')[0].id, 'x'), /expired/);
});

test('file stores survive a restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-'));
  const build = () => make({ approvals: new FileApprovals(path.join(dir, 'approvals')), journal: new FileJournal(path.join(dir, 'journal.jsonl')), stops: new FileStops(path.join(dir, 'stops.json')) });
  const first = build();
  await first.refund({ order: 'A-9', amount: 75 });
  const again = build();
  const [w] = again.guard.approvals.all('pending');
  assert.equal(w.arguments.amount, 75);
  await again.guard.approve(w.id, 'sophie');
  assert.deepEqual(again.paid, [['A-9', 75]]);
  assert.deepEqual(again.guard.journal.tail().map((e) => e.event), ['call', 'approval']);
  assert.equal(again.guard.approvals.get('../etc'), null);
  again.guard.stop('all', null, { by: 'c' });
  assert.equal(new FileStops(path.join(dir, 'stops.json')).all().length, 1);
});

test('rules are listed', () => {
  const { guard } = make();
  assert.deepEqual(guard.rules(), {
    refund: ['limit 0 ≤ amount ≤ 50, above: held for a human'],
    transfer: ['limit amount ≤ 1000, above: refused'],
  });
});

test('allowed values', async () => {
  const { allowedValues, DENY } = await import('../src/index.js');
  const guard = new Guard();
  const send = guard.wrap('send', [allowedValues('to', ['*@mycompany.com'])], () => 'sent');
  assert.equal(await send({ to: 'Anna@MyCompany.com' }), 'sent');
  assert.match(await send({ to: 'x@gmail.com' }), /to "x@gmail.com" is not among the allowed values/);
  assert.match(await send({ to: ['a@mycompany.com', 'x@gmail.com'] }), /NOT done yet/);
  const strict = guard.wrap('strict', [allowedValues('to', ['*@mycompany.com'], { otherwise: DENY })], () => 'sent');
  assert.match(await strict({}), /Refused by policy/);
});
