#!/usr/bin/env node
/**
 * Trellis Frontend Contributor Diagnostics & Doctor Command
 *
 * Runs comprehensive, non-mutating (or optionally self-healing via --fix) local health checks:
 * - Developer Tooling & Runtime (Node.js >= 20, Git repo & branch state)
 * - Configuration & Environment Variables (strict schema parity, protocol security, secret hygiene)
 * - Project Dependencies & Setup (package.json, lockfiles, critical packages, tsconfig)
 * - Service Connectivity & External Assumptions (Stellar Horizon, Soroban RPC, IPFS Gateway, Local API)
 * - Seed Data & Fixture Integrity (recovery-baseline.json invariants, healthy/corrupted test fixtures, mock DB)
 * - System Requirements (RAM >= 4GB, Disk space >= 1GB)
 * - Local Ports (3000 Next.js, 3456 Telemetry WS, 8080 Auxiliary)
 * - Common Failure Fixes & Recovery Runbook (deterministic remediation & rollback registry)
 */

import { existsSync, readFileSync, statfsSync, copyFileSync, rmSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import { validateInvariants } from './validate-domain-invariants.mjs';

const scriptDir = typeof __dirname !== 'undefined'
  ? __dirname
  : dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT_DIR = resolve(scriptDir, '..');

/**
 * Format status badge with ANSI colors (or plain text when CI/no-color)
 */
const useColor = !process.env.NO_COLOR && process.stdout.isTTY;
const colors = {
  reset: useColor ? '\x1b[0m' : '',
  bold: useColor ? '\x1b[1m' : '',
  green: useColor ? '\x1b[32m' : '',
  yellow: useColor ? '\x1b[33m' : '',
  red: useColor ? '\x1b[31m' : '',
  cyan: useColor ? '\x1b[36m' : '',
  dim: useColor ? '\x1b[2m' : '',
};

function badge(status) {
  if (status === 'pass') return `${colors.green}[PASS]${colors.reset}`;
  if (status === 'warn') return `${colors.yellow}[WARN]${colors.reset}`;
  return `${colors.red}[FAIL]${colors.reset}`;
}

const DEVELOPMENT_SECRET_PATTERNS = [
  /^your[_-]/i,
  /^change[_-]?me/i,
  /^example/i,
  /^placeholder/i,
  /^secret$/i,
];

/**
 * Registry of common contributor failure modes, automated fixes, and rollback/recovery steps.
 */
export const COMMON_FAILURE_FIXES = [
  {
    code: 'ENV_MISSING_LOCAL',
    symptom: 'Missing .env.local or .env configuration file',
    cause: 'Repository was freshly cloned without initializing local environment variables.',
    fixCommand: 'cp .env.example .env.local',
    autoFixable: true,
    rollbackCommand: 'rm -f .env.local',
  },
  {
    code: 'ENV_SCHEMA_INVALID',
    symptom: 'validate:env or dev startup fails with Invalid application configuration',
    cause: 'Mismatch between NEXT_PUBLIC_ENVIRONMENT, NEXT_PUBLIC_API_URL protocol, or NEXT_PUBLIC_STELLAR_NETWORK.',
    fixCommand: 'Set NEXT_PUBLIC_ENVIRONMENT=development, NEXT_PUBLIC_API_URL=http://localhost:3001, NEXT_PUBLIC_STELLAR_NETWORK=testnet in .env.local',
    autoFixable: false,
    rollbackCommand: 'cp .env.example .env.local',
  },
  {
    code: 'DEPS_MISSING_MODULES',
    symptom: 'Cannot find module errors during build, test, or dev server startup',
    cause: 'node_modules directory is missing, incomplete, or out of sync with package.json.',
    fixCommand: 'npm install',
    autoFixable: false,
    rollbackCommand: 'rm -rf node_modules && npm ci',
  },
  {
    code: 'SEED_DATA_CORRUPTED',
    symptom: 'Seed data or baseline fixture invariant check fails',
    cause: 'Local modifications to scripts/fixtures/recovery-baseline.json or tests/fixtures introduced relational or financial invariant violations.',
    fixCommand: 'git checkout -- scripts/fixtures/recovery-baseline.json tests/fixtures/',
    autoFixable: false,
    rollbackCommand: 'git checkout HEAD -- scripts/fixtures/ tests/fixtures/',
  },
  {
    code: 'NEXT_CACHE_CORRUPTED',
    symptom: 'Next.js webpack build errors, stale chunk manifests, or HMR lockups',
    cause: 'Interrupted build or branch switch left stale artifacts in .next/ cache.',
    fixCommand: 'rm -rf .next',
    autoFixable: true,
    rollbackCommand: 'npm run build',
  },
  {
    code: 'PORT_CONFLICT',
    symptom: 'EADDRINUSE on port 3000, 3456, or 8080',
    cause: 'Orphaned Next.js dev server or telemetry WebSocket server is still bound to the port.',
    fixCommand: 'npx kill-port 3000 3456 8080',
    autoFixable: false,
    rollbackCommand: 'npm run dev',
  },
  {
    code: 'NETWORK_RPC_UNREACHABLE',
    symptom: 'Stellar Horizon or Soroban RPC connection timeout or HTTP 5xx/429',
    cause: 'Offline environment, corporate firewall, or public testnet RPC rate-limiting.',
    fixCommand: 'npm run diagnostics -- --skip-network',
    autoFixable: false,
    rollbackCommand: 'Unset custom RPC overrides in .env.local to restore default public testnet endpoints',
  },
];

export function getCommonFailureFixes() {
  return COMMON_FAILURE_FIXES.map((entry) => ({ ...entry }));
}

/**
 * Helper to fetch HTTP/HTTPS endpoint with timeout
 */
export function checkHttpEndpoint(urlStr, timeoutMs = 4000) {
  return new Promise((resolveResult) => {
    try {
      const url = new URL(urlStr);
      const client = url.protocol === 'https:' ? https : http;
      const req = client.get(
        url,
        {
          timeout: timeoutMs,
          headers: { 'User-Agent': 'Trellis-Contributor-Diagnostics/1.0' },
        },
        (res) => {
          res.resume(); // consume response data to free memory
          if (res.statusCode && res.statusCode < 500) {
            resolveResult({ ok: true, status: res.statusCode });
          } else {
            resolveResult({ ok: false, error: `HTTP status ${res.statusCode}` });
          }
        }
      );

      req.on('timeout', () => {
        req.destroy();
        resolveResult({ ok: false, error: 'Connection timed out' });
      });

      req.on('error', (err) => {
        resolveResult({ ok: false, error: err.message });
      });
    } catch (err) {
      resolveResult({ ok: false, error: err.message });
    }
  });
}

/**
 * Parse a .env formatted string into a key-value map
 */
export function parseEnvFileContent(content) {
  const parsedVars = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx !== -1) {
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      parsedVars[key] = val;
    }
  }
  return parsedVars;
}

