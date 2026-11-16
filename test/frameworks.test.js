// The guarded function plugs into the usual agent frameworks as their execute / handler; the model gets Tool
// Guard's message as the tool's answer when the call is blocked.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';

import { APPROVAL, Guard, limit } from '../src/index.js';

const guard = new Guard();
const refund = guard.wrap('refund', [limit('amount', { max: 50, above: APPROVAL, min: 0 })], async ({ order, amount }) => `refunded ${amount}`);
const schema = { order: z.string(), amount: z.number() };

const optional = async (name) => {
  try { return await import(name); } catch { return null; }
};

test('Vercel AI SDK', async (t) => {
  const ai = await optional('ai');
  if (!ai) return t.skip('ai not installed');
  const tl = ai.tool({ description: 'Refund an order', inputSchema: z.object(schema), execute: refund });
  assert.match(await tl.execute({ order: 'A', amount: 180 }, { toolCallId: '1', messages: [] }), /NOT done yet/);
  assert.equal(await tl.execute({ order: 'A', amount: 20 }, { toolCallId: '2', messages: [] }), 'refunded 20');
});

test('OpenAI Agents SDK', async (t) => {
  const agents = await optional('@openai/agents');
  if (!agents) return t.skip('@openai/agents not installed');
  const tl = agents.tool({ name: 'refund', description: 'Refund an order', parameters: z.object(schema), execute: refund });
  const ctx = new agents.RunContext({});
  assert.match(String(await tl.invoke(ctx, JSON.stringify({ order: 'A', amount: 180 }))), /NOT done yet/);
  assert.equal(String(await tl.invoke(ctx, JSON.stringify({ order: 'A', amount: 20 }))), 'refunded 20');
});

test('MCP server', async (t) => {
  const mcp = await optional('@modelcontextprotocol/sdk/server/mcp.js');
  const { Client } = (await optional('@modelcontextprotocol/sdk/client/index.js')) ?? {};
  const { InMemoryTransport } = (await optional('@modelcontextprotocol/sdk/inMemory.js')) ?? {};
  if (!mcp || !Client || !InMemoryTransport) return t.skip('@modelcontextprotocol/sdk not installed');
  const server = new mcp.McpServer({ name: 'shop', version: '1.0.0' });
  server.tool('refund', 'Refund an order', schema, async (args) => ({ content: [{ type: 'text', text: await refund(args) }] }));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const held = await client.callTool({ name: 'refund', arguments: { order: 'A', amount: 180 } });
  assert.match(held.content[0].text, /NOT done yet/);
  const ok = await client.callTool({ name: 'refund', arguments: { order: 'A', amount: 20 } });
  assert.equal(ok.content[0].text, 'refunded 20');
  await client.close();
});
