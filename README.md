# Tool Guard for Node

**A prompt asks. Tool Guard decides.**

An AI agent calls tools: refund an order, send an email, change a record. Telling it in the prompt "never refund
more than 50 €" is a request; a well-built message can talk it out of it. Tool Guard puts the rule in your code,
in front of the tool, and checks it **before** the tool runs, whatever the model was convinced of.

- **Limits** on an argument: above the maximum, refused, or held for a human.
- **Human approval**: the call waits; a person approves (then it runs) or rejects.
- **Permissions**: the current user must hold a permission.
- **Rate limits**: at most N calls in a window, per user or for the whole tool.
- **Agents and their tools**: each declared agent may only call the tools it is given.
- **Stop button**: stop everything, every AI agent, one tool or one agent, at once.
- **Journal**: one line per decision (who, which tool, which arguments, what was decided and why).
- **Observe mode**: run as usual and write down what would have been blocked, to try it on a live agent first.

No dependency. Node 18+. Types included. Works with the Vercel AI SDK, the OpenAI Agents SDK, MCP servers, or plain
function calling.

## Install

```bash
npm install @acencyril/tool-guard
```

## In a few lines

```js
import { APPROVAL, Guard, limit } from '@acencyril/tool-guard';

export const guard = new Guard();

export const refund = guard.wrap('refund',
  [limit('amount', { max: 50, above: APPROVAL, min: 0 })],
  async ({ order, amount }) => payments.refund(order, amount));
```

`refund({ order: 'A-12', amount: 30 })` runs. `refund({ order: 'A-13', amount: 180 })` does not run; it returns,
for the model:

> This action needs a human approval (amount 180 is above the limit of 50). Request f720c2b2 has been sent to the
> team; it is NOT done yet. Do not retry; tell the user it is pending review.

The wrapped function takes the same arguments object, and passes any extra parameter (a framework's context)
through, so it drops in as a tool's `execute` or handler.

## The rules

```js
import { APPROVAL, PER_TOOL, granted, limit, rateLimit, requiresApproval } from '@acencyril/tool-guard';

granted('finance')                                  // the current user must hold "finance"
granted('edit', { subject: 'account' })             // ... "edit" on the value of the `account` argument
limit('amount', { max: 1000 })                      // above 1000: refused
limit('amount', { max: 50, above: APPROVAL, min: 0 }) // above 50: held for a human; below 0: refused
rateLimit(5, { perSeconds: 60 })                    // 5 calls a minute per user (per: PER_TOOL for everyone)
requiresApproval('every wire is reviewed')          // every call waits for a human
```

A non-numeric or infinite value for a limited argument is refused (a numeric string such as `"120"` is read as a
number). A permission that cannot be checked is refused. A stop list that cannot be read refuses everything.
Tool Guard fails closed.

## The guard

```js
import { FileApprovals, FileCounter, FileJournal, FileStops, Guard } from '@acencyril/tool-guard';

export const guard = new Guard({
  approvals: new FileApprovals('var/tool-guard/approvals'),  // one JSON file per waiting request
  journal: new FileJournal('var/tool-guard/journal.jsonl'),   // one JSON line per decision
  stops: new FileStops('var/tool-guard/stops.json'),
  counter: new FileCounter('var/tool-guard/rate.json'),       // rate counters shared by every process
  currentUser: () => als.getStore()?.userId ?? null,         // who is asking
  isGranted: (permission, subject, user) => acl.allows(user, permission, subject),
  agents: { support: ['refund', 'lookupOrder'] },            // each agent and the tools it may call
  maxPendingPerUser: 3,                                      // past that, a new request is refused, not queued
  expireAfter: 3600,                                         // a request nobody answered in an hour expires
  fourEyes: true,                                            // nobody approves their own request
  mode: 'enforce',                                           // or 'observe'
});
```

Without options, everything is kept in memory: fine for tests and scripts. `wrap()` also takes
`{ user, agent, throwBlocked }`, where `user` and `agent` may be functions of the call's arguments and context.

Calls made by your own code, not by the model, go through `guard.call(name, args, { channel: 'code' })`: agent roles
and the "stop all agents" switch do not apply to them, every other rule does. It rejects with `ToolCallBlocked`.

## The human side

```bash
npx tool-guard --guard ./agent.js approvals             # what waits
npx tool-guard --guard ./agent.js approve f720c2b2 --by sophie
npx tool-guard --guard ./agent.js reject f720c2b2 --by sophie
npx tool-guard --guard ./agent.js stop tool refund --by cyril --reason "incident"
npx tool-guard --guard ./agent.js resume tool refund
npx tool-guard --guard ./agent.js rules
npx tool-guard --guard ./agent.js journal -n 50
```

`--guard` points to the module that exports your guard (`export const guard`, or default). Or from your own admin
page: `guard.approvals.all('pending')`, `await guard.approve(id, by)`, `guard.reject(id, by)`, `guard.stop(...)`,
`guard.resume(...)`. Approving runs the tool with the arguments it was asked with, and stores the result.

## With your framework

**Vercel AI SDK**

```js
import { tool } from 'ai';
const refundTool = tool({ description: 'Refund an order', inputSchema: z.object({ order: z.string(), amount: z.number() }), execute: refund });
```

**OpenAI Agents SDK**

```js
import { tool } from '@openai/agents';
const refundTool = tool({ name: 'refund', description: 'Refund an order', parameters: z.object({ order: z.string(), amount: z.number() }), execute: refund });
```

**MCP server** (TypeScript SDK)

```js
server.tool('refund', 'Refund an order', { order: z.string(), amount: z.number() },
  async (args) => ({ content: [{ type: 'text', text: await refund(args) }] }));
```

## What it is not

Tool Guard does not read the conversation and does not judge intent. It checks the actions an agent may take,
where they are executed. Keep good instructions in your prompt; put the rules that must hold in your code.

## License

MIT
