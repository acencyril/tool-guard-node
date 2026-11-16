// The Léa example: a support agent may refund up to 50 €; above that, a human approves.
import { APPROVAL, FileApprovals, FileJournal, FileStops, Guard, limit } from '../src/index.js';

export const guard = new Guard({
  approvals: new FileApprovals('var/tool-guard/approvals'),
  journal: new FileJournal('var/tool-guard/journal.jsonl'),
  stops: new FileStops('var/tool-guard/stops.json'),
});

export const refund = guard.wrap('refund', [limit('amount', { max: 50, above: APPROVAL, min: 0 })],
  async ({ order, amount }) => `Refund of ${amount.toFixed(2)} € done on order ${order}.`);

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(await refund({ order: 'A-12', amount: 30 }));
  console.log(await refund({ order: 'A-13', amount: 180 }));
}
