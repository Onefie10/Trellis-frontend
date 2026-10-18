#!/usr/bin/env node
/**
 * Trellis Frontend: Executable Accessibility Regression Verifier
 *
 * Verifies keyboard, focus recovery, screen-reader semantics, reduced-motion,
 * and error-announcement contracts across dense forms, tables, and error recovery
 * workflows without requiring a browser or external test runner dependencies.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const ROOT = resolve(process.cwd());

function readSource(relPath) {
  const fullPath = resolve(ROOT, relPath);
  assert.ok(existsSync(fullPath), `Expected file to exist: ${relPath}`);
  return readFileSync(fullPath, 'utf8');
}

const checks = [];
function check(name, fn) {
  checks.push({ name, fn });
}

// 1. Reduced-motion hook & global CSS media query
check('Reduced-motion hook (hooks/useReducedMotion.ts) supports matchMedia and legacy listeners', () => {
  const src = readSource('hooks/useReducedMotion.ts');
  assert.match(src, /\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(src, /export function useReducedMotion/);
  assert.match(src, /export function prefersReducedMotion/);
  assert.match(src, /addEventListener\('change'/);
  assert.match(src, /addListener\(/);
});

check('Global stylesheet (app/globals.css) neutralizes animations and transitions under prefers-reduced-motion', () => {
  const css = readSource('app/globals.css');
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(css, /animation-duration:\s*0\.01ms\s*!important/);
  assert.match(css, /transition-duration:\s*0\.01ms\s*!important/);
  assert.match(css, /\.transition-smooth\s*\{\s*transition:\s*none\s*!important;\s*\}/);
});

// 2. Dense Forms: BugReportForm, SorobanFunctionForm, MultisigTransactionBuilder
check('BugReportForm maps all validation keys to real DOM IDs and exposes consolidated live error summary', () => {
  const src = readSource('components/BugReportForm.tsx');
  assert.match(src, /aria-label="Bug report submission form"/);
  assert.match(src, /data-testid="bug-form-error-summary"/);
  assert.match(src, /FIELD_ELEMENT_IDS:\s*Record<string,\s*string>/);

  const expectedMappings = [
    ['title', 'bug-title'],
    ['description', 'bug-description'],
    ['stepsToReproduce', 'bug-steps'],
    ['expectedBehavior', 'bug-expected'],
    ['actualBehavior', 'bug-actual'],
    ['reporterEmail', 'bug-email'],
    ['agreeToTerms', 'agreeToTerms'],
  ];

  for (const [field, domId] of expectedMappings) {
    assert.match(src, new RegExp(`${field}:\\s*'${domId}'`), `Missing FIELD_ELEMENT_IDS mapping for ${field}`);
    assert.match(src, new RegExp(`id="${domId}"`), `Missing DOM element id="${domId}" in BugReportForm`);
  }
});

check('SorobanFunctionForm links per-argument error alerts via aria-describedby and focuses first invalid argument', () => {
  const src = readSource('components/soroban/SorobanFunctionForm.tsx');
  assert.match(src, /aria-required=\{isRequired\}/);
  assert.match(src, /aria-invalid=\{hasError\}/);
  assert.match(src, /aria-describedby=\{hasError\s*\?\s*errorId\s*:\s*undefined\}/);
  assert.match(src, /document\.getElementById\(targetId\)\?\.focus\(\)/);
  assert.match(src, /role="alert"\s+aria-live="assertive"/);
});

check('MultisigTransactionBuilder associates all generator/XDR labels and announces status/errors with live regions', () => {
  const src = readSource('features/governance/components/MultisigTransactionBuilder.tsx');
  for (const id of ['multisig-dest', 'multisig-amount', 'multisig-memo', 'multisig-envelope-xdr']) {
    assert.match(src, new RegExp(`htmlFor="${id}"`), `Missing label htmlFor="${id}"`);
    assert.match(src, new RegExp(`id="${id}"`), `Missing input id="${id}"`);
  }
  assert.match(src, /motion-reduce:transition-none/);
  assert.match(src, /role="alert"[\s\S]*?aria-live="assertive"/);
  assert.match(src, /role="status"[\s\S]*?aria-live="polite"/);
});

// 3. Dense Tables: ReferralTable, SubmissionTable, MetricSeriesTable, VirtualizedTradingTable, PartialFailureDashboard
check('ReferralTable exposes aria-sort on sortable headers, scope="col", and reduced-motion loading state', () => {
  const src = readSource('features/affiliate-dashboard/components/ReferralTable.tsx');
  assert.match(src, /<table\s+aria-label="Referrals"/);
  assert.match(src, /htmlFor="referral-sort-by"/);
  assert.match(src, /htmlFor="referral-filter-status"/);
  assert.match(src, /aria-sort=\{sortBy === 'status'\s*\?\s*'ascending'\s*:\s*'none'\}/);
  assert.match(src, /aria-sort=\{sortBy === 'commission'\s*\?\s*'descending'\s*:\s*'none'\}/);
  assert.match(src, /aria-sort=\{sortBy === 'date'\s*\?\s*'descending'\s*:\s*'none'\}/);
  assert.match(src, /aria-busy="true"/);
  assert.match(src, /motion-reduce:animate-none/);
});

check('SubmissionTable and MetricSeriesTable define named tables and column header scopes', () => {
  const submissionSrc = readSource('features/submissions-dashboard/components/SubmissionTable.tsx');
  assert.match(submissionSrc, /<table\s+aria-label="Submissions"/);
  assert.match(submissionSrc, /<th\s+scope="col"/);
  assert.match(submissionSrc, /role="status"\s+aria-live="polite"/);

  const metricSrc = readSource('components/metrics/MetricSeriesTable.tsx');
  assert.match(metricSrc, /<table\s+aria-label="Metric series"/);
  assert.match(metricSrc, /<th\s+scope="col"/);
});

check('VirtualizedTradingTable exposes ARIA table, row, columnheader, cell roles, and aria-rowcount', () => {
  const src = readSource('components/trading/VirtualizedTradingTable.tsx');
  assert.match(src, /role="table"/);
  assert.match(src, /aria-label="Trading activity"/);
  assert.match(src, /aria-rowcount=\{processedData\.length\s*\+\s*1\}/);
  assert.match(src, /role="columnheader"/);
  assert.match(src, /role="cell"/);
  assert.match(src, /aria-rowindex=\{index\s*\+\s*2\}/);
});

check('PartialFailureDashboard exposes aria-sort on sort buttons and aria-controls/region on expandable rows', () => {
  const src = readSource('features/partial-failure-dashboard/PartialFailureDashboard.tsx');
  assert.match(src, /aria-sort=\{sortField === 'createdAt'/);
  assert.match(src, /aria-sort=\{sortField === 'severity'/);
  assert.match(src, /aria-controls=\{`failure-details-\$\{failure\.id\}`\}/);
  assert.match(src, /id=\{`failure-details-\$\{failure\.id\}`\}/);
  assert.match(src, /role="region"/);
});

// 4. Error Recovery Flows: RouteError, GlobalError, SessionRecovery, ConflictDialog, OfflineBanner
check('RouteError and GlobalError focus the recovery button on mount and announce via assertive alert', () => {
  const routeErr = readSource('app/error.tsx');
  assert.match(routeErr, /retryButtonRef\.current\?\.focus\(\)/);
  assert.match(routeErr, /role="alert"[\s\S]*?aria-live="assertive"/);

  const globalErr = readSource('app/global-error.tsx');
  assert.match(globalErr, /retryButtonRef\.current\?\.focus\(\)/);
  assert.match(globalErr, /role="alert"[\s\S]*?aria-live="assertive"/);
});

check('SessionRecovery and ConflictDialog implement accessible recovery states, modal dialog semantics, and Escape handling', () => {
  const sessionSrc = readSource('features/wallet/components/SessionRecovery.tsx');
  assert.match(sessionSrc, /aria-busy=\{recovering\}/);
  assert.match(sessionSrc, /role=\{message\.includes\("success"\)\s*\?\s*"status"\s*:\s*"alert"\}/);
  assert.match(sessionSrc, /aria-live=\{message\.includes\("success"\)\s*\?\s*"polite"\s*:\s*"assertive"\}/);

  const conflictSrc = readSource('features/session-continuity/components/ConflictDialog.tsx');
  assert.match(conflictSrc, /role="alertdialog"/);
  assert.match(conflictSrc, /aria-modal="true"/);
  assert.match(conflictSrc, /aria-labelledby="conflict-dialog-title"/);
  assert.match(conflictSrc, /aria-describedby="conflict-dialog-description"/);
  assert.match(conflictSrc, /event\.key === "Escape"/);
  assert.match(conflictSrc, /firstButton\?\.focus\(\)/);
});

check('Automated Jest and Playwright regression suites and operational runbook exist', () => {
  const jestSuite = readSource('tests/__tests__/accessibility-regression.test.tsx');
  assert.match(jestSuite, /Accessibility Regression Suite: Dense Forms, Tables, and Error Recovery/);

  const e2eSuite = readSource('e2e/a11y.spec.ts');
  assert.match(e2eSuite, /reducedMotion:\s*'reduce'/);

  const docs = readSource('docs/operations/accessibility-regression-and-recovery.md');
  assert.match(docs, /Operational Edge Cases & Failure Modes/);
  assert.match(docs, /Rollback & Recovery Steps/);
});

let passed = 0;
for (const { name, fn } of checks) {
  try {
    fn();
    passed++;
    console.log(`PASS: ${name}`);
  } catch (err) {
    console.error(`FAIL: ${name}`);
    console.error(err);
    process.exit(1);
  }
}

console.log(`\nAll ${passed}/${checks.length} accessibility regression verification checks passed.`);