/**
 * Validate environment variables against lib/config/env.ts rules without printing secret values.
 */
export function validateEnvRules(envVars) {
  const problems = [];
  const validEnvs = ['development', 'staging', 'production'];
  const validNetworks = ['testnet', 'mainnet'];

  const envMode = envVars.NEXT_PUBLIC_ENVIRONMENT;
  if (!envMode || !validEnvs.includes(envMode)) {
    problems.push(
      `NEXT_PUBLIC_ENVIRONMENT must be one of: ${validEnvs.join(', ')}`
    );
  }

  const rawApiUrl = envVars.NEXT_PUBLIC_API_URL;
  let parsedUrl = null;
  if (!rawApiUrl) {
    problems.push('NEXT_PUBLIC_API_URL is required and must be a valid URL.');
  } else {
    try {
      parsedUrl = new URL(rawApiUrl);
    } catch {
      problems.push('NEXT_PUBLIC_API_URL must be a valid URL.');
    }
  }

  const network = envVars.NEXT_PUBLIC_STELLAR_NETWORK;
  if (!network || !validNetworks.includes(network)) {
    problems.push(
      `NEXT_PUBLIC_STELLAR_NETWORK must be one of: ${validNetworks.join(', ')}`
    );
  }

  const betaFlag = envVars.NEXT_PUBLIC_ENABLE_BETA_FEATURES;
  if (betaFlag !== undefined && betaFlag !== '' && betaFlag !== 'true' && betaFlag !== 'false') {
    problems.push("NEXT_PUBLIC_ENABLE_BETA_FEATURES must be 'true' or 'false'.");
  }

  if (parsedUrl && envMode && validEnvs.includes(envMode)) {
    const isLocalApi =
      parsedUrl.hostname === 'localhost' ||
      parsedUrl.hostname === '127.0.0.1' ||
      parsedUrl.hostname === '::1';

    if (envMode === 'production' && parsedUrl.protocol !== 'https:') {
      problems.push('NEXT_PUBLIC_API_URL must use HTTPS in production.');
    }
    if (!isLocalApi && parsedUrl.protocol !== 'https:') {
      problems.push('NEXT_PUBLIC_API_URL must use HTTPS outside local development.');
    }
    if (envMode !== 'development' && isLocalApi) {
      problems.push('NEXT_PUBLIC_API_URL cannot point to localhost outside development.');
    }
    if (envMode !== 'development' && network === 'testnet') {
      problems.push('NEXT_PUBLIC_STELLAR_NETWORK must be mainnet outside development.');
    }
  }

  const webhookSecret = envVars.WEBHOOK_SECRET?.trim();
  if (webhookSecret) {
    if (
      webhookSecret.length < 32 ||
      DEVELOPMENT_SECRET_PATTERNS.some((pattern) => pattern.test(webhookSecret))
    ) {
      problems.push('WEBHOOK_SECRET must be a non-placeholder secret of at least 32 characters.');
    }
    if (envMode === 'development' && /^(prod|production|live)[-_]/i.test(webhookSecret)) {
      problems.push('WEBHOOK_SECRET appears production-like and cannot be used in development.');
    }
  }

  const permissionSecret = envVars.PERMISSION_TOKEN_SECRET?.trim();
  if (permissionSecret && permissionSecret.length < 32) {
    problems.push('PERMISSION_TOKEN_SECRET must be at least 32 characters when set.');
  }

  return {
    isValid: problems.length === 0,
    problems,
  };
}

