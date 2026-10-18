import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { normalizeDataset } from '../../lib/invariant-monitor/dataset';
import { evaluateInvariant, failingResults, runInvariantMonitor } from '../../lib/invariant-monitor/monitor';
import { renderJsonReport, renderTextReport } from '../../lib/invariant-monitor/report';
import { buildAlertPayloads, dispatchAlerts, type AlertChannel } from '../../lib/invariant-monitor/report';
import { ALL_INVARIANTS, DOMAIN_ID_PREFIX } from '../../lib/invariant-monitor/registry';
import {
  INVARIANT_DOMAINS,
  isSeverityAtLeast,
  severityRank,
  type InvariantResult,
  type MonitorReport,
} from '../../lib/invariant-monitor/types';
import { AUTHORIZATION_VOCABULARY } from '../../lib/invariant-monitor/invariants/authorization';

const FIXTURE_DIR = resolve(__dirname, '../fixtures/invariant-monitor');

function loadFixture(name: string): any {
  return JSON.parse(readFileSync(resolve(FIXTURE_DIR, name), 'utf-8'));
}

/** A fresh deep copy of the healthy baseline, safe to corrupt per test. */
function healthy(): any {
  return loadFixture('healthy-dataset.json');
}

function resultFor(report: MonitorReport, id: string): InvariantResult {
  const result = report.results.find((entry) => entry.id === id);
  if (!result) throw new Error(`No result for invariant ${id}`);
  return result;
}

