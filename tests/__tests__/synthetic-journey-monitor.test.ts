import {
  classifyDependencyBlame,
  createDefaultAdapters,
  DEFAULT_SLA_CONFIG,
  mergeSlaConfig,
  resolveSlaThreshold,
  runSyntheticJourney,
  SyntheticJourneyScheduler,
  SYNTHETIC_ACTOR_PUBLIC_KEY,
  SYNTHETIC_AGENT_ID,
  type JourneyAdapters,
  type JourneyStepId,
} from '../../lib/journey-monitor';
import { main } from '../../scripts/synthetic-journey-monitor';

describe('Synthetic Journey Monitor', () => {
  describe('SLA Configuration', () => {
    test('resolves default step SLA thresholds correctly', () => {
      expect(resolveSlaThreshold('wallet_session_check')).toBe(250);
      expect(resolveSlaThreshold('catalog_agent_lookup')).toBe(350);
      expect(resolveSlaThreshold('ipfs_metadata_fetch')).toBe(800);
      expect(resolveSlaThreshold('protocol_guard_evaluation')).toBe(200);
      expect(resolveSlaThreshold('soroban_preflight_simulation')).toBe(1200);
      expect(resolveSlaThreshold('transaction_submission')).toBe(2500);
      expect(resolveSlaThreshold('post_execution_state_verification')).toBe(300);
    });

    test('allows custom SLA overrides', () => {
      const custom = mergeSlaConfig({ walletSessionMs: 500, totalJourneyMs: 8000 });
      expect(custom.walletSessionMs).toBe(500);
      expect(custom.totalJourneyMs).toBe(8000);
      expect(custom.sorobanPreflightMs).toBe(DEFAULT_SLA_CONFIG.sorobanPreflightMs);
    });
  });

  describe('Happy Path Execution', () => {
    test('successfully executes all 7 steps of the critical workflow', async () => {
      const result = await runSyntheticJourney();

      expect(result.status).toBe('healthy');
      expect(result.workflow).toBe('agent-acquisition-and-execution');
      expect(result.totalDurationMs).toBeGreaterThan(0);
      expect(result.totalDurationMs).toBeLessThanOrEqual(result.totalSlaThresholdMs);
      expect(result.steps).toHaveLength(7);

      const stepIds: JourneyStepId[] = [
        'wallet_session_check',
        'catalog_agent_lookup',
        'ipfs_metadata_fetch',
        'protocol_guard_evaluation',
        'soroban_preflight_simulation',
        'transaction_submission',
        'post_execution_state_verification',
      ];

      for (let i = 0; i < stepIds.length; i += 1) {
        expect(result.steps[i].stepId).toBe(stepIds[i]);
        expect(result.steps[i].status).toBe('passed');
        expect(result.steps[i].durationMs).toBeLessThanOrEqual(result.steps[i].slaThresholdMs);
        expect(result.steps[i].error).toBeUndefined();
      }

      expect(result.metadata.actorPublicKey).toBe(SYNTHETIC_ACTOR_PUBLIC_KEY);
      expect(result.metadata.agentId).toBe(SYNTHETIC_AGENT_ID);
      expect(result.blame).toBeUndefined();
    });
  });

  describe('Dependency Blame Attribution', () => {
    test('attributes blame to wallet-session on invalid public key', async () => {
      const adapters = createDefaultAdapters({ scenario: 'wallet_invalid' });
      const result = await runSyntheticJourney({}, adapters);

      expect(result.status).toBe('failed');
      expect(result.steps[0].status).toBe('failed');
      expect(result.steps).toHaveLength(1); // Halts immediately after first step
      expect(result.blame).toBeDefined();
      expect(result.blame?.culprit).toBe('wallet-session');
      expect(result.blame?.severity).toBe('critical');
      expect(result.blame?.retriable).toBe(false);
      expect(result.blame?.reason).toContain('validation failed');
    });

    test('attributes blame to wallet-session on unfunded reserve', async () => {
      const adapters = createDefaultAdapters({ scenario: 'wallet_unfunded' });
      const result = await runSyntheticJourney({}, adapters);

      expect(result.status).toBe('failed');
      expect(result.blame?.culprit).toBe('wallet-session');
      expect(result.blame?.reason).toContain('minimum network reserve');
    });

    test('attributes blame to marketplace-catalog when agent is missing', async () => {
      const adapters = createDefaultAdapters({ scenario: 'catalog_missing' });
      const result = await runSyntheticJourney({}, adapters);

      expect(result.status).toBe('failed');
      expect(result.steps[0].status).toBe('passed');
      expect(result.steps[1].status).toBe('failed');
      expect(result.blame?.culprit).toBe('marketplace-catalog');
      expect(result.blame?.suggestedRemediation).toContain('search index');
    });

    test('attributes blame to ipfs-gateway on 504 gateway timeout', async () => {
      const adapters = createDefaultAdapters({ scenario: 'ipfs_down' });
      const result = await runSyntheticJourney({}, adapters);

      expect(result.status).toBe('failed');
      expect(result.steps[2].status).toBe('failed');
      expect(result.blame?.culprit).toBe('ipfs-gateway');
      expect(result.blame?.severity).toBe('critical');
      expect(result.blame?.confidence).toBeGreaterThanOrEqual(0.95);
      expect(result.blame?.suggestedRemediation).toContain('IPFS');
    });

    test('attributes blame to protocol-guard on emergency pause', async () => {
      const adapters = createDefaultAdapters({ scenario: 'emergency_paused' });
      const result = await runSyntheticJourney({}, adapters);

      expect(result.status).toBe('failed');
      expect(result.steps[3].status).toBe('failed');
      expect(result.blame?.culprit).toBe('protocol-guard');
      expect(result.blame?.retriable).toBe(false);
      expect(result.blame?.reason).toContain('paused by governance emergency control');
      expect(result.blame?.suggestedRemediation).toContain('Governance dashboard');
    });

    test('attributes blame to protocol-guard on abuse risk block', async () => {
      const adapters = createDefaultAdapters({ scenario: 'abuse_risk' });
      const result = await runSyntheticJourney({}, adapters);

      expect(result.status).toBe('failed');
      expect(result.steps[3].status).toBe('failed');
      expect(result.blame?.culprit).toBe('protocol-guard');
      expect(result.blame?.reason).toContain('risk-scored abuse detection');
    });

    test('attributes blame to soroban-rpc on simulation timeout', async () => {
      const adapters = createDefaultAdapters({ scenario: 'rpc_timeout' });
      const result = await runSyntheticJourney({}, adapters);

      expect(result.status).toBe('failed');
      expect(result.steps[4].status).toBe('failed');
      expect(result.blame?.culprit).toBe('soroban-rpc');
      expect(result.blame?.suggestedRemediation).toContain('Soroban RPC');
    });

    test('attributes blame to soroban-rpc on resource limits exceeded', async () => {
      const adapters = createDefaultAdapters({ scenario: 'rpc_resource_exceeded' });
      const result = await runSyntheticJourney({}, adapters);

      expect(result.status).toBe('failed');
      expect(result.steps[4].status).toBe('failed');
      expect(result.blame?.culprit).toBe('soroban-rpc');
      expect(result.blame?.reason).toContain('resource limits or CPU budget');
    });

    test('attributes blame to stellar-horizon on HTTP 429 rate limit', async () => {
      const adapters = createDefaultAdapters({ scenario: 'horizon_rate_limited' });
      const result = await runSyntheticJourney({}, adapters);

      expect(result.status).toBe('failed');
      expect(result.steps[5].status).toBe('failed');
      expect(result.blame?.culprit).toBe('stellar-horizon');
      expect(result.blame?.reason).toContain('rate limit');
    });

    test('attributes blame to stellar-horizon on txBAD_SEQ sequence mismatch', async () => {
      const adapters = createDefaultAdapters({ scenario: 'horizon_bad_seq' });
      const result = await runSyntheticJourney({}, adapters);

      expect(result.status).toBe('failed');
      expect(result.steps[5].status).toBe('failed');
      expect(result.blame?.culprit).toBe('stellar-horizon');
      expect(result.blame?.reason).toContain('sequence number mismatch');
    });

    test('attributes blame to ledger-state on post-execution state desync', async () => {
      const adapters = createDefaultAdapters({ scenario: 'state_desync' });
      const result = await runSyntheticJourney({}, adapters);

      expect(result.status).toBe('failed');
      expect(result.steps[6].status).toBe('failed');
      expect(result.blame?.culprit).toBe('ledger-state');
      expect(result.blame?.reason).toContain('Post-execution ledger state invariant breached');
    });

    test('attributes blame to network on transport-level failure', () => {
      const blame = classifyDependencyBlame({
        stepId: 'ipfs_metadata_fetch',
        error: new Error('connect ECONNREFUSED 127.0.0.1:5001'),
        durationMs: 15,
        slaThresholdMs: 800,
      });

      expect(blame.culprit).toBe('network');
      expect(blame.confidence).toBe(0.95);
      expect(blame.suggestedRemediation).toContain('connectivity');
    });
  });

  describe('Latency SLA Evaluation & Degradation', () => {
    test('marks step as degraded when step duration exceeds SLA threshold', async () => {
      // Simulate artificial step delay exceeding SLA
      const adapters = createDefaultAdapters({
        stepDelaysMs: {
          soroban_preflight_simulation: 1300, // SLA is 1200
        },
      });

      const result = await runSyntheticJourney(
        {
          slaConfig: { sorobanPreflightMs: 50 }, // low threshold to guarantee breach
        },
        adapters,
      );

      const simStep = result.steps.find((s) => s.stepId === 'soroban_preflight_simulation');
      expect(simStep?.status).toBe('degraded');
      expect(result.status).toBe('degraded');
      expect(result.blame?.culprit).toBe('soroban-rpc');
      expect(result.blame?.reason).toContain('SLA breach');
    });

    test('strict mode converts degraded state to failed', async () => {
      const adapters = createDefaultAdapters();
      const result = await runSyntheticJourney(
        {
          slaConfig: { walletSessionMs: 1 }, // impossible threshold
          strictSla: true,
        },
        adapters,
      );

      expect(result.status).toBe('failed');
    });
  });

  describe('Synthetic Journey Scheduler & Rolling Metrics', () => {
    test('records results and calculates rolling metrics accurately', async () => {
      const scheduler = new SyntheticJourneyScheduler({ maxHistory: 5 });

      await scheduler.runOnce();
      await scheduler.runOnce();

      const metrics = scheduler.getMetrics();
      expect(metrics.totalRuns).toBe(2);
      expect(metrics.passedRuns).toBe(2);
      expect(metrics.failedRuns).toBe(0);
      expect(metrics.availabilityPercent).toBe(100);
      expect(metrics.meanDurationMs).toBeGreaterThan(0);
      expect(metrics.p95DurationMs).toBeGreaterThan(0);
      expect(metrics.p99DurationMs).toBeGreaterThan(0);
      expect(metrics.lastRun).toBeDefined();
    });

    test('enforces maxHistory boundary to avoid memory leak', async () => {
      const scheduler = new SyntheticJourneyScheduler({ maxHistory: 3 });

      for (let i = 0; i < 5; i += 1) {
        await scheduler.runOnce();
      }

      expect(scheduler.getHistory()).toHaveLength(3);
      expect(scheduler.getMetrics().totalRuns).toBe(3);
    });

    test('triggers onAlert callback when health transitions to failed', async () => {
      const alerts: Array<{ previousStatus: string; currentStatus: string }> = [];

      let currentScenario: 'healthy' | 'ipfs_down' = 'healthy';
      const dynamicAdapters: JourneyAdapters = {
        ...createDefaultAdapters(),
        ipfs: {
          async fetchMetadata(cid: string) {
            if (currentScenario === 'ipfs_down') {
              throw new Error('IPFS Gateway 504 Gateway Timeout');
            }
            return {
              name: 'Agent',
              version: '1.0.0',
              description: 'Desc',
              capabilities: ['test'],
              createdAt: '2026-01-01',
            };
          },
        },
      };

      const scheduler = new SyntheticJourneyScheduler({
        adapters: dynamicAdapters,
        onAlert: (alert) => {
          alerts.push({
            previousStatus: alert.previousStatus,
            currentStatus: alert.currentStatus,
          });
        },
      });

      // 1. Initial healthy run
      await scheduler.runOnce();
      expect(alerts).toHaveLength(0);

      // 2. Transition to failure
      currentScenario = 'ipfs_down';
      await scheduler.runOnce();

      expect(alerts).toHaveLength(1);
      expect(alerts[0].previousStatus).toBe('healthy');
      expect(alerts[0].currentStatus).toBe('failed');
    });

    test('clears history on request', async () => {
      const scheduler = new SyntheticJourneyScheduler();
      await scheduler.runOnce();
      expect(scheduler.getHistory()).toHaveLength(1);

      scheduler.clearHistory();
      expect(scheduler.getHistory()).toHaveLength(0);
      expect(scheduler.getMetrics().totalRuns).toBe(0);
    });
  });

  describe('CLI Script Execution', () => {
    test('main returns EXIT_OK (0) for --help', async () => {
      const code = await main(['--help']);
      expect(code).toBe(0);
    });

    test('main returns EXIT_OK (0) for healthy single run', async () => {
      const code = await main(['--json']);
      expect(code).toBe(0);
    });

    test('main returns EXIT_FAILED (1) for failed scenario', async () => {
      const code = await main(['--scenario', 'ipfs_down', '--json']);
      expect(code).toBe(1);
    });

    test('main returns EXIT_USAGE (2) for unknown option', async () => {
      const code = await main(['--invalid-flag']);
      expect(code).toBe(2);
    });
  });
});