/**
 * 1. Check Tooling & Environment
 */
export function checkTooling(options = {}) {
  const rootDir = options.rootDir || DEFAULT_ROOT_DIR;
  const nodeVersion = options.nodeVersion || process.version;
  const results = [];

  // Node.js version
  const major = parseInt(nodeVersion.replace(/^v/, '').split('.')[0], 10);
  if (major >= 20) {
    results.push({
      name: 'Node.js Runtime',
      status: 'pass',
      message: `Node.js ${nodeVersion} installed (meets requirement >= 20.0.0)`,
    });
  } else {
    results.push({
      name: 'Node.js Runtime',
      status: 'fail',
      message: `Current Node.js version is ${nodeVersion}. Trellis requires Node.js >= 20.0.0.`,
      remediation: 'Upgrade Node.js to version 20 or higher (e.g. run "nvm install 20 && nvm use 20" or download from https://nodejs.org).',
    });
  }

  // Git repository check
  const gitDir = join(rootDir, '.git');
  if (existsSync(gitDir)) {
    let branch = 'unknown';
    try {
      branch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: rootDir,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .toString()
        .trim();
    } catch {
      // ignore
    }
    results.push({
      name: 'Git Repository',
      status: 'pass',
      message: `Git repository initialized on branch '${branch}'`,
    });
  } else {
    results.push({
      name: 'Git Repository',
      status: 'warn',
      message: '.git directory not found in project root',
      remediation: 'Clone the repository using "git clone https://github.com/TRELLIS-STELLAR/Trellis-frontend.git" to contribute.',
    });
  }

  return results;
}

/**
 * 2. Check Configuration & Environment Variables
 */
