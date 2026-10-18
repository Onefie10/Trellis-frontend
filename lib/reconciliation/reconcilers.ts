/**
 * Trellis Projection Reconcilers
 *
 * Pure domain reconcilers comparing source-of-truth state against cached or
 * derived projections:
 * 1. Affiliate & Earnings Ledger Reconciler (`affiliate-ledger`)
 * 2. Referral Click Analytics Reconciler (`referral-click-metrics`)
 * 3. Search & Discovery Index Reconciler (`search-index`)
 * 4. Telemetry Counter Reconciler (`telemetry-counters`)
 */

import type { AffiliateStats } from '@/features/affiliate-dashboard/types';
import type { IdempotencyTelemetryCounters } from '@/lib/idempotency';
import { computeReferralClickMetrics } from '@/lib/referral-metrics';
import {
  createIndexEntry,
  getRecordVisibility,
  shouldIndexRecord,
} from '@/lib/search-indexing';
import type { AbuseTelemetryCounters } from '@/store/apiMetricsStore';
import type {
  DriftFinding,
  ReconciliationProjectionState,
  ReconciliationSourceState,
  RepairOperation,
  RootCauseCode,
  RootCauseHint,
} from './types';

const ROOT_CAUSE_CATALOG: Record<RootCauseCode, RootCauseHint> = {
  MISSED_DOMAIN_EVENT: {
    code: 'MISSED_DOMAIN_EVENT',
    category: 'event-pipeline',
    summary: 'Authoritative mutation occurred without updating the downstream projection.',
    likelyCauses: [
      'Domain event consumer failed or was offline when the source record changed.',
      'Direct store write bypassed the domain event bus.',
    ],
    recommendedAction:
      'Preview and apply the recomputed projection entry, then inspect the domain event dead-letter queue for unconsumed events.',
    confidence: 'high',
  },
  PARTIAL_SIDE_EFFECT_WRITE: {
    code: 'PARTIAL_SIDE_EFFECT_WRITE',
    category: 'event-pipeline',
    summary: 'Multi-step mutation committed source-of-truth state but interrupted before projection write.',
    likelyCauses: [
      'Tab closure, network drop, or unhandled exception between source commit and projection update.',
      'Side-effect dispatcher retry exhausted before updating the derived ledger.',
    ],
    recommendedAction:
      'Run dry-run reconciliation and apply the recomputed ledger value; verify side-effect dead-letter entries.',
    confidence: 'high',
  },
  UNFLUSHED_DELETION_TOMBSTONE: {
    code: 'UNFLUSHED_DELETION_TOMBSTONE',
    category: 'cache-invalidation',
    summary: 'Cached or indexed projection retains an entry whose source-of-truth record was deleted or never existed.',
    likelyCauses: [
      'Deletion tombstone was dropped before reaching the cache/index invalidator.',
      'Out-of-band cleanup removed source records without purging derived projections.',
    ],
    recommendedAction:
      'Delete the orphaned projection entry via dry-run-first repair and confirm cache invalidation hooks are active.',
    confidence: 'high',
  },
  DUPLICATE_EVENT_REPLAY: {
    code: 'DUPLICATE_EVENT_REPLAY',
    category: 'concurrency',
    summary: 'Derived aggregate or counter exceeds the authoritative source sum due to non-idempotent replay.',
    likelyCauses: [
      'At-least-once event replay incremented a counter or balance without idempotency key deduplication.',
      'Multi-tab concurrent hydration applied the same delta twice.',
    ],
    recommendedAction:
      'Recompute the projection from the authoritative ledger via dry-run-first repair and verify idempotency key enforcement.',
    confidence: 'high',
  },
  STALE_CACHE_HYDRATION: {
    code: 'STALE_CACHE_HYDRATION',
    category: 'cache-invalidation',
    summary: 'Projection snapshot reflects an older version of the authoritative record.',
    likelyCauses: [
      'Browser local-storage or search index hydrated from a stale snapshot without revalidating.',
      'Background revalidation failed silently while serving cached projection state.',
    ],
    recommendedAction:
      'Refresh the projection from current source-of-truth fields through the dry-run repair plan.',
    confidence: 'medium',
  },
  PAYOUT_RESERVATION_MISMATCH: {
    code: 'PAYOUT_RESERVATION_MISMATCH',
    category: 'settlement',
    summary: 'Cached affiliate pending/paid totals disagree with authoritative payout settlement states.',
    likelyCauses: [
      'Payout transitioned between pending, completed, or failed without refreshing cached wallet stats.',
      'Failed payout reservation was not released in the cached summary projection.',
    ],
    recommendedAction:
      'Recompute wallet stats from the authoritative referral and payout ledgers.',
    confidence: 'high',
  },
  PAYOUT_EXCEEDS_SOURCE_EARNINGS: {
    code: 'PAYOUT_EXCEEDS_SOURCE_EARNINGS',
    category: 'settlement',
    summary: 'Completed payouts exceed the earnings derivable from converted source referrals.',
    likelyCauses: [
      'Manual or corrupted ledger credit allowed a payout without backing converted referrals.',
      'Converted referral records were deleted or reverted after settlement completed.',
    ],
    recommendedAction:
      'Hold automatic repair and escalate for human financial audit; never auto-overwrite a ledger below settled payouts.',
    confidence: 'high',
  },
  PERMISSION_REVOCATION_LAG: {
    code: 'PERMISSION_REVOCATION_LAG',
    category: 'permissions',
    summary: 'Search index projection exposes broader visibility or stale permission scope compared to source ACLs.',
    likelyCauses: [
      'Visibility downgrade or permission revocation did not trigger immediate index synchronization.',
      'Incremental index update skipped permission metadata comparison.',
    ],
    recommendedAction:
      'Immediately remove or rescope the indexed entry via dry-run-first repair to prevent unauthorized discovery.',
    confidence: 'high',
  },
  BOUNDED_BUFFER_TRUNCATION: {
    code: 'BOUNDED_BUFFER_TRUNCATION',
    category: 'retention',
    summary: 'Monotonic counter projection exceeds raw event count because the bounded event ring buffer evicted older events.',
    likelyCauses: [
      'Event log reached its maximum retention capacity (e.g. 500 events) while cumulative counters continued incrementing.',
    ],
    recommendedAction:
      'Re-baseline counters to the retained event window if strict window parity is desired, or archive historical counters before truncation.',
    confidence: 'medium',
  },
};

