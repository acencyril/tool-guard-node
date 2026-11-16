#!/usr/bin/env node
// The human side, from a terminal. --guard points to a module that exports your Guard (named export "guard"
// or default):
//   tool-guard --guard ./agent.js approvals | approve ID --by sophie | reject ID --by sophie
//   tool-guard --guard ./agent.js stop [all|agents|tool NAME|agent NAME] --by cyril --reason "incident" | resume ...
//   tool-guard --guard ./agent.js rules | journal [-n 20]

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { Guard } from '../src/index.js';

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(name);
  if (i < 0) return null;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const spec = opt('--guard');
const by = opt('--by');
const reason = opt('--reason');
const n = Number(opt('-n') ?? 20);
const [cmd, a1, a2] = argv;
const usage = 'usage: tool-guard --guard ./agent.js approvals|approve ID --by NAME|reject ID --by NAME|stop [scope] [target]|resume [scope] [target]|rules|journal [-n N]';
if (!spec || !cmd) {
  console.error(usage);
  process.exit(2);
}
const mod = await import(pathToFileURL(path.resolve(spec)).href);
const guard = mod.guard ?? mod.default;
if (!(guard instanceof Guard)) {
  console.error(`${spec} exports no Guard (export const guard = new Guard(...))`);
  process.exit(2);
}

try {
  switch (cmd) {
    case 'approvals': {
      const waiting = guard.approvals.all('pending');
      for (const x of waiting) console.log(`${x.id}  ${x.requestedAt}  ${x.tool}(${JSON.stringify(x.arguments)})  by ${x.requestedBy ?? '-'}: ${x.reason}`);
      if (!waiting.length) console.log('Nothing waits for a human.');
      break;
    }
    case 'approve':
    case 'reject': {
      if (!a1 || !by) throw new Error(`${cmd} needs an id and --by`);
      const done = cmd === 'approve' ? await guard.approve(a1, by) : guard.reject(a1, by);
      console.log(`${done.id}: ${done.status}${done.result ? ` → ${done.result}` : ''}`);
      if (done.status === 'failed') process.exitCode = 1;
      break;
    }
    case 'stop':
      guard.stop(a1 ?? 'all', a2 ?? null, { by, reason });
      console.log('Stopped.');
      break;
    case 'resume':
      console.log(guard.resume(a1 ?? 'all', a2 ?? null, { by }) ? 'Resumed.' : 'Nothing was stopped there.');
      break;
    case 'rules':
      for (const [tool, lines] of Object.entries(guard.rules())) {
        console.log(tool + (lines.length ? ':' : ': no rule'));
        for (const l of lines) console.log(`  - ${l}`);
      }
      break;
    case 'journal':
      for (const e of guard.journal.tail(n)) console.log(JSON.stringify(e));
      break;
    default:
      console.error(usage);
      process.exitCode = 2;
  }
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
