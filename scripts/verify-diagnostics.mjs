#!/usr/bin/env node
/**
 * Executable verification suite for the Trellis Developer Diagnostics Command.
 * Runs via Node's built-in test runner (`node --test scripts/verify-diagnostics.mjs`)
 * with zero external runtime dependencies required.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import {
  checkTooling,
  checkConfiguration,
  checkDependencies,
  checkConnectivity,
  checkDatabaseAndFixtures,
  checkSystemRequirements,
  checkLocalPorts,
  validateEnvRules,
  parseEnvFileContent,
  getCommonFailureFixes,
  applyAutoFixes,
  runDiagnostics,
} from './diagnostics.mjs';

describe('Developer Diagnostics Executable Verification', () => {
  it('validates Node.js runtime and flags unsupported versions (< 20)', () => {
    const valid = checkTooling({ nodeVersion: 'v20.11.0' });
    const nodePass = valid.find((r) => r.name === 'Node.js Runtime');
    assert.equal(nodePass.status, 'pass');

    const invalid = checkTooling({ nodeVersion: 'v18.19.0' });
    const nodeFail = invalid.find((r) => r.name === 'Node.js Runtime');
    assert.equal(nodeFail.status, 'fail');
    assert.ok(nodeFail.remediation.includes('Upgrade Node.js'));
  });

  it('enforces strict AppConfig security rules without leaking secrets', () => {
    const badProd = validateEnvRules({
      NEXT_PUBLIC_ENVIRONMENT: 'production',
      NEXT_PUBLIC_API_URL: 'http://localhost:3001',
      NEXT_PUBLIC_STELLAR_NETWORK: 'testnet',
      WEBHOOK_SECRET: 'placeholder-secret',
    });

    assert.equal(badProd.isValid, false);
    assert.ok(badProd.problems.includes('NEXT_PUBLIC_API_URL must use HTTPS in production.'));
    assert.ok(badProd.problems.includes('NEXT_PUBLIC_API_URL cannot point to localhost outside development.'));
    assert.ok(badProd.problems.includes('NEXT_PUBLIC_STELLAR_NETWORK must be mainnet outside development.'));
    assert.ok(
      badProd.problems.includes('WEBHOOK_SECRET must be a non-placeholder secret of at least 32 characters.')
    );
    assert.equal(JSON.stringify(badProd).includes('placeholder-secret'), false);

    const goodDev = validateEnvRules({
      NEXT_PUBLIC_ENVIRONMENT: 'development',
      NEXT_PUBLIC_API_URL: 'http://localhost:3001',
      NEXT_PUBLIC_STELLAR_NETWORK: 'testnet',
      NEXT_PUBLIC_ENABLE_BETA_FEATURES: 'false',
    });
    assert.equal(goodDev.isValid, true);
  });

  it('validates seed data invariants and domain fixture integrity', async () => {
    const results = await checkDatabaseAndFixtures();
    const seedCheck = results.find((r) => r.name === 'Seed Data & Baseline Invariants');
    assert.ok(seedCheck);
    assert.equal(seedCheck.status, 'pass');

    const fixturesCheck = results.find((r) => r.name === 'Domain Invariant Test Fixtures');
    assert.ok(fixturesCheck);
    assert.equal(fixturesCheck.status, 'pass');
  });

  it('verifies external service connectivity probes and fallback warnings', async () => {
    const skipped = await checkConnectivity(true);
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].status, 'pass');

    const mockedPass = await checkConnectivity(false, {
      probeFn: async () => ({ ok: true, status: 200 }),
    });
    assert.equal(mockedPass.length, 3);
    assert.ok(mockedPass.every((r) => r.status === 'pass'));

    const mockedWarn = await checkConnectivity(false, {
      probeFn: async () => ({ ok: false, error: 'Connection timed out' }),
    });
    assert.equal(mockedWarn.length, 3);
    assert.ok(mockedWarn.every((r) => r.status === 'warn' && Boolean(r.remediation)));
  });

  it('applies safe auto-fixes (--fix) and exposes rollback commands', () => {
    const fixes = getCommonFailureFixes();
    assert.ok(fixes.length >= 6);
    for (const fix of fixes) {
      assert.ok(fix.code);
      assert.ok(fix.fixCommand);
      assert.ok(fix.rollbackCommand);
    }

    const tmpDir = mkdtempSync(join(os.tmpdir(), 'trellis-diag-verify-'));
    try {
      writeFileSync(
        join(tmpDir, '.env.example'),
        'NEXT_PUBLIC_API_URL=http://localhost:3001\nNEXT_PUBLIC_ENVIRONMENT=development\nNEXT_PUBLIC_STELLAR_NETWORK=testnet\n'
      );
      const applied = applyAutoFixes({ rootDir: tmpDir });
      assert.equal(applied.length, 1);
      assert.equal(applied[0].code, 'ENV_MISSING_LOCAL');
      assert.equal(existsSync(join(tmpDir, '.env.local')), true);

      const parsed = parseEnvFileContent('NEXT_PUBLIC_ENVIRONMENT="development"\n');
      assert.equal(parsed.NEXT_PUBLIC_ENVIRONMENT, 'development');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('produces a complete, backward-compatible report via runDiagnostics', async () => {
    const report = await runDiagnostics({ skipNetwork: true });
    assert.ok(report.timestamp);
    assert.equal(typeof report.isSuccess, 'boolean');
    assert.equal(report.groups.length, 7);
    assert.ok(Array.isArray(report.commonFailureFixes));
  });
});
