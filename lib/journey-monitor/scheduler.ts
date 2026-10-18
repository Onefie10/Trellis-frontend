/**
 * Scheduled Synthetic Journey Monitor & Metrics Aggregator.
 *
 * Runs synthetic journeys periodically, bounds memory footprint,
 * computes rolling availability and p95/p99 latency percentiles, and
 * surfaces alert callbacks upon health status transitions.
 */

import { runSyntheticJourney } from './runner';
import type {
  DependencyCulprit,
  JourneyAdapters,
  JourneyMetricsSnapshot,
  JourneyStepId,
  SyntheticJourneyConfig,
  SyntheticJourneyResult,
} from './types';

export interface SchedulerOptions {
  intervalMs?: number;
  maxHistory?: number;
  config?: SyntheticJourneyConfig;
  adapters?: Partial<JourneyAdapters>;
  onResult?: (result: SyntheticJourneyResult) => void;
  onAlert?: (alert: {
    previousStatus: string;
    currentStatus: string;
    result: SyntheticJourneyResult;
  }) => void;
}

export const DEFAULT_MAX_HISTORY = 100;
export const DEFAULT_INTERVAL_MS = 60_000;

export class SyntheticJourneyScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly history: SyntheticJourneyResult[] = [];
  private readonly maxHistory: number;
  private readonly intervalMs: number;
  private readonly config: SyntheticJourneyConfig;
  private readonly adapters?: Partial<JourneyAdapters>;
  private readonly onResult?: (result: SyntheticJourneyResult) => void;
  private readonly onAlert?: (alert: {
    previousStatus: string;
    currentStatus: string;
    result: SyntheticJourneyResult;
  }) => void;

  private isExecuting = false;
  private lastStatus: string | null = null;

  constructor(options: SchedulerOptions = {}) {
    this.maxHistory = options.maxHistory ?? DEFAULT_MAX_HISTORY;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.config = options.config ?? {};
    this.adapters = options.adapters;
    this.onResult = options.onResult;
    this.onAlert = options.onAlert;
  }

  public async runOnce(): Promise<SyntheticJourneyResult> {
    if (this.isExecuting) {
      // Return most recent result if concurrent execution attempt occurs
      if (this.history.length > 0) {
        return this.history[this.history.length - 1];
      }
    }

    this.isExecuting = true;
    try {
      const result = await runSyntheticJourney(this.config, this.adapters);
      this.recordResult(result);
      return result;
    } finally {
      this.isExecuting = false;
    }
  }

  public start(): void {
    if (this.timer) return;

    // Immediately trigger initial run
    void this.runOnce();

    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.intervalMs);
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  public isRunning(): boolean {
    return this.timer !== null;
  }

  public getHistory(): readonly SyntheticJourneyResult[] {
    return [...this.history];
  }

  public clearHistory(): void {
    this.history.length = 0;
    this.lastStatus = null;
  }

  public getMetrics(): JourneyMetricsSnapshot {
    const totalRuns = this.history.length;
    if (totalRuns === 0) {
      return {
        totalRuns: 0,
        passedRuns: 0,
        degradedRuns: 0,
        failedRuns: 0,
        availabilityPercent: 100,
        meanDurationMs: 0,
        p95DurationMs: 0,
        p99DurationMs: 0,
        blameDistribution: createEmptyBlameDistribution(),
        stepAveragesMs: createEmptyStepAverages(),
      };
    }

    let passedRuns = 0;
    let degradedRuns = 0;
    let failedRuns = 0;
    const durations: number[] = [];
    const blameDistribution = createEmptyBlameDistribution();
    const stepDurations: Record<JourneyStepId, number[]> = {
      wallet_session_check: [],
      catalog_agent_lookup: [],
      ipfs_metadata_fetch: [],
      protocol_guard_evaluation: [],
      soroban_preflight_simulation: [],
      transaction_submission: [],
      post_execution_state_verification: [],
    };

    for (const run of this.history) {
      durations.push(run.totalDurationMs);
      if (run.status === 'healthy') passedRuns += 1;
      else if (run.status === 'degraded') degradedRuns += 1;
      else if (run.status === 'failed') failedRuns += 1;

      if (run.blame) {
        blameDistribution[run.blame.culprit] =
          (blameDistribution[run.blame.culprit] || 0) + 1;
      }

      for (const step of run.steps) {
        if (stepDurations[step.stepId]) {
          stepDurations[step.stepId].push(step.durationMs);
        }
      }
    }

    durations.sort((a, b) => a - b);
    const meanDurationMs = Math.round(
      durations.reduce((acc, curr) => acc + curr, 0) / totalRuns,
    );
    const p95DurationMs = calculatePercentile(durations, 0.95);
    const p99DurationMs = calculatePercentile(durations, 0.99);

    // Availability excludes failed runs from total
    const availabilityPercent = parseFloat(
      (((totalRuns - failedRuns) / totalRuns) * 100).toFixed(2),
    );

    const stepAveragesMs = createEmptyStepAverages();
    for (const [stepId, list] of Object.entries(stepDurations)) {
      if (list.length > 0) {
        stepAveragesMs[stepId as JourneyStepId] = Math.round(
          list.reduce((acc, curr) => acc + curr, 0) / list.length,
        );
      }
    }

    return {
      totalRuns,
      passedRuns,
      degradedRuns,
      failedRuns,
      availabilityPercent,
      meanDurationMs,
      p95DurationMs,
      p99DurationMs,
      blameDistribution,
      stepAveragesMs,
      lastRun: this.history[this.history.length - 1],
    };
  }

  private recordResult(result: SyntheticJourneyResult): void {
    this.history.push(result);
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }

    if (this.onResult) {
      this.onResult(result);
    }

    const previousStatus = this.lastStatus;
    this.lastStatus = result.status;

    if (
      this.onAlert &&
      previousStatus &&
      previousStatus !== result.status &&
      (result.status === 'failed' || result.status === 'degraded')
    ) {
      this.onAlert({
        previousStatus,
        currentStatus: result.status,
        result,
      });
    }
  }
}

function calculatePercentile(sorted: number[], percentile: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(percentile * sorted.length) - 1),
  );
  return sorted[index];
}

function createEmptyBlameDistribution(): Record<DependencyCulprit, number> {
  return {
    'wallet-session': 0,
    'marketplace-catalog': 0,
    'ipfs-gateway': 0,
    'protocol-guard': 0,
    'soroban-rpc': 0,
    'stellar-horizon': 0,
    'receipt-service': 0,
    'ledger-state': 0,
    network: 0,
  };
}

function createEmptyStepAverages(): Record<JourneyStepId, number> {
  return {
    wallet_session_check: 0,
    catalog_agent_lookup: 0,
    ipfs_metadata_fetch: 0,
    protocol_guard_evaluation: 0,
    soroban_preflight_simulation: 0,
    transaction_submission: 0,
    post_execution_state_verification: 0,
  };
}