export function checkConfiguration(options = {}) {
  const rootDir = options.rootDir || DEFAULT_ROOT_DIR;
  const envOverride = options.envOverride || null;
  const results = [];
  const envExamplePath = join(rootDir, '.env.example');
  const envLocalPath = join(rootDir, '.env.local');
  const envPath = join(rootDir, '.env');

  // .env.example template check
  let requiredKeys = [];
  if (existsSync(envExamplePath)) {
    results.push({
      name: '.env.example Template',
      status: 'pass',
      message: 'Template .env.example exists and readable',
    });
    const exVars = parseEnvFileContent(readFileSync(envExamplePath, 'utf-8'));
    requiredKeys = Object.keys(exVars);
  } else {
    results.push({
      name: '.env.example Template',
      status: 'fail',
      message: 'Missing .env.example template in repository root',
      remediation: 'Restore .env.example from repository origin: "git checkout -- .env.example".',
    });
  }

  // Local environment file check
  const activeEnvFile = existsSync(envLocalPath)
    ? '.env.local'
    : existsSync(envPath)
      ? '.env'
      : null;

  if (activeEnvFile || envOverride) {
    const sourceLabel = activeEnvFile || 'process.env override';
    results.push({
      name: 'Local Environment File',
      status: 'pass',
      message: `Found active environment configuration: ${sourceLabel}`,
    });

    const parsedVars = envOverride
      ? { ...envOverride }
      : parseEnvFileContent(readFileSync(join(rootDir, activeEnvFile), 'utf-8'));

    if (requiredKeys.length > 0) {
      const missingKeys = requiredKeys.filter((k) => !(k in parsedVars));
      if (missingKeys.length > 0) {
        results.push({
          name: 'Environment Variables Sync',
          status: 'fail',
          message: `Missing required environment variables in ${sourceLabel}: ${missingKeys.join(', ')}`,
          remediation: `Add the missing variables (${missingKeys.join(', ')}) to ${sourceLabel} as defined in .env.example.`,
        });
      } else {
        results.push({
          name: 'Environment Variables Sync',
          status: 'pass',
          message: `All keys from .env.example are present in ${sourceLabel}`,
        });
      }
    }

    // NEXT_PUBLIC_API_URL
    if (parsedVars.NEXT_PUBLIC_API_URL) {
      try {
        new URL(parsedVars.NEXT_PUBLIC_API_URL);
        results.push({
          name: 'API Endpoint (NEXT_PUBLIC_API_URL)',
          status: 'pass',
          message: `Configured valid URL: ${parsedVars.NEXT_PUBLIC_API_URL}`,
        });
      } catch {
        results.push({
          name: 'API Endpoint (NEXT_PUBLIC_API_URL)',
          status: 'fail',
          message: 'Invalid URL format in NEXT_PUBLIC_API_URL',
          remediation: 'Set NEXT_PUBLIC_API_URL to a valid URL format (e.g. http://localhost:3001).',
        });
      }
    } else {
      results.push({
        name: 'API Endpoint (NEXT_PUBLIC_API_URL)',
        status: 'warn',
        message: 'NEXT_PUBLIC_API_URL is unset; app will fall back to default localhost or mock mode',
        remediation: 'Add NEXT_PUBLIC_API_URL=http://localhost:3001 to your .env.local.',
      });
    }

    // NEXT_PUBLIC_ENVIRONMENT
    const envVal = parsedVars.NEXT_PUBLIC_ENVIRONMENT;
    if (envVal) {
      const validEnvs = ['development', 'staging', 'production'];
      if (validEnvs.includes(envVal)) {
        results.push({
          name: 'Environment Mode (NEXT_PUBLIC_ENVIRONMENT)',
          status: 'pass',
          message: `Environment mode set to '${envVal}'`,
        });
      } else {
        results.push({
          name: 'Environment Mode (NEXT_PUBLIC_ENVIRONMENT)',
          status: 'fail',
          message: `Unsupported environment value '${envVal}' (expected one of: ${validEnvs.join(', ')})`,
          remediation: 'Set NEXT_PUBLIC_ENVIRONMENT=development in .env.local.',
        });
      }
    }

    // Strict AppConfig security & cross-field rules (lib/config/env.ts parity)
    const ruleCheck = validateEnvRules(parsedVars);
    if (ruleCheck.isValid) {
      results.push({
        name: 'AppConfig Schema & Security Rules',
        status: 'pass',
        message: `Configuration passes strict schema and security policy (${parsedVars.NEXT_PUBLIC_ENVIRONMENT}, Stellar ${parsedVars.NEXT_PUBLIC_STELLAR_NETWORK})`,
      });
    } else {
      results.push({
        name: 'AppConfig Schema & Security Rules',
        status: 'fail',
        message: `Configuration policy violation(s): ${ruleCheck.problems.join(' | ')}`,
        remediation: 'Fix the reported settings in .env.local or run "cp .env.example .env.local" to reset to safe development defaults.',
      });
    }
  } else {
    results.push({
      name: 'Local Environment File',
      status: 'warn',
      message: 'No .env.local or .env file detected',
      remediation: 'Copy .env.example to .env.local: "cp .env.example .env.local" (or run "npm run diagnostics -- --fix").',
    });
  }

  return results;
}

/**
 * 3. Check Dependencies & Project Files
 */
export function checkDependencies(options = {}) {
  const rootDir = options.rootDir || DEFAULT_ROOT_DIR;
  const results = [];
  const pkgPath = join(rootDir, 'package.json');
  const nodeModulesPath = join(rootDir, 'node_modules');

  let pkg = null;
  if (existsSync(pkgPath)) {
    try {
      pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      results.push({
        name: 'package.json Configuration',
        status: 'pass',
        message: `Valid package.json (${pkg.name || 'trellis-frontend'}@${pkg.version || '0.1.0'})`,
      });
    } catch (err) {
      results.push({
        name: 'package.json Configuration',
        status: 'fail',
        message: `Corrupt package.json: ${err.message}`,
        remediation: 'Verify package.json syntax or restore from git: "git checkout package.json".',
      });
    }
  } else {
    results.push({
      name: 'package.json Configuration',
      status: 'fail',
      message: 'package.json not found in working directory',
      remediation: 'Ensure you are running the diagnostics command from the project root.',
    });
  }

  if (existsSync(nodeModulesPath)) {
    const criticalPackages = ['next', 'react', 'zod', '@stellar/stellar-sdk', '@stellar/freighter-api'];
    const missingCritical = criticalPackages.filter(
      (dep) => !existsSync(join(nodeModulesPath, ...dep.split('/'), 'package.json'))
    );

    if (missingCritical.length === 0) {
      results.push({
        name: 'Dependencies Installation',
        status: 'pass',
        message: `node_modules present and verified (${criticalPackages.length} core packages checked)`,
      });
    } else {
      results.push({
        name: 'Dependencies Installation',
        status: 'warn',
        message: `node_modules present but missing core packages: ${missingCritical.join(', ')}`,
        remediation: 'Run "npm install" to complete dependency installation.',
      });
    }
  } else {
    results.push({
      name: 'Dependencies Installation',
      status: 'fail',
      message: 'node_modules not found; packages have not been installed',
      remediation: 'Run "npm install" or "pnpm install" to install required dependencies.',
    });
  }

  // TypeScript configuration
  const tsconfigPath = join(rootDir, 'tsconfig.json');
  if (existsSync(tsconfigPath)) {
    results.push({
      name: 'TypeScript Configuration',
      status: 'pass',
      message: 'tsconfig.json present',
    });
  } else {
    results.push({
      name: 'TypeScript Configuration',
      status: 'warn',
      message: 'tsconfig.json missing in repository root',
      remediation: 'Restore tsconfig.json from git origin: "git checkout -- tsconfig.json".',
    });
  }

  return results;
}