describe('Trellis Invariant Monitor', () => {
  describe('Registry integrity', () => {
    it('exposes a unique, well-formed id for every invariant', () => {
      const ids = ALL_INVARIANTS.map((invariant) => invariant.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) expect(id).toMatch(/^[A-Z]+-\d{3}$/);
    });

    it('derives each id prefix from its domain', () => {
      for (const invariant of ALL_INVARIANTS) {
        expect(invariant.id.startsWith(`${DOMAIN_ID_PREFIX[invariant.domain]}-`)).toBe(true);
      }
    });

    it('covers all four required invariant domains', () => {
      const covered = new Set(ALL_INVARIANTS.map((invariant) => invariant.domain));
      expect([...covered].sort()).toEqual([...INVARIANT_DOMAINS].sort());
    });

    it('declares title, description, rationale and remediation for every invariant', () => {
      for (const invariant of ALL_INVARIANTS) {
        expect(invariant.title.trim()).not.toBe('');
        expect(invariant.description.trim()).not.toBe('');
        expect(invariant.rationale.trim()).not.toBe('');
        expect(invariant.remediation.trim()).not.toBe('');
      }
    });

    it('keeps its authorization vocabulary in step with the policy engine', () => {
      // If the policy engine gains a role or action, the mirrors here must too,
      // otherwise privileged events would silently escape AUTH-001.
      const { roles, actions } = AUTHORIZATION_VOCABULARY;
      expect(roles).toEqual(expect.arrayContaining(['admin', 'maintainer', 'user', 'guest']));
      expect(actions).toEqual(
        expect.arrayContaining([
          'create_agent',
          'transfer_funds',
          'invite_collaborator',
          'escalate_role',
          'retry_operation',
          'impersonate_user',
        ])
      );
    });
  });

  describe('Healthy baseline', () => {
    it('passes every registered invariant', () => {
      const report = runInvariantMonitor(healthy(), { now: new Date('2026-03-01T00:00:00Z') });

      const failed = failingResults(report);
      expect(
        failed.map((result) => ({
          id: result.id,
          messages: result.violations.map((violation) => violation.message),
        }))
      ).toEqual([]);
      expect(report.ok).toBe(true);
      expect(report.summary.failed).toBe(0);
      expect(report.summary.passed).toBe(ALL_INVARIANTS.length);
    });

    it('reports a pass or fail result for every invariant', () => {
      const report = runInvariantMonitor(healthy());

      expect(report.results).toHaveLength(ALL_INVARIANTS.length);
      expect(new Set(report.results.map((result) => result.id)).size).toBe(ALL_INVARIANTS.length);
      for (const result of report.results) {
        expect(['pass', 'fail']).toContain(result.status);
        if (result.status === 'pass') {
          expect(result.violations).toHaveLength(0);
        } else {
          expect(result.violations.length).toBeGreaterThan(0);
        }
      }
    });

    it('counts every collection it read, including ones it holds no data for', () => {
      const report = runInvariantMonitor(healthy());
      expect(report.summary.entitiesScanned).toEqual({
        agents: 2,
        testCases: 1,
        testExecutions: 1,
        provenanceRecords: 2,
        referralCodes: 1,
        referrals: 1,
        payouts: 1,
        earningsLedger: 1,
        bugReports: 1,
        authorizationEvents: 2,
      });
    });

    it('distinguishes a vacuous pass from real coverage', () => {
      const report = runInvariantMonitor({});
      expect(report.ok).toBe(true);
      // Nothing to evaluate is still reported, not silently omitted.
      for (const result of report.results) {
        expect(result.status).toBe('pass');
        expect(result.evaluatedRecords).toBe(0);
      }
      expect(report.summary.entitiesScanned.authorizationEvents).toBe(0);
    });
  });

  describe('Corrupted fixture detection', () => {
    const report = runInvariantMonitor(loadFixture('corrupted-dataset.json'));

    it.each([
      ['FUNDS-001', 'payout with an unparseable amount'],
      ['FUNDS-002', 'completed payout with no settlement reference'],
      ['FUNDS-003', 'payouts exceeding credited earnings'],
      ['FUNDS-004', 'payout below the minimum threshold'],
      ['FUNDS-005', 'negative earnings ledger entry'],
      ['FUNDS-006', 'settlement hash replayed across payouts'],
      ['OWN-001', 'duplicate entity identifier'],
      ['OWN-002', 'duplicate referral code'],
      ['OWN-003', 'referral pointing at an unregistered code'],
      ['OWN-004', 'self-referral'],
      ['OWN-005', 'malformed Stellar address'],
      ['OWN-006', 'provenance pointing at a deleted agent'],
      ['OWN-007', 'execution pointing at a missing test case'],
      ['OWN-008', 'referral code claimed by two wallets'],
      ['LIFE-001', 'unrecognized status enum'],
      ['LIFE-002', 'unparseable timestamp'],
      ['LIFE-003', 'execution ending before it starts'],
      ['LIFE-004', 'record updated before creation'],
      ['LIFE-005', 'referral converted before creation'],
      ['LIFE-006', 'payout processed before it was requested'],
      ['LIFE-007', 'conversion state disagreeing with its timestamp'],
      ['LIFE-008', 'quality score outside [0, 100]'],
      ['AUTH-001', 'unrecognized authorization role'],
      ['AUTH-002', 'non-admin performing a privileged action'],
      ['AUTH-003', 'guest creating an agent'],
      ['AUTH-004', 'transfer above the policy ceiling'],
      ['AUTH-005', 'role escalation without confirmation'],
      ['AUTH-006', 'self-impersonation'],
      ['AUTH-007', 'privileged action with no audit trail'],
    ])('detects %s — %s', (id) => {
      const result = resultFor(report, id);
      expect(result.status).toBe('fail');
      expect(result.violations.length).toBeGreaterThan(0);
    });

    it('fails the run at the default error threshold', () => {
      expect(report.ok).toBe(false);
      expect(report.summary.failed).toBeGreaterThan(0);
      expect(report.summary.violationsBySeverity.critical).toBeGreaterThan(0);
    });

    it('still resolves every invariant to pass or fail', () => {
      expect(report.results).toHaveLength(ALL_INVARIANTS.length);
      for (const result of report.results) {
        expect(['pass', 'fail']).toContain(result.status);
      }
    });
  });

  describe('Failures carry actionable detail', () => {
    const report = runInvariantMonitor(loadFixture('corrupted-dataset.json'));

    it('gives every failure affected record identifiers', () => {
      for (const result of failingResults(report)) {
        for (const violation of result.violations) {
          expect(violation.records.length).toBeGreaterThan(0);
          for (const record of violation.records) {
            expect(record.entityType).not.toBe('');
            expect(record.entityId).not.toBe('');
            expect(record.detail).not.toBe('');
          }
        }
      }
    });

    it('gives every failure safe next steps', () => {
      for (const result of failingResults(report)) {
        for (const violation of result.violations) {
          expect(violation.remediation.trim().length).toBeGreaterThan(10);
        }
      }
    });

    it('names the specific records behind a failure', () => {
      const payoutBalance = resultFor(report, 'FUNDS-003');
      const ids = payoutBalance.violations.flatMap((violation) =>
        violation.records.map((record) => record.entityId)
      );
      expect(ids).toEqual(expect.arrayContaining(['pay-c2', 'pay-c3', 'pay-c4']));
    });

    it('falls back to the invariant-level remediation when a violation omits one', () => {
      const dataset = healthy();
      dataset.payouts[0].amount = '0';
      const local = runInvariantMonitor(dataset);
      const violation = resultFor(local, 'FUNDS-001').violations[0];
      expect(violation.remediation).toBe(
        ALL_INVARIANTS.find((invariant) => invariant.id === 'FUNDS-001')?.remediation
      );
    });

    it('assigns the severity declared by the invariant', () => {
      for (const result of failingResults(report)) {
        const declared = ALL_INVARIANTS.find((invariant) => invariant.id === result.id)?.severity;
        for (const violation of result.violations) {
          expect(violation.severity).toBe(declared);
        }
      }
    });
  });

  describe('Webhook alert dispatch', () => {
    const report = runInvariantMonitor(loadFixture('corrupted-dataset.json'));

    it('builds an immediate alert payload for critical violations', () => {
      const payloads = buildAlertPayloads(report, { threshold: 'critical' });
      expect(payloads.length).toBeGreaterThan(0);
      for (const payload of payloads) {
        expect(payload.severity).toBe('critical');
        expect(payload.title).toContain('Invariant');
        expect(payload.body).toContain('FUNDS');
      }
    });

    it('includes violation diff context and affected record ids', () => {
      const payloads = buildAlertPayloads(report, { threshold: 'critical' });
      const funds = payloads.find((payload) => payload.invariantId === 'FUNDS-003');
      expect(funds).toBeDefined();
      expect(funds?.affectedRecordIds).toEqual(expect.arrayContaining(['pay-c2', 'pay-c3', 'pay-c4']));
      expect(funds?.diffContext).toBeTruthy();
    });

    it('batches minor warnings instead of alerting immediately', () => {
      const payloads = buildAlertPayloads(report, { threshold: 'critical' });
      for (const payload of payloads) {
        expect(isSeverityAtLeast(payload.severity, 'critical')).toBe(true);
      }
    });

    it('dispatches payloads to configured webhook channels', async () => {
      const sent: any[] = [];
      const channels: AlertChannel[] = [
        {
          name: 'slack',
          kind: 'slack',
          url: 'https://hooks.slack.com/services/test',
          send: async (payload) => {
            sent.push(payload);
          },
        },
      ];
      const result = await dispatchAlerts(report, { threshold: 'critical', channels });
      expect(result.dispatched).toBeGreaterThan(0);
      expect(sent.length).toBe(result.dispatched);
    });
  });

  describe('Injected defect detection', () => {
    function detect(mutate: (dataset: any) => void, id: string): InvariantResult {
      const dataset = healthy();
      mutate(dataset);
      return resultFor(runInvariantMonitor(dataset), id);
    }

    it('detects a payout settled to an address that is not a Stellar key', () => {
      const result = detect((dataset) => {
        dataset.payouts[0].walletAddress = '0xdeadbeef';
      }, 'OWN-005');
      expect(result.status).toBe('fail');
      expect(result.violations[0].records[0].entityId).toBe('pay-1');
    });

    it('detects a completed payout with no transaction hash', () => {
      const result = detect((dataset) => {
        delete dataset.payouts[0].transactionHash;
      }, 'FUNDS-002');
      expect(result.status).toBe('fail');
      expect(result.violations[0].records[0]).toMatchObject({ entityType: 'PayoutRequest', entityId: 'pay-1' });
    });

    it('rejects an amount with trailing garbage that parseFloat would accept', () => {
      const result = detect((dataset) => {
        dataset.payouts[0].amount = '150.00 XLM';
      }, 'FUNDS-001');
      expect(result.status).toBe('fail');
    });

    it('detects a wallet paid with no earnings ledger entry at all', () => {
      const result = detect((dataset) => {
        dataset.earningsLedger = [];
      }, 'FUNDS-003');
      expect(result.status).toBe('fail');
      expect(result.violations[0].message).toContain('no earnings ledger entry');
    });

    it('detects one settlement hash claimed by two payouts', () => {
      const result = detect((dataset) => {
        dataset.payouts.push({ ...dataset.payouts[0], id: 'pay-2' });
      }, 'FUNDS-006');
      expect(result.status).toBe('fail');
      expect(result.violations[0].records.map((record) => record.entityId).sort()).toEqual(['pay-1', 'pay-2']);
    });

    it('detects an agent created by a guest', () => {
      const result = detect((dataset) => {
        dataset.authorizationEvents.push({
          id: 'authz-x',
          actorId: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7',
          actorRole: 'guest',
          action: 'create_agent',
          at: '2026-01-01T00:00:00.000Z',
        });
      }, 'AUTH-003');
      expect(result.status).toBe('fail');
      expect(result.violations[0].records[0].entityId).toBe('authz-x');
    });

    it('detects a transfer above the policy ceiling', () => {
      const result = detect((dataset) => {
        dataset.authorizationEvents[0].amountStroops = '10000000';
      }, 'AUTH-004');
      expect(result.status).toBe('fail');
    });

    it('detects a converted referral with no conversion time', () => {
      const result = detect((dataset) => {
        delete dataset.referrals[0].convertedAt;
      }, 'LIFE-007');
      expect(result.status).toBe('fail');
    });

    it('detects a settled payout with no processedAt stamp', () => {
      const result = detect((dataset) => {
        delete dataset.payouts[0].processedAt;
      }, 'LIFE-006');
      expect(result.status).toBe('fail');
    });
  });

  describe('Failure threshold', () => {
    it('treats a lone warning as passing at the default threshold', () => {
      const dataset = healthy();
      dataset.payouts[0].amount = '10.00';
      const report = runInvariantMonitor(dataset);

      expect(resultFor(report, 'FUNDS-004').status).toBe('fail');
      expect(report.summary.violationsBySeverity.warning).toBeGreaterThan(0);
      expect(report.ok).toBe(true);
    });

    it('fails on the same warning once the threshold is warning', () => {
      const dataset = healthy();
      dataset.payouts[0].amount = '10.00';
      const report = runInvariantMonitor(dataset, { failOn: 'warning' });

      expect(report.failOn).toBe('warning');
      expect(report.ok).toBe(false);
    });

    it('ranks severities in the documented order', () => {
      expect(severityRank('critical')).toBeLessThan(severityRank('error'));
      expect(severityRank('error')).toBeLessThan(severityRank('warning'));
      expect(isSeverityAtLeast('critical', 'error')).toBe(true);
      expect(isSeverityAtLeast('warning', 'error')).toBe(false);
    });
  });

  describe('Selection filters', () => {
    it('restricts evaluation to a single domain', () => {
      const report = runInvariantMonitor(loadFixture('corrupted-dataset.json'), { domains: ['funds'] });
      expect(report.results.every((result) => result.domain === 'funds')).toBe(true);
      expect(report.results.length).toBeGreaterThan(0);
    });

    it('restricts evaluation to specific invariant ids', () => {
      const report = runInvariantMonitor(loadFixture('corrupted-dataset.json'), { only: ['FUNDS-006'] });
      expect(report.results.map((result) => result.id)).toEqual(['FUNDS-006']);
    });
  });

  describe('Read-only guarantee', () => {
    it('does not mutate the snapshot it inspects', () => {
      const dataset = loadFixture('corrupted-dataset.json');
      const before = JSON.stringify(dataset);
      runInvariantMonitor(dataset);
      expect(JSON.stringify(dataset)).toBe(before);
    });

    it('does not mutate the healthy baseline either', () => {
      const dataset = healthy();
      const before = JSON.stringify(dataset);
      runInvariantMonitor(dataset);
      expect(JSON.stringify(dataset)).toBe(before);
    });

    it('survives a snapshot that is not shaped like a dataset at all', () => {
      for (const junk of [null, undefined, 42, 'a string', [1, 2, 3]]) {
        const report = runInvariantMonitor(junk);
        expect(report.ok).toBe(true);
        expect(report.results).toHaveLength(ALL_INVARIANTS.length);
      }
    });

    it('drops collection members that are not records rather than throwing', () => {
      const dataset = normalizeDataset({ payouts: [null, 'nope', 7, { id: 'pay-ok', amount: '150.00' }] });
      expect(dataset.payouts).toHaveLength(1);
      expect(() => runInvariantMonitor(dataset)).not.toThrow();
    });

    it('ignores a collection that is present but not an array', () => {
      const report = runInvariantMonitor({ payouts: 'not-an-array', agents: { nope: true } });
      expect(report.summary.entitiesScanned.payouts).toBe(0);
      expect(report.summary.entitiesScanned.agents).toBe(0);
      expect(report.ok).toBe(true);
    });
  });

  describe('Report rendering', () => {
    const healthyReport = runInvariantMonitor(healthy(), { source: 'healthy-dataset.json' });
    const failedReport = runInvariantMonitor(loadFixture('corrupted-dataset.json'), {
      source: 'corrupted-dataset.json',
    });

    it('renders every invariant in the text report, pass or fail', () => {
      const text = renderTextReport(healthyReport, { color: false });
      for (const invariant of ALL_INVARIANTS) {
        expect(text).toContain(invariant.id);
      }
    });

    it('emits no ANSI escapes when colour is disabled', () => {
      expect(renderTextReport(failedReport, { color: false })).not.toContain('[31m');
    });

    it('surfaces record ids and next steps in the text report', () => {
      const text = renderTextReport(failedReport, { color: false });
      expect(text).toContain('PayoutRequest#pay-c3');
      expect(text).toContain('Next step:');
    });

    it('produces JSON that round-trips the whole report', () => {
      const parsed = JSON.parse(renderJsonReport(failedReport));
      expect(parsed.ok).toBe(false);
      expect(parsed.results).toHaveLength(ALL_INVARIANTS.length);
      expect(parsed.results.find((r: { id: string }) => r.id === 'FUNDS-002').status).toBe('fail');
    });

    it('stamps the report with the injected clock', () => {
      const report = runInvariantMonitor(healthy(), { now: new Date('2026-03-01T12:00:00.000Z') });
      expect(report.timestamp).toBe('2026-03-01T12:00:00.000Z');
    });
  });

  describe('Fault isolation', () => {
    const exploding = {
      id: 'FUNDS-999',
      domain: 'funds' as const,
      title: 'Explodes on evaluation',
      description: 'Throws unconditionally.',
      rationale: 'Used to prove a faulty rule cannot abort the run.',
      severity: 'critical' as const,
      remediation: 'Fix the invariant, then re-run the monitor.',
      evaluate: () => {
        throw new Error('boom');
      },
    };

    it('turns a thrown error into a reported failure', () => {
      const result = evaluateInvariant(exploding, normalizeDataset(healthy()));

      expect(result.status).toBe('fail');
      expect(result.violations[0].message).toContain('could not be evaluated');
      expect(result.violations[0].remediation).toContain('tooling fault');
      expect(result.violations[0].records[0].entityId).toBe('FUNDS-999');
    });

    it('leaves the rest of the registry unaffected', () => {
      const report = runInvariantMonitor(healthy());
      expect(report.results).toHaveLength(ALL_INVARIANTS.length);
      expect(report.ok).toBe(true);
    });
  });
});