export function getRootCauseHint(code: RootCauseCode): RootCauseHint {
  return ROOT_CAUSE_CATALOG[code];
}

function parseAmount(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function roundCurrency(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export interface DomainReconcilerOutput {
  recordsCompared: number;
  findings: DriftFinding[];
  operations: RepairOperation[];
}

/**
 * 1. Reconciles authoritative affiliate referrals & payouts against derived
 *    `earningsLedger` and cached `walletStats` projections.
 */
export function reconcileAffiliateLedger(
  source: ReconciliationSourceState,
  projection: ReconciliationProjectionState,
  tolerance = 0.01,
): DomainReconcilerOutput {
  const findings: DriftFinding[] = [];
  const operations: RepairOperation[] = [];

  const referralCodes = source.affiliate?.referralCodes ?? [];
  const referrals = source.affiliate?.referrals ?? [];
  const payouts = source.affiliate?.payouts ?? [];
  const earningsLedger = projection.affiliate?.earningsLedger ?? [];
  const walletStats = projection.affiliate?.walletStats ?? {};

  const codeToWallet = new Map<string, string>();
  const walletToCode = new Map<string, string>();
  for (const rc of referralCodes) {
    codeToWallet.set(rc.code, rc.ownerWallet);
    walletToCode.set(rc.ownerWallet, rc.code);
  }

  // Compute authoritative earned XLM per wallet from converted referrals
  const expectedEarnedByWallet = new Map<string, number>();
  for (const rc of referralCodes) {
    if (!expectedEarnedByWallet.has(rc.ownerWallet)) {
      expectedEarnedByWallet.set(rc.ownerWallet, 0);
    }
  }

  for (const ref of referrals) {
    const owner = codeToWallet.get(ref.referralCode);
    if (!owner) continue;
    if (ref.status === 'converted') {
      const prev = expectedEarnedByWallet.get(owner) ?? 0;
      expectedEarnedByWallet.set(owner, roundCurrency(prev + parseAmount(ref.commissionAmount)));
    }
  }

  // Compute authoritative payout totals per wallet
  const reservedByWallet = new Map<string, number>();
  const completedByWallet = new Map<string, number>();
  for (const payout of payouts) {
    const amt = parseAmount(payout.amount);
    if (payout.status !== 'failed') {
      reservedByWallet.set(
        payout.walletAddress,
        roundCurrency((reservedByWallet.get(payout.walletAddress) ?? 0) + amt),
      );
    }
    if (payout.status === 'completed') {
      completedByWallet.set(
        payout.walletAddress,
        roundCurrency((completedByWallet.get(payout.walletAddress) ?? 0) + amt),
      );
    }
  }

  const observedLedgerMap = new Map<string, number>();
  for (const entry of earningsLedger) {
    observedLedgerMap.set(entry.wallet, roundCurrency(parseAmount(entry.earnedXlm)));
  }

  const allWallets = new Set<string>([
    ...expectedEarnedByWallet.keys(),
    ...observedLedgerMap.keys(),
    ...Object.keys(walletStats),
  ]);

  let recordsCompared = 0;

  for (const wallet of Array.from(allWallets).sort()) {
    recordsCompared += 1;
    const hasAuthoritativeCode = walletToCode.has(wallet);
    const expectedEarned = expectedEarnedByWallet.get(wallet) ?? 0;
    const observedEarned = observedLedgerMap.get(wallet);
    const completedPaid = completedByWallet.get(wallet) ?? 0;

    // 1a. Check earningsLedger projection
    if (observedEarned === undefined && (hasAuthoritativeCode && expectedEarned > 0)) {
      const findingId = `drift:affiliate-ledger:earnings:${wallet}:missing`;
      findings.push({
        id: findingId,
        domain: 'affiliate-ledger',
        entityType: 'EarningsLedger',
        entityId: wallet,
        field: 'earnedXlm',
        kind: 'missing_projection',
        severity: 'error',
        expected: expectedEarned,
        observed: null,
        message: `Wallet ${wallet} has ${expectedEarned.toFixed(2)} XLM in converted referrals but is missing from earningsLedger projection.`,
        rootCauseHint: getRootCauseHint('PARTIAL_SIDE_EFFECT_WRITE'),
        repairable: true,
        plannedAction: 'upsert',
      });
      operations.push({
        findingId,
        domain: 'affiliate-ledger',
        entityType: 'EarningsLedger',
        entityId: wallet,
        field: 'earnedXlm',
        action: 'upsert',
        before: null,
        after: { wallet, earnedXlm: expectedEarned },
        rootCauseCode: 'PARTIAL_SIDE_EFFECT_WRITE',
        reason: 'Insert missing earningsLedger entry derived from converted referrals.',
      });
    } else if (observedEarned !== undefined && !hasAuthoritativeCode && expectedEarned === 0) {
      const findingId = `drift:affiliate-ledger:earnings:${wallet}:orphaned`;
      const canAutoDelete = completedPaid === 0;
      const hintCode: RootCauseCode = canAutoDelete
        ? 'UNFLUSHED_DELETION_TOMBSTONE'
        : 'PAYOUT_EXCEEDS_SOURCE_EARNINGS';
      findings.push({
        id: findingId,
        domain: 'affiliate-ledger',
        entityType: 'EarningsLedger',
        entityId: wallet,
        field: 'earnedXlm',
        kind: 'orphaned_projection',
        severity: canAutoDelete ? 'warning' : 'critical',
        expected: null,
        observed: observedEarned,
        message: `Wallet ${wallet} exists in earningsLedger (${observedEarned.toFixed(2)} XLM) but has no registered referral code or converted referrals.`,
        rootCauseHint: getRootCauseHint(hintCode),
        repairable: canAutoDelete,
        plannedAction: canAutoDelete ? 'delete' : 'manual_review',
      });
      if (canAutoDelete) {
        operations.push({
          findingId,
          domain: 'affiliate-ledger',
          entityType: 'EarningsLedger',
          entityId: wallet,
          field: 'earnedXlm',
          action: 'delete',
          before: { wallet, earnedXlm: observedEarned },
          after: null,
          rootCauseCode: hintCode,
          reason: 'Remove orphaned earningsLedger entry with no source referral code.',
        });
      }
    } else if (
      observedEarned !== undefined &&
      Math.abs(observedEarned - expectedEarned) > tolerance
    ) {
      const findingId = `drift:affiliate-ledger:earnings:${wallet}:mismatch`;
      const paidExceedsTrueEarned = completedPaid > expectedEarned + tolerance;
      const rootCauseCode: RootCauseCode = paidExceedsTrueEarned
        ? 'PAYOUT_EXCEEDS_SOURCE_EARNINGS'
        : observedEarned > expectedEarned
          ? 'DUPLICATE_EVENT_REPLAY'
          : 'PARTIAL_SIDE_EFFECT_WRITE';
      const repairable = !paidExceedsTrueEarned;

      findings.push({
        id: findingId,
        domain: 'affiliate-ledger',
        entityType: 'EarningsLedger',
        entityId: wallet,
        field: 'earnedXlm',
        kind: 'value_mismatch',
        severity: paidExceedsTrueEarned ? 'critical' : 'error',
        expected: expectedEarned,
        observed: observedEarned,
        message: `EarningsLedger for ${wallet} drifted: expected ${expectedEarned.toFixed(2)} XLM from converted referrals, observed ${observedEarned.toFixed(2)} XLM.`,
        rootCauseHint: getRootCauseHint(rootCauseCode),
        repairable,
        plannedAction: repairable ? 'recompute' : 'manual_review',
      });

      if (repairable) {
        operations.push({
          findingId,
          domain: 'affiliate-ledger',
          entityType: 'EarningsLedger',
          entityId: wallet,
          field: 'earnedXlm',
          action: 'recompute',
          before: { wallet, earnedXlm: observedEarned },
          after: { wallet, earnedXlm: expectedEarned },
          rootCauseCode,
          reason: 'Recompute earningsLedger balance from authoritative converted referrals.',
        });
      }
    }

    // 1b. Check cached AffiliateStats projection if walletStats projection is tracked
    const observedStats = walletStats[wallet];
    if (observedStats || (projection.affiliate?.walletStats && hasAuthoritativeCode)) {
      const walletCode = walletToCode.get(wallet);
      const walletReferrals = walletCode
        ? referrals.filter((r) => r.referralCode === walletCode)
        : [];
      const convertedCount = walletReferrals.filter((r) => r.status === 'converted').length;
      const activeCount = walletReferrals.filter(
        (r) => r.status === 'active' || r.status === 'converted',
      ).length;
      const reserved = reservedByWallet.get(wallet) ?? 0;
      const expectedPending = Math.max(0, roundCurrency(expectedEarned - reserved));
      const expectedStats: AffiliateStats = {
        totalReferrals: walletReferrals.length,
        activeReferrals: activeCount,
        totalEarnings: expectedEarned.toFixed(2),
        pendingEarnings: expectedPending.toFixed(2),
        totalPayouts: completedPaid.toFixed(2),
        conversionRate:
          walletReferrals.length === 0
            ? 0
            : (convertedCount / walletReferrals.length) * 100,
      };

      if (!observedStats && hasAuthoritativeCode) {
        const findingId = `drift:affiliate-ledger:stats:${wallet}:missing`;
        findings.push({
          id: findingId,
          domain: 'affiliate-ledger',
          entityType: 'AffiliateStats',
          entityId: wallet,
          kind: 'missing_projection',
          severity: 'warning',
          expected: expectedStats,
          observed: null,
          message: `Cached AffiliateStats projection is missing for enrolled wallet ${wallet}.`,
          rootCauseHint: getRootCauseHint('MISSED_DOMAIN_EVENT'),
          repairable: true,
          plannedAction: 'upsert',
        });
        operations.push({
          findingId,
          domain: 'affiliate-ledger',
          entityType: 'AffiliateStats',
          entityId: wallet,
          action: 'upsert',
          before: null,
          after: expectedStats,
          rootCauseCode: 'MISSED_DOMAIN_EVENT',
          reason: 'Populate missing AffiliateStats projection from source ledgers.',
        });
      } else if (observedStats) {
        const payoutDrifted =
          Math.abs(parseAmount(observedStats.pendingEarnings) - expectedPending) > tolerance ||
          Math.abs(parseAmount(observedStats.totalPayouts) - completedPaid) > tolerance;
        const earningsDrifted =
          Math.abs(parseAmount(observedStats.totalEarnings) - expectedEarned) > tolerance;
        const countsDrifted =
          observedStats.totalReferrals !== expectedStats.totalReferrals ||
          observedStats.activeReferrals !== expectedStats.activeReferrals ||
          Math.abs(observedStats.conversionRate - expectedStats.conversionRate) > tolerance;

        if (payoutDrifted || earningsDrifted || countsDrifted) {
          const findingId = `drift:affiliate-ledger:stats:${wallet}:mismatch`;
          const hintCode: RootCauseCode = payoutDrifted
            ? 'PAYOUT_RESERVATION_MISMATCH'
            : earningsDrifted
              ? 'PARTIAL_SIDE_EFFECT_WRITE'
              : 'STALE_CACHE_HYDRATION';

          findings.push({
            id: findingId,
            domain: 'affiliate-ledger',
            entityType: 'AffiliateStats',
            entityId: wallet,
            kind: 'value_mismatch',
            severity: payoutDrifted || earningsDrifted ? 'error' : 'warning',
            expected: expectedStats,
            observed: observedStats,
            message: `Cached AffiliateStats for ${wallet} disagrees with authoritative referrals/payouts ledger.`,
            rootCauseHint: getRootCauseHint(hintCode),
            repairable: true,
            plannedAction: 'recompute',
          });
          operations.push({
            findingId,
            domain: 'affiliate-ledger',
            entityType: 'AffiliateStats',
            entityId: wallet,
            action: 'recompute',
            before: observedStats,
            after: expectedStats,
            rootCauseCode: hintCode,
            reason: 'Recompute AffiliateStats projection from authoritative referrals and payouts.',
          });
        }
      }
    }
  }

  return { recordsCompared, findings, operations };
}

/**
 * 2. Reconciles raw `ReferralLinkEvent` source records against derived
 *    `ReferralClickMetrics` per wallet.
 */
export function reconcileReferralClickMetrics(
  source: ReconciliationSourceState,
  projection: ReconciliationProjectionState,
  tolerance = 0.001,
): DomainReconcilerOutput {
  const findings: DriftFinding[] = [];
  const operations: RepairOperation[] = [];

  const vanitySlugs = source.affiliate?.vanitySlugs ?? [];
  const linkEvents = source.affiliate?.linkEvents ?? [];
  const clickMetricsByWallet = projection.affiliate?.clickMetricsByWallet ?? {};

  const slugsByWallet = new Map<string, Set<string>>();
  for (const slugRecord of vanitySlugs) {
    const set = slugsByWallet.get(slugRecord.ownerWallet) ?? new Set<string>();
    set.add(slugRecord.slug);
    slugsByWallet.set(slugRecord.ownerWallet, set);
  }

  const wallets = new Set<string>([
    ...slugsByWallet.keys(),
    ...Object.keys(clickMetricsByWallet),
  ]);

  let recordsCompared = 0;

  for (const wallet of Array.from(wallets).sort()) {
    recordsCompared += 1;
    const ownedSlugs = slugsByWallet.get(wallet) ?? new Set<string>();
    const walletEvents = linkEvents.filter((ev) => ownedSlugs.has(ev.slug));
    const expectedMetrics = computeReferralClickMetrics(walletEvents);
    const observedMetrics = clickMetricsByWallet[wallet];

    if (!observedMetrics && ownedSlugs.size > 0 && walletEvents.length > 0) {
      const findingId = `drift:referral-click-metrics:${wallet}:missing`;
      findings.push({
        id: findingId,
        domain: 'referral-click-metrics',
        entityType: 'ReferralClickMetrics',
        entityId: wallet,
        kind: 'missing_projection',
        severity: 'warning',
        expected: expectedMetrics,
        observed: null,
        message: `Click metrics projection is missing for wallet ${wallet} (${walletEvents.length} source link events).`,
        rootCauseHint: getRootCauseHint('MISSED_DOMAIN_EVENT'),
        repairable: true,
        plannedAction: 'upsert',
      });
      operations.push({
        findingId,
        domain: 'referral-click-metrics',
        entityType: 'ReferralClickMetrics',
        entityId: wallet,
        action: 'upsert',
        before: null,
        after: expectedMetrics,
        rootCauseCode: 'MISSED_DOMAIN_EVENT',
        reason: 'Compute and store missing ReferralClickMetrics projection from source linkEvents.',
      });
      continue;
    }

    if (observedMetrics && ownedSlugs.size === 0) {
      const findingId = `drift:referral-click-metrics:${wallet}:orphaned`;
      findings.push({
        id: findingId,
        domain: 'referral-click-metrics',
        entityType: 'ReferralClickMetrics',
        entityId: wallet,
        kind: 'orphaned_projection',
        severity: 'warning',
        expected: null,
        observed: observedMetrics,
        message: `Cached ReferralClickMetrics exists for wallet ${wallet}, which owns no registered vanity slugs.`,
        rootCauseHint: getRootCauseHint('UNFLUSHED_DELETION_TOMBSTONE'),
        repairable: true,
        plannedAction: 'delete',
      });
      operations.push({
        findingId,
        domain: 'referral-click-metrics',
        entityType: 'ReferralClickMetrics',
        entityId: wallet,
        action: 'delete',
        before: observedMetrics,
        after: null,
        rootCauseCode: 'UNFLUSHED_DELETION_TOMBSTONE',
        reason: 'Remove orphaned click metrics projection for wallet with no vanity slugs.',
      });
      continue;
    }

    if (observedMetrics) {
      const totalsMismatch =
        observedMetrics.totalImpressions !== expectedMetrics.totalImpressions ||
        observedMetrics.totalClicks !== expectedMetrics.totalClicks ||
        observedMetrics.totalConversions !== expectedMetrics.totalConversions ||
        Math.abs(observedMetrics.clickThroughRate - expectedMetrics.clickThroughRate) > tolerance ||
        Math.abs(observedMetrics.conversionRate - expectedMetrics.conversionRate) > tolerance;

      if (totalsMismatch) {
        const findingId = `drift:referral-click-metrics:${wallet}:mismatch`;
        const isDuplicate =
          observedMetrics.totalClicks > expectedMetrics.totalClicks ||
          observedMetrics.totalImpressions > expectedMetrics.totalImpressions;
        const hintCode: RootCauseCode = isDuplicate
          ? 'DUPLICATE_EVENT_REPLAY'
          : 'STALE_CACHE_HYDRATION';

        findings.push({
          id: findingId,
          domain: 'referral-click-metrics',
          entityType: 'ReferralClickMetrics',
          entityId: wallet,
          kind: 'value_mismatch',
          severity: 'warning',
          expected: {
            totalImpressions: expectedMetrics.totalImpressions,
            totalClicks: expectedMetrics.totalClicks,
            totalConversions: expectedMetrics.totalConversions,
            clickThroughRate: expectedMetrics.clickThroughRate,
            conversionRate: expectedMetrics.conversionRate,
          },
          observed: {
            totalImpressions: observedMetrics.totalImpressions,
            totalClicks: observedMetrics.totalClicks,
            totalConversions: observedMetrics.totalConversions,
            clickThroughRate: observedMetrics.clickThroughRate,
            conversionRate: observedMetrics.conversionRate,
          },
          message: `ReferralClickMetrics projection for ${wallet} drifted from raw link events (expected ${expectedMetrics.totalClicks} clicks / ${expectedMetrics.totalConversions} conversions, observed ${observedMetrics.totalClicks} clicks / ${observedMetrics.totalConversions} conversions).`,
          rootCauseHint: getRootCauseHint(hintCode),
          repairable: true,
          plannedAction: 'recompute',
        });
        operations.push({
          findingId,
          domain: 'referral-click-metrics',
          entityType: 'ReferralClickMetrics',
          entityId: wallet,
          action: 'recompute',
          before: observedMetrics,
          after: expectedMetrics,
          rootCauseCode: hintCode,
          reason: 'Rebuild ReferralClickMetrics projection from authoritative linkEvents.',
        });
      }
    }
  }

  return { recordsCompared, findings, operations };
}

/**
 * 3. Reconciles authoritative records + permissions against cached `IndexedRecord`
 *    search index projections.
 */
export function reconcileSearchIndex(
  source: ReconciliationSourceState,
  projection: ReconciliationProjectionState,
): DomainReconcilerOutput {
  const findings: DriftFinding[] = [];
  const operations: RepairOperation[] = [];

  const sourceRecords = source.searchIndex?.records ?? [];
  const searchableFields = source.searchIndex?.searchableFields ?? ['name', 'description', 'status'];
  const indexedRecords = projection.searchIndex?.indexedRecords ?? [];

  const sourceMap = new Map(sourceRecords.map((item) => [item.record.id, item]));
  const indexedMap = new Map(indexedRecords.map((item) => [item.id, item]));

  const allIds = new Set<string>([...sourceMap.keys(), ...indexedMap.keys()]);
  let recordsCompared = 0;

  for (const id of Array.from(allIds).sort()) {
    recordsCompared += 1;
    const auth = sourceMap.get(id);
    const indexed = indexedMap.get(id);

    // Case A: Record does not exist in source or is marked deleted
    if (!auth || auth.deleted) {
      if (indexed) {
        const findingId = `drift:search-index:${id}:orphaned`;
        findings.push({
          id: findingId,
          domain: 'search-index',
          entityType: 'IndexedRecord',
          entityId: id,
          kind: 'orphaned_projection',
          severity: 'error',
          expected: null,
          observed: { id: indexed.id, visibility: indexed.visibility },
          message: `Deleted or non-existent record '${id}' is still present in the search index projection.`,
          rootCauseHint: getRootCauseHint('UNFLUSHED_DELETION_TOMBSTONE'),
          repairable: true,
          plannedAction: 'delete',
        });
        operations.push({
          findingId,
          domain: 'search-index',
          entityType: 'IndexedRecord',
          entityId: id,
          action: 'delete',
          before: indexed,
          after: null,
          rootCauseCode: 'UNFLUSHED_DELETION_TOMBSTONE',
          reason: 'Remove deleted record from search index projection.',
        });
      }
      continue;
    }

    const shouldBeIndexed = shouldIndexRecord(auth.record, auth.permissions);
    const expectedVisibility = getRecordVisibility(auth.record, auth.permissions);

    // Case B: Hidden record is still present in search index
    if (!shouldBeIndexed && indexed) {
      const findingId = `drift:search-index:${id}:hidden-exposed`;
      findings.push({
        id: findingId,
        domain: 'search-index',
        entityType: 'IndexedRecord',
        entityId: id,
        field: 'visibility',
        kind: 'visibility_mismatch',
        severity: 'critical',
        expected: 'hidden (not indexed)',
        observed: indexed.visibility,
        message: `Hidden record '${id}' is still exposed in the search index with visibility '${indexed.visibility}'.`,
        rootCauseHint: getRootCauseHint('PERMISSION_REVOCATION_LAG'),
        repairable: true,
        plannedAction: 'delete',
      });
      operations.push({
        findingId,
        domain: 'search-index',
        entityType: 'IndexedRecord',
        entityId: id,
        field: 'visibility',
        action: 'delete',
        before: indexed,
        after: null,
        rootCauseCode: 'PERMISSION_REVOCATION_LAG',
        reason: 'Purge hidden record from search index projection.',
      });
      continue;
    }

    // Case C: Indexable record is missing from search index
    if (shouldBeIndexed && !indexed) {
      const findingId = `drift:search-index:${id}:missing`;
      const newEntry = createIndexEntry(auth.record, auth.permissions, {
        indexed_at: auth.updatedAt ?? Date.now(),
      });
      findings.push({
        id: findingId,
        domain: 'search-index',
        entityType: 'IndexedRecord',
        entityId: id,
        kind: 'missing_projection',
        severity: 'error',
        expected: { id, visibility: expectedVisibility },
        observed: null,
        message: `Indexable record '${id}' (visibility: ${expectedVisibility}) is missing from the search index projection.`,
        rootCauseHint: getRootCauseHint('MISSED_DOMAIN_EVENT'),
        repairable: true,
        plannedAction: 'upsert',
      });
      if (newEntry) {
        operations.push({
          findingId,
          domain: 'search-index',
          entityType: 'IndexedRecord',
          entityId: id,
          action: 'upsert',
          before: null,
          after: newEntry,
          rootCauseCode: 'MISSED_DOMAIN_EVENT',
          reason: 'Index missing record with authoritative visibility and permissions.',
        });
      }
      continue;
    }

    // Case D: Both exist — check visibility, permissions, searchable fields, and watermark
    if (shouldBeIndexed && indexed) {
      const scopeMismatch =
        indexed.visibility !== expectedVisibility ||
        JSON.stringify(indexed.visibleTo ?? undefined) !==
          JSON.stringify(auth.permissions.visibleTo ?? undefined) ||
        JSON.stringify(indexed.requiredRoles ?? undefined) !==
          JSON.stringify(auth.permissions.requiredRoles ?? undefined) ||
        (indexed.organizationId ?? undefined) !== (auth.permissions.organizationId ?? undefined);

      if (scopeMismatch) {
        const findingId = `drift:search-index:${id}:permission-scope`;
        const updatedEntry = createIndexEntry(auth.record, auth.permissions, {
          indexed_at: auth.updatedAt ?? indexed.indexed_at,
        });
        findings.push({
          id: findingId,
          domain: 'search-index',
          entityType: 'IndexedRecord',
          entityId: id,
          field: 'permissions',
          kind: 'visibility_mismatch',
          severity: 'critical',
          expected: {
            visibility: expectedVisibility,
            visibleTo: auth.permissions.visibleTo,
            requiredRoles: auth.permissions.requiredRoles,
            organizationId: auth.permissions.organizationId,
          },
          observed: {
            visibility: indexed.visibility,
            visibleTo: indexed.visibleTo,
            requiredRoles: indexed.requiredRoles,
            organizationId: indexed.organizationId,
          },
          message: `Search index entry '${id}' has stale permission scope or visibility.`,
          rootCauseHint: getRootCauseHint('PERMISSION_REVOCATION_LAG'),
          repairable: true,
          plannedAction: 'upsert',
        });
        if (updatedEntry) {
          operations.push({
            findingId,
            domain: 'search-index',
            entityType: 'IndexedRecord',
            entityId: id,
            field: 'permissions',
            action: 'upsert',
            before: indexed,
            after: updatedEntry,
            rootCauseCode: 'PERMISSION_REVOCATION_LAG',
            reason: 'Synchronize search index entry with authoritative permission scope.',
          });
        }
        continue;
      }

      const driftedField = searchableFields.find(
        (field) => JSON.stringify(auth.record[field]) !== JSON.stringify(indexed[field]),
      );
      const watermarkLag =
        typeof auth.updatedAt === 'number' &&
        typeof indexed.indexed_at === 'number' &&
        indexed.indexed_at < auth.updatedAt;

      if (driftedField || watermarkLag) {
        const findingId = `drift:search-index:${id}:${driftedField ? 'field-drift' : 'watermark-lag'}`;
        const updatedEntry = createIndexEntry(auth.record, auth.permissions, {
          indexed_at: auth.updatedAt ?? Date.now(),
        });
        findings.push({
          id: findingId,
          domain: 'search-index',
          entityType: 'IndexedRecord',
          entityId: id,
          field: driftedField ?? 'indexed_at',
          kind: driftedField ? 'value_mismatch' : 'stale_watermark',
          severity: 'warning',
          expected: driftedField ? auth.record[driftedField] : auth.updatedAt,
          observed: driftedField ? indexed[driftedField] : indexed.indexed_at,
          message: driftedField
            ? `Search index entry '${id}' has stale field '${driftedField}'.`
            : `Search index watermark for '${id}' (${indexed.indexed_at}) lags behind source updatedAt (${auth.updatedAt}).`,
          rootCauseHint: getRootCauseHint('STALE_CACHE_HYDRATION'),
          repairable: true,
          plannedAction: 'upsert',
        });
        if (updatedEntry) {
          operations.push({
            findingId,
            domain: 'search-index',
            entityType: 'IndexedRecord',
            entityId: id,
            field: driftedField ?? 'indexed_at',
            action: 'upsert',
            before: indexed,
            after: updatedEntry,
            rootCauseCode: 'STALE_CACHE_HYDRATION',
            reason: 'Refresh stale search index entry from authoritative record.',
          });
        }
      }
    }
  }

  return { recordsCompared, findings, operations };
}

/**
 * 4. Reconciles raw telemetry event buffers (`idempotencyEvents`, `abuseEvents`)
 *    against cached monotonic counter projections (`idempotencyCounters`, `abuseCounters`).
 */
export function reconcileTelemetryCounters(
  source: ReconciliationSourceState,
  projection: ReconciliationProjectionState,
): DomainReconcilerOutput {
  const findings: DriftFinding[] = [];
  const operations: RepairOperation[] = [];
  let recordsCompared = 0;

  const maxBufferSize = source.telemetry?.maxBufferSize ?? 500;

  // 4a. Idempotency telemetry counters
  if (source.telemetry?.idempotencyEvents !== undefined || projection.telemetry?.idempotencyCounters !== undefined) {
    recordsCompared += 1;
    const events = source.telemetry?.idempotencyEvents ?? [];
    const observed = projection.telemetry?.idempotencyCounters;

    const expected: IdempotencyTelemetryCounters = {
      idempotency_requests: events.length,
      idempotency_hits: events.filter((e) => e.kind === 'hit').length,
      idempotency_collisions: events.filter((e) => e.kind === 'collision').length,
      idempotency_retries: events.filter((e) => e.kind === 'retry').length,
      idempotency_expired: events.filter((e) => e.kind === 'expired').length,
    };

    if (!observed && events.length > 0) {
      const findingId = 'drift:telemetry-counters:idempotency:missing';
      findings.push({
        id: findingId,
        domain: 'telemetry-counters',
        entityType: 'IdempotencyTelemetryCounters',
        entityId: 'idempotency',
        kind: 'missing_projection',
        severity: 'warning',
        expected,
        observed: null,
        message: 'Idempotency counter projection is missing despite recorded telemetry events.',
        rootCauseHint: getRootCauseHint('MISSED_DOMAIN_EVENT'),
        repairable: true,
        plannedAction: 'upsert',
      });
      operations.push({
        findingId,
        domain: 'telemetry-counters',
        entityType: 'IdempotencyTelemetryCounters',
        entityId: 'idempotency',
        action: 'upsert',
        before: null,
        after: expected,
        rootCauseCode: 'MISSED_DOMAIN_EVENT',
        reason: 'Initialize idempotency telemetry counters from retained event stream.',
      });
    } else if (observed) {
      const keys = Object.keys(expected) as Array<keyof IdempotencyTelemetryCounters>;
      const hasMismatch = keys.some((k) => observed[k] !== expected[k]);
      if (hasMismatch) {
        const findingId = 'drift:telemetry-counters:idempotency:mismatch';
        const isTruncatedWindow =
          events.length >= maxBufferSize &&
          observed.idempotency_requests > expected.idempotency_requests;
        const isOverCount = observed.idempotency_requests > expected.idempotency_requests;
        const hintCode: RootCauseCode = isTruncatedWindow
          ? 'BOUNDED_BUFFER_TRUNCATION'
          : isOverCount
            ? 'DUPLICATE_EVENT_REPLAY'
            : 'PARTIAL_SIDE_EFFECT_WRITE';

        findings.push({
          id: findingId,
          domain: 'telemetry-counters',
          entityType: 'IdempotencyTelemetryCounters',
          entityId: 'idempotency',
          kind: 'value_mismatch',
          severity: 'warning',
          expected,
          observed,
          message: `Idempotency telemetry counters drifted from event log (expected ${expected.idempotency_requests} requests, observed ${observed.idempotency_requests}).`,
          rootCauseHint: getRootCauseHint(hintCode),
          repairable: true,
          plannedAction: 'recompute',
        });
        operations.push({
          findingId,
          domain: 'telemetry-counters',
          entityType: 'IdempotencyTelemetryCounters',
          entityId: 'idempotency',
          action: 'recompute',
          before: observed,
          after: expected,
          rootCauseCode: hintCode,
          reason: 'Recompute idempotency telemetry counters from authoritative event log.',
        });
      }
    }
  }

  // 4b. Abuse telemetry counters
  if (source.telemetry?.abuseEvents !== undefined || projection.telemetry?.abuseCounters !== undefined) {
    recordsCompared += 1;
    const events = source.telemetry?.abuseEvents ?? [];
    const observed = projection.telemetry?.abuseCounters;

    const expected: AbuseTelemetryCounters = {
      totalEvaluations: events.length,
      lowRiskAllowed: events.filter((e) => e.action === 'allow').length,
      stepUpChallenges: events.filter((e) => e.action === 'step_up').length,
      quarantinedReviews: events.filter((e) => e.action === 'review').length,
      criticalBlocks: events.filter((e) => e.action === 'block').length,
    };

    if (!observed && events.length > 0) {
      const findingId = 'drift:telemetry-counters:abuse:missing';
      findings.push({
        id: findingId,
        domain: 'telemetry-counters',
        entityType: 'AbuseTelemetryCounters',
        entityId: 'abuse',
        kind: 'missing_projection',
        severity: 'warning',
        expected,
        observed: null,
        message: 'Abuse telemetry counter projection is missing despite recorded abuse evaluation events.',
        rootCauseHint: getRootCauseHint('MISSED_DOMAIN_EVENT'),
        repairable: true,
        plannedAction: 'upsert',
      });
      operations.push({
        findingId,
        domain: 'telemetry-counters',
        entityType: 'AbuseTelemetryCounters',
        entityId: 'abuse',
        action: 'upsert',
        before: null,
        after: expected,
        rootCauseCode: 'MISSED_DOMAIN_EVENT',
        reason: 'Initialize abuse telemetry counters from retained event stream.',
      });
    } else if (observed) {
      const keys = Object.keys(expected) as Array<keyof AbuseTelemetryCounters>;
      const hasMismatch = keys.some((k) => observed[k] !== expected[k]);
      if (hasMismatch) {
        const findingId = 'drift:telemetry-counters:abuse:mismatch';
        const isTruncatedWindow =
          events.length >= maxBufferSize &&
          observed.totalEvaluations > expected.totalEvaluations;
        const isOverCount = observed.totalEvaluations > expected.totalEvaluations;
        const hintCode: RootCauseCode = isTruncatedWindow
          ? 'BOUNDED_BUFFER_TRUNCATION'
          : isOverCount
            ? 'DUPLICATE_EVENT_REPLAY'
            : 'PARTIAL_SIDE_EFFECT_WRITE';

        findings.push({
          id: findingId,
          domain: 'telemetry-counters',
          entityType: 'AbuseTelemetryCounters',
          entityId: 'abuse',
          kind: 'value_mismatch',
          severity: 'warning',
          expected,
          observed,
          message: `Abuse telemetry counters drifted from event log (expected ${expected.totalEvaluations} evaluations, observed ${observed.totalEvaluations}).`,
          rootCauseHint: getRootCauseHint(hintCode),
          repairable: true,
          plannedAction: 'recompute',
        });
        operations.push({
          findingId,
          domain: 'telemetry-counters',
          entityType: 'AbuseTelemetryCounters',
          entityId: 'abuse',
          action: 'recompute',
          before: observed,
          after: expected,
          rootCauseCode: hintCode,
          reason: 'Recompute abuse telemetry counters from authoritative event log.',
        });
      }
    }
  }

  return { recordsCompared, findings, operations };
}

/**
 * Applies a single `RepairOperation` onto a mutable `ReconciliationProjectionState` clone.
 * Idempotent by design: applying the same operation twice produces the exact same state.
 */
export function applyOperationToProjection(
  projection: ReconciliationProjectionState,
  op: RepairOperation,
): void {
  switch (op.domain) {
    case 'affiliate-ledger': {
      projection.affiliate = projection.affiliate ?? {};
      if (op.entityType === 'EarningsLedger') {
        const list = [...(projection.affiliate.earningsLedger ?? [])];
        const idx = list.findIndex((item) => item.wallet === op.entityId);
        if (op.action === 'delete') {
          if (idx !== -1) list.splice(idx, 1);
        } else {
          const nextEntry = op.after as { wallet: string; earnedXlm: number };
          if (idx !== -1) list[idx] = { ...nextEntry };
          else list.push({ ...nextEntry });
        }
        projection.affiliate.earningsLedger = list;
      } else if (op.entityType === 'AffiliateStats') {
        const statsMap = { ...(projection.affiliate.walletStats ?? {}) };
        if (op.action === 'delete') {
          delete statsMap[op.entityId];
        } else {
          statsMap[op.entityId] = JSON.parse(JSON.stringify(op.after)) as AffiliateStats;
        }
        projection.affiliate.walletStats = statsMap;
      }
      break;
    }

    case 'referral-click-metrics': {
      projection.affiliate = projection.affiliate ?? {};
      const metricsMap = { ...(projection.affiliate.clickMetricsByWallet ?? {}) };
      if (op.action === 'delete') {
        delete metricsMap[op.entityId];
      } else {
        metricsMap[op.entityId] = JSON.parse(JSON.stringify(op.after));
      }
      projection.affiliate.clickMetricsByWallet = metricsMap;
      break;
    }

    case 'search-index': {
      projection.searchIndex = projection.searchIndex ?? {};
      const list = [...(projection.searchIndex.indexedRecords ?? [])];
      const idx = list.findIndex((item) => item.id === op.entityId);
      if (op.action === 'delete') {
        if (idx !== -1) list.splice(idx, 1);
      } else {
        const nextEntry = JSON.parse(JSON.stringify(op.after));
        if (idx !== -1) list[idx] = nextEntry;
        else list.push(nextEntry);
      }
      projection.searchIndex.indexedRecords = list;
      break;
    }

    case 'telemetry-counters': {
      projection.telemetry = projection.telemetry ?? {};
      if (op.entityType === 'IdempotencyTelemetryCounters') {
        projection.telemetry.idempotencyCounters = JSON.parse(
          JSON.stringify(op.after),
        ) as IdempotencyTelemetryCounters;
      } else if (op.entityType === 'AbuseTelemetryCounters') {
        projection.telemetry.abuseCounters = JSON.parse(
          JSON.stringify(op.after),
        ) as AbuseTelemetryCounters;
      }
      break;
    }
  }
}