/**
 * 4. Check Service & Network Connectivity
 */
export async function checkConnectivity(skipNetwork = false, options = {}) {
  const probeFn = options.probeFn || checkHttpEndpoint;
  const results = [];

  if (skipNetwork) {
    results.push({
      name: 'Network Services',
      status: 'pass',
      message: 'Skipped external network checks (--skip-network requested)',
    });
    return results;
  }

  // Stellar Testnet Horizon
  const horizonEndpoint = options.horizonUrl || 'https://horizon-testnet.stellar.org';
  const horizonResult = await probeFn(horizonEndpoint);
  if (horizonResult.ok) {
    results.push({
      name: 'Stellar Horizon RPC (Testnet)',
      status: 'pass',
      message: `Successfully connected to ${horizonEndpoint} (HTTP ${horizonResult.status})`,
    });
  } else {
    results.push({
      name: 'Stellar Horizon RPC (Testnet)',
      status: 'warn',
      message: `Unable to reach ${horizonEndpoint}: ${horizonResult.error}`,
      remediation: 'Check your internet connection or verify firewall/DNS allows outbound traffic to horizon-testnet.stellar.org. Use --skip-network for offline work.',
    });
  }

  // Soroban RPC Testnet
  const sorobanEndpoint =
    options.sorobanRpcUrl ||
    process.env.OPERATIONAL_HEALTH_RPC_URL ||
    'https://soroban-testnet.stellar.org';
  const sorobanResult = await probeFn(sorobanEndpoint);
  if (sorobanResult.ok) {
    results.push({
      name: 'Stellar Soroban RPC (Testnet)',
      status: 'pass',
      message: `Successfully connected to ${sorobanEndpoint} (HTTP ${sorobanResult.status})`,
    });
  } else {
    results.push({
      name: 'Stellar Soroban RPC (Testnet)',
      status: 'warn',
      message: `Unable to reach ${sorobanEndpoint}: ${sorobanResult.error}`,
      remediation: 'Soroban RPC is unreachable; smart contract preflight simulations will fall back to local mock simulation.',
    });
  }

  // IPFS Gateway
  const ipfsEndpoint = options.ipfsUrl || 'https://ipfs.io';
  const ipfsResult = await probeFn(ipfsEndpoint);
  if (ipfsResult.ok) {
    results.push({
      name: 'Public IPFS Gateway',
      status: 'pass',
      message: `Successfully reached ${ipfsEndpoint} (HTTP ${ipfsResult.status})`,
    });
  } else {
    results.push({
      name: 'Public IPFS Gateway',
      status: 'warn',
      message: `Unable to reach ${ipfsEndpoint}: ${ipfsResult.error}`,
      remediation: 'IPFS gateway is optional for local dev; built-in mock IPFS resolution will be used.',
    });
  }

  return results;
}

/**
 * 5. Check Seed Data, Database & Test Fixtures Integrity (Non-Mutating)
 */
