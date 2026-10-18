import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const budgets = JSON.parse(readFileSync(resolve(root, 'scripts/resource-budgets.json'), 'utf8'));

function makeRecords(count, create) {
  return Array.from({ length: count }, (_, index) => create(index));
}

const workloads = {
  worstCaseUser(count) {
    const events = makeRecords(count, (index) => ({
      amount: (index % 100) + 1,
      status: index % 7 === 0 ? 'pending' : 'settled',
      description: `user-activity-${index}`,
    }));
    let total = 0;
    let pending = 0;
    for (const event of events) {
      total += event.amount;
      if (event.status === 'pending') pending += 1;
    }
    assert.ok(total > 0);
    assert.ok(pending > 0);
    return { recordsVisited: events.length, resultCount: 1 };
  },
  ledgerHistory(count) {
    const entries = makeRecords(count, (index) => ({
      debit: index % 2 === 0 ? index : 0,
      credit: index % 2 === 1 ? index : 0,
      ledger: index,
    }));
    let balance = 0;
    let newestLedger = -1;
    for (const entry of entries) {
      balance += entry.credit - entry.debit;
      newestLedger = entry.ledger;
    }
    assert.ok(Number.isFinite(balance));
    assert.equal(newestLedger, count - 1);
    return { recordsVisited: entries.length, resultCount: 1 };
  },
  searchCatalog(count, maxResults) {
    const documents = makeRecords(count, (index) => ({
      id: `agent-${index}`,
      name: `Agent ${index}`,
      description: index % 20 === 0 ? `stellar ledger analytics ${index}` : `market tool ${index}`,
    }));
    const query = 'stellar ledger';
    const matches = [];
    for (const document of documents) {
      const text = `${document.name} ${document.description}`.toLowerCase();
      if (query.split(' ').every((term) => text.includes(term))) {
        if (matches.length < maxResults) matches.push(document.id);
      }
    }
    assert.ok(matches.length > 0);
    return { recordsVisited: documents.length, resultCount: matches.length };
  },
};

for (const [name, budget] of Object.entries(budgets.workloads)) {
  const run = workloads[name];
  assert.equal(typeof run, 'function', `No workload implementation for ${name}`);
  assert.ok(Number.isInteger(budget.records) && budget.records > 0, `${name}: records must be positive`);
  assert.ok(budget.records <= budget.maxRecords, `${name}: fixture exceeds maxRecords`);

  const heapBefore = process.memoryUsage().heapUsed;
  const started = performance.now();
  const result = run(budget.records, budget.maxResults);
  const durationMs = performance.now() - started;
  const heapGrowthBytes = Math.max(0, process.memoryUsage().heapUsed - heapBefore);

  assert.ok(result.recordsVisited <= budget.maxRecords, `${name}: visited too many records`);
  if (budget.maxResults !== undefined) {
    assert.ok(result.resultCount <= budget.maxResults, `${name}: result cap exceeded`);
  }
  assert.ok(durationMs <= budget.maxDurationMs,
    `${name}: took ${durationMs.toFixed(1)}ms (budget ${budget.maxDurationMs}ms)`);
  assert.ok(heapGrowthBytes <= budget.maxHeapGrowthBytes,
    `${name}: grew heap by ${heapGrowthBytes} bytes (budget ${budget.maxHeapGrowthBytes} bytes)`);
  console.log(`${name}: ${result.recordsVisited} records, ${result.resultCount} result(s), ${durationMs.toFixed(1)}ms, ${heapGrowthBytes} heap bytes`);
}

console.log('All resource workload budgets passed.');
