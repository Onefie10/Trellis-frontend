import {
  runIncidentDrill,
  verifyRecoveryDrill,
  verifyRollbackDrill,
  verifyDataValidationDrill,
  verifyUserImpactDrill,
  calculateIncidentReport,
  classifyDrillError,
  DrillCheckpointStore,
  DrillOperationEngine,
} from '../../scripts/incident-drill.mjs';

describe('Incident Drill Verification Suite', () => {
  describe('Full Incident Drill Runner', () => {
    it('executes all four drill scenarios successfully', async () => {
      const results = await runIncidentDrill({ scenario: 'all' });
      expect(results.isSuccess).toBe(true);
      expect(results.summary.total).toBe(4);
      expect(results.summary.passed).toBe(4);
      expect(results.summary.failures).toBe(0);
      expect(results.checks).toHaveLength(4);
      expect(results.checks.every((c) => c.status === 'pass')).toBe(true);
    });

    it('supports targeted execution of a single scenario', async () => {
      const recoveryResult = await runIncidentDrill({ scenario: 'recovery' });
      expect(recoveryResult.isSuccess).toBe(true);
      expect(recoveryResult.summary.total).toBe(1);
      expect(recoveryResult.checks[0].name).toBe('Recovery Workflow Drill');

      const rollbackResult = await runIncidentDrill({ scenario: 'rollback' });
      expect(rollbackResult.isSuccess).toBe(true);
      expect(rollbackResult.summary.total).toBe(1);
      expect(rollbackResult.checks[0].name).toBe('Emergency Rollback Drill');
    });

    it('enforces strict mode where warnings are treated as failures', async () => {
      const strictResult = await runIncidentDrill({ scenario: 'all', strict: true });
      expect(strictResult.isSuccess).toBe(true);
      expect(strictResult.summary.warnings).toBe(0);
    });
  });

  describe('Scenario 1: Multi-Step Recovery Drill', () => {
    it('fences completed side-effect steps and resumes interrupted operations without duplicates', async () => {
      const result = await verifyRecoveryDrill();
      expect(result.status).toBe('pass');
      expect(result.details.skippedSteps).toContain('mint_soroban_agent');
      expect(result.details.executedSteps).toContain('publish_ipfs_meta');
      expect(result.details.invocationCounts.mint_soroban_agent).toBe(1);
    });

    it('blocks double-execution when an operation is already in progress', async () => {
      const store = new DrillCheckpointStore();
      const engine = new DrillOperationEngine(store);
      const op = engine.createOperation('test_op', 'Test Guard', [{ id: 's1', label: 'Step 1', sideEffect: false }]);

      // Manually set status to in_progress
      op.status = 'in_progress';
      store.saveOperation(op);

      const res = await engine.execute(op.id, async () => ({}));
      expect(res.completed).toBe(false);
      expect(res.error).toMatch(/already in progress/i);
    });

    it('prevents resumption of permanently failed operations', async () => {
      const store = new DrillCheckpointStore();
      const engine = new DrillOperationEngine(store);
      const op = engine.createOperation('test_op', 'Failed Op', [{ id: 's1', label: 'Step 1', sideEffect: false }]);

      op.status = 'failed';
      store.saveOperation(op);

      const res = await engine.execute(op.id, async () => ({}));
      expect(res.completed).toBe(false);
      expect(res.error).toMatch(/permanently failed/i);
    });

    it('returns completed=true immediately if operation is already completed', async () => {
      const store = new DrillCheckpointStore();
      const engine = new DrillOperationEngine(store);
      const op = engine.createOperation('test_op', 'Done Op', [{ id: 's1', label: 'Step 1', sideEffect: false }]);

      op.status = 'completed';
      store.saveOperation(op);

      const res = await engine.execute(op.id, async () => {
        throw new Error('Should not run');
      });
      expect(res.completed).toBe(true);
      expect(res.executedSteps).toEqual([]);
    });
  });

  describe('Scenario 2: Emergency Rollback Drill', () => {
    it('restores state to clean baseline snapshot upon detecting invariant corruption', async () => {
      const result = await verifyRollbackDrill();
      expect(result.status).toBe('pass');
      expect(result.details.baselineHash).toBe(result.details.restoredHash);
      expect(result.details.violationsPrevented).toBeGreaterThan(0);
    });
  });

  describe('Scenario 3: Domain Data Validation Drill', () => {
    it('validates baseline dataset with 0 false positives and catches corrupted records', async () => {
      const result = await verifyDataValidationDrill();
      expect(result.status).toBe('pass');
      expect(result.details.healthyChecksPassed).toBeGreaterThan(0);
      expect(result.details.corruptedErrorsDetected).toBeGreaterThan(0);
    });
  });

  describe('Scenario 4: User-Impact Reporting Drill', () => {
    it('accurately attributes blast radius, affected wallets, and incident severity', async () => {
      const result = await verifyUserImpactDrill();
      expect(result.status).toBe('pass');
      expect(result.details.severity).toBe('P1');
      expect(result.details.affectedWalletsCount).toBe(3);
      expect(result.details.deadLetterQueueCount).toBe(3);
      expect(result.details.announcement.title).toBe('Service Degradation Alert');
    });

    it('classifies transient vs permanent errors correctly', () => {
      const rateLimit = classifyDrillError(429, 'Too many requests');
      expect(rateLimit.isRetryable).toBe(true);
      expect(rateLimit.kind).toBe('transient');

      const timeout = classifyDrillError(504, 'Gateway timeout');
      expect(timeout.isRetryable).toBe(true);
      expect(timeout.kind).toBe('transient');

      const badSignature = classifyDrillError(400, 'Invalid signature');
      expect(badSignature.isRetryable).toBe(false);
      expect(badSignature.kind).toBe('permanent');
    });

    it('grades low failure rates as P3 operational notices', () => {
      const lowImpactEvents = [
        { id: '1', operation: 'transfer', wallet: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7', status: 'success' },
        { id: '2', operation: 'transfer', wallet: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7', status: 'success' },
        { id: '3', operation: 'transfer', wallet: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7', status: 'success' },
      ];
      const report = calculateIncidentReport(lowImpactEvents);
      expect(report.severity).toBe('P3');
      expect(report.failedOperations).toBe(0);
      expect(report.failureRatePercent).toBe(0);
      expect(report.announcement.title).toBe('Operational Notice');
    });
  });
});