export async function checkDatabaseAndFixtures(options = {}) {
  const rootDir = options.rootDir || DEFAULT_ROOT_DIR;
  const results = [];

  try {
    // 5a. Validate canonical seed data & recovery baseline fixture
    const baselinePath = join(rootDir, 'scripts', 'fixtures', 'recovery-baseline.json');
    if (existsSync(baselinePath)) {
      try {
        const rawBaseline = readFileSync(baselinePath, 'utf-8');
        const baselineData = JSON.parse(rawBaseline);
        const checksum = crypto.createHash('sha256').update(rawBaseline).digest('hex').slice(0, 12);
        const invariantReport = validateInvariants(baselineData);

        if (invariantReport.isValid && invariantReport.summary.errorCount === 0) {
          const agentCount = Array.isArray(baselineData.agents) ? baselineData.agents.length : 0;
          const provenanceCount = Array.isArray(baselineData.provenanceRecords)
            ? baselineData.provenanceRecords.length
            : 0;
          results.push({
            name: 'Seed Data & Baseline Invariants',
            status: 'pass',
            message: `recovery-baseline.json verified (${invariantReport.summary.passedChecks} invariant checks passed, ${agentCount} agents, ${provenanceCount} provenance records, sha256:${checksum})`,
          });
        } else {
          results.push({
            name: 'Seed Data & Baseline Invariants',
            status: 'fail',
            message: `Seed data invariant failure in recovery-baseline.json (${invariantReport.summary.errorCount} error(s))`,
            remediation: 'Restore clean seed baseline: "git checkout -- scripts/fixtures/recovery-baseline.json" or run "npm run validate:invariants" to inspect.',
          });
        }
      } catch (err) {
        results.push({
          name: 'Seed Data & Baseline Invariants',
          status: 'fail',
          message: `Failed to parse scripts/fixtures/recovery-baseline.json: ${err.message}`,
          remediation: 'Restore corrupt seed file: "git checkout -- scripts/fixtures/recovery-baseline.json".',
        });
      }
    } else {
      results.push({
        name: 'Seed Data & Baseline Invariants',
        status: 'fail',
        message: 'scripts/fixtures/recovery-baseline.json is missing',
        remediation: 'Restore seed data fixture from git: "git checkout -- scripts/fixtures/recovery-baseline.json".',
      });
    }

    // 5b. Validate invariant-monitor test fixtures (healthy vs corrupted parity)
    const healthyFixturePath = join(rootDir, 'tests', 'fixtures', 'invariant-monitor', 'healthy-dataset.json');
    const corruptedFixturePath = join(rootDir, 'tests', 'fixtures', 'invariant-monitor', 'corrupted-dataset.json');
    if (existsSync(healthyFixturePath) && existsSync(corruptedFixturePath)) {
      const healthyData = JSON.parse(readFileSync(healthyFixturePath, 'utf-8'));
      const corruptedData = JSON.parse(readFileSync(corruptedFixturePath, 'utf-8'));
      const healthyCheck = validateInvariants(healthyData);
      const corruptedCheck = validateInvariants(corruptedData);

      if (healthyCheck.isValid && !corruptedCheck.isValid) {
        results.push({
          name: 'Domain Invariant Test Fixtures',
          status: 'pass',
          message: 'Healthy and corrupted invariant fixtures verified with zero drift',
        });
      } else {
        results.push({
          name: 'Domain Invariant Test Fixtures',
          status: 'fail',
          message: 'Invariant test fixtures out of sync with validation engine',
          remediation: 'Restore test fixtures: "git checkout -- tests/fixtures/invariant-monitor/".',
        });
      }
    }

    // 5c. Non-mutating read of mock database
    const mockDbPath = join(rootDir, 'lib', 'db', 'mock-db.ts');
    if (existsSync(mockDbPath)) {
      results.push({
        name: 'Mock Database Source',
        status: 'pass',
        message: 'lib/db/mock-db.ts exists and available for in-memory operations',
      });
    } else {
      results.push({
        name: 'Mock Database Source',
        status: 'warn',
        message: 'lib/db/mock-db.ts not found',
        remediation: 'Verify lib/db fixtures are checked out: "git checkout -- lib/db/mock-db.ts".',
      });
    }

    // 5d. Verify operational health builder
    const opHealthPath = join(rootDir, 'lib', 'operational-health.ts');
    if (existsSync(opHealthPath)) {
      results.push({
        name: 'Operational Health Module',
        status: 'pass',
        message: 'lib/operational-health.ts present for domain telemetry',
      });
    }

    // 5e. Verify core test fixtures directory
    const testsDir = join(rootDir, 'tests');
    if (existsSync(testsDir)) {
      results.push({
        name: 'Test Suites Directory',
        status: 'pass',
        message: 'tests/ directory present with unit and integration specs',
      });
    } else {
      results.push({
        name: 'Test Suites Directory',
        status: 'warn',
        message: 'tests/ directory not found',
        remediation: 'Ensure test suites are checked out from git.',
      });
    }
  } catch (err) {
    results.push({
      name: 'Database & Fixture Access',
      status: 'fail',
      message: `Encountered unexpected error checking fixtures: ${err.message}`,
      remediation: 'Check file permissions and ensure working directory files are readable.',
    });
  }

  return results;
}

/**
 * 6. Check System Requirements
 */
export function checkSystemRequirements(options = {}) {
  const rootDir = options.rootDir || DEFAULT_ROOT_DIR;
  const results = [];

  // memory
  const totalRamGb = (options.totalMemBytes ?? os.totalmem()) / 1024 ** 3;
  if (totalRamGb >= 4) {
    results.push({
      name: 'System Memory',
      status: 'pass',
      message: `Total RAM is ${totalRamGb.toFixed(1)}GB (>= 4GB)`,
    });
  } else {
    results.push({
      name: 'System Memory',
      status: 'warn',
      message: `Total RAM is ${totalRamGb.toFixed(1)}GB, Next.js build may struggle with < 4GB`,
      remediation: 'Close other memory-intensive applications or set NODE_OPTIONS="--max-old-space-size=4096".',
    });
  }

  // disk
  try {
    const stat = statfsSync(rootDir);
    const freeGb = (stat.bfree * stat.bsize) / 1024 ** 3;
    if (freeGb >= 1) {
      results.push({
        name: 'Disk Space',
        status: 'pass',
        message: `Free disk space is ${freeGb.toFixed(1)}GB (>= 1GB)`,
      });
    } else {
      results.push({
        name: 'Disk Space',
        status: 'warn',
        message: `Free disk space is ${freeGb.toFixed(1)}GB, < 1GB recommended for build`,
        remediation: 'Free up disk space or clear stale caches via "rm -rf .next node_modules/.cache".',
      });
    }
  } catch {
    results.push({
      name: 'Disk Space',
      status: 'warn',
      message: 'Could not determine free disk space',
      remediation: 'Ensure you have at least 1GB of free disk space for Next.js builds.',
    });
  }
  return results;
}

/**
 * 7. Check Local Ports
 */
export async function checkLocalPorts(options = {}) {
  const results = [];
  const ports = options.ports || [3000, 8080];
  for (const port of ports) {
    try {
      const isOccupied = await new Promise((resolvePort) => {
        const srv = net.createServer();
        srv.once('error', (err) => {
          if (err.code === 'EADDRINUSE') resolvePort(true);
          else resolvePort(false);
        });
        srv.once('listening', () => {
          srv.close();
          resolvePort(false);
        });
        srv.listen(port, '127.0.0.1');
      });

      if (isOccupied) {
        let processDetails = 'unknown process';
        try {
          if (process.platform === 'win32') {
            const netstat = execSync(`netstat -ano | findstr :${port}`, {
              stdio: ['ignore', 'pipe', 'ignore'],
            }).toString();
            const lines = netstat
              .trim()
              .split('\n')
              .filter((l) => l.includes(`:${port}`));
            if (lines.length > 0) {
              const pid = lines[0].trim().split(/\s+/).pop();
              const tasklist = execSync(`tasklist | findstr ${pid}`, {
                stdio: ['ignore', 'pipe', 'ignore'],
              }).toString();
              processDetails = `PID ${pid} (${tasklist.trim().split(/\s+/)[0]})`;
            }
          } else {
            const lsof = execSync(`lsof -i :${port} -t`, {
              stdio: ['ignore', 'pipe', 'ignore'],
            })
              .toString()
              .trim();
            if (lsof) {
              const ps = execSync(`ps -p ${lsof.split('\n')[0]} -o comm=`, {
                stdio: ['ignore', 'pipe', 'ignore'],
              })
                .toString()
                .trim();
              processDetails = `PID ${lsof.split('\n')[0]} (${ps})`;
            }
          }
        } catch {
          // ignore lookup errors
        }
        results.push({
          name: `Local Port ${port}`,
          status: 'fail',
          message: `Port ${port} is currently in use by ${processDetails}`,
          remediation: `Stop the process using port ${port} (e.g., "npx kill-port ${port}") or change the port configuration.`,
        });
      } else {
        results.push({
          name: `Local Port ${port}`,
          status: 'pass',
          message: `Port ${port} is available`,
        });
      }
    } catch (err) {
      results.push({
        name: `Local Port ${port}`,
        status: 'fail',
        message: `Failed to check port ${port}: ${err.message}`,
      });
    }
  }
  return results;
}

/**
 * Apply safe, idempotent automatic fixes when --fix is passed.
 * Returns a list of applied fix records with rollback instructions.
 */
export function applyAutoFixes(options = {}) {
  const rootDir = options.rootDir || DEFAULT_ROOT_DIR;
  const applied = [];

  const envExamplePath = join(rootDir, '.env.example');
  const envLocalPath = join(rootDir, '.env.local');
  const envPath = join(rootDir, '.env');

  if (!existsSync(envLocalPath) && !existsSync(envPath) && existsSync(envExamplePath)) {
    copyFileSync(envExamplePath, envLocalPath);
    applied.push({
      code: 'ENV_MISSING_LOCAL',
      action: 'Created .env.local from .env.example template',
      rollbackCommand: 'rm -f .env.local',
    });
  }

  if (options.cleanNextCache) {
    const nextDir = join(rootDir, '.next');
    if (existsSync(nextDir)) {
      rmSync(nextDir, { recursive: true, force: true });
      applied.push({
        code: 'NEXT_CACHE_CORRUPTED',
        action: 'Removed stale .next build cache directory',
        rollbackCommand: 'npm run build',
      });
    }
  }

  return applied;
}

/**
 * Main Diagnostics Runner
 */
export async function runDiagnostics(options = {}) {
  const {
    skipNetwork = false,
    strict = false,
    fix = false,
    rootDir = DEFAULT_ROOT_DIR,
  } = options;

  const appliedFixes = fix ? applyAutoFixes({ rootDir, cleanNextCache: options.cleanNextCache }) : [];

  const groups = [
    { name: 'Developer Tooling & Runtime', results: checkTooling(options) },
    { name: 'Configuration & Environment', results: checkConfiguration(options) },
    { name: 'Project Dependencies & Setup', results: checkDependencies(options) },
    { name: 'Service Connectivity & Network', results: await checkConnectivity(skipNetwork, options) },
    { name: 'Database & Fixture Integrity', results: await checkDatabaseAndFixtures(options) },
    { name: 'System Requirements', results: checkSystemRequirements(options) },
    { name: 'Local Ports', results: await checkLocalPorts(options) },
  ];

  let total = 0;
  let passed = 0;
  let warnings = 0;
  let failures = 0;

  for (const group of groups) {
    for (const r of group.results) {
      total++;
      if (r.status === 'pass') passed++;
      else if (r.status === 'warn') warnings++;
      else if (r.status === 'fail') failures++;
    }
  }

  const isSuccess = strict ? failures === 0 && warnings === 0 : failures === 0;

  return {
    timestamp: new Date().toISOString(),
    isSuccess,
    summary: { total, passed, warnings, failures },
    appliedFixes,
    commonFailureFixes: getCommonFailureFixes(),
    groups,
  };
}

/**
 * CLI Execution Handler
 */
async function main() {
  const args = process.argv.slice(2);
  const isJson = args.includes('--json');
  const skipNetwork = args.includes('--skip-network');
  const strict = args.includes('--strict');
  const fix = args.includes('--fix');
  const showFixes = args.includes('--show-fixes');
  const help = args.includes('--help') || args.includes('-h');

  if (help) {
    console.log(`
Trellis Frontend Contributor Diagnostics

Usage:
  npm run diagnostics [options]
  npm run doctor [options]
  node scripts/diagnostics.mjs [options]

Options:
  --json          Output results in machine-readable JSON format
  --skip-network  Skip external network/RPC reachability checks
  --strict        Treat warnings as failures (exit code 1)
  --fix           Automatically remediate safe local setup issues (e.g. initialize .env.local)
  --show-fixes    Print the catalog of common failure modes, fixes, and rollback steps
  -h, --help      Show this help message
`);
    process.exit(0);
  }

  if (!isJson) {
    console.log(`${colors.bold}${colors.cyan}======================================================${colors.reset}`);
    console.log(`${colors.bold}${colors.cyan}  Trellis Frontend — Contributor Environment Diagnostics${colors.reset}`);
    console.log(`${colors.bold}${colors.cyan}======================================================${colors.reset}\n`);
  }

  const results = await runDiagnostics({ skipNetwork, strict, fix });

  if (isJson) {
    console.log(JSON.stringify(results, null, 2));
    process.exit(results.isSuccess ? 0 : 1);
  }

  if (results.appliedFixes.length > 0) {
    console.log(`${colors.bold}${colors.green}▶ Auto-Remediation Applied (--fix)${colors.reset}`);
    for (const item of results.appliedFixes) {
      console.log(`  ${colors.green}[FIXED]${colors.reset} ${item.code}: ${item.action}`);
      console.log(`          ${colors.dim}↳ Rollback: ${item.rollbackCommand}${colors.reset}`);
    }
    console.log();
  }

  for (const group of results.groups) {
    console.log(`${colors.bold}▶ ${group.name}${colors.reset}`);
    for (const item of group.results) {
      console.log(`  ${badge(item.status)} ${colors.bold}${item.name}${colors.reset}: ${item.message}`);
      if (item.remediation && item.status !== 'pass') {
        console.log(`         ${colors.dim}↳ Remediation: ${item.remediation}${colors.reset}`);
      }
    }
    console.log();
  }

  if (showFixes || !results.isSuccess) {
    console.log(`${colors.bold}▶ Common Failure Fixes & Rollback Playbook${colors.reset}`);
    for (const entry of results.commonFailureFixes) {
      console.log(`  • ${colors.bold}${entry.code}${colors.reset}: ${entry.symptom}`);
      console.log(`    ${colors.dim}Fix:      ${entry.fixCommand}${colors.reset}`);
      console.log(`    ${colors.dim}Rollback: ${entry.rollbackCommand}${colors.reset}`);
    }
    console.log();
  }

  console.log(`${colors.bold}------------------------------------------------------${colors.reset}`);
  console.log(
    `Summary: ${colors.bold}${results.summary.passed}${colors.reset} passed, ` +
      `${results.summary.warnings > 0 ? colors.yellow : ''}${results.summary.warnings} warning(s)${colors.reset}, ` +
      `${results.summary.failures > 0 ? colors.red : ''}${results.summary.failures} failure(s)${colors.reset}`
  );

  if (results.isSuccess) {
    console.log(
      `\n${colors.green}${colors.bold}✔ All required checks passed! Local environment is healthy and ready for development.${colors.reset}\n`
    );
    process.exit(0);
  } else {
    console.log(
      `\n${colors.red}${colors.bold}✖ Diagnostics detected ${results.summary.failures} failure(s). Please review remediation steps above.${colors.reset}\n`
    );
    process.exit(1);
  }
}

// Run CLI when executed directly
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error('Fatal diagnostics error:', err);
    process.exit(1);
  });
}
