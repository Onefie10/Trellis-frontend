#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPO_OWNER = 'TRELLIS-STELLAR';
const REPO_NAME = 'Trellis-frontend';
const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const fileArgIndex = args.indexOf('--file');
const customFile = fileArgIndex !== -1 ? args[fileArgIndex + 1] : null;
const ISSUES_FILE = customFile
  ? path.resolve(process.cwd(), customFile)
  : path.resolve(__dirname, '../.github/wave-issues-2.json');

const tokenArgIndex = args.indexOf('--token');
const tokenFromArg = tokenArgIndex !== -1 ? args[tokenArgIndex + 1] : null;

const GITHUB_TOKEN =
  tokenFromArg ||
  process.env.GITHUB_PAT ||
  process.env.GH_TOKEN ||
  process.env.GITHUB_TOKEN;

if (!GITHUB_TOKEN && !isDryRun) {
  console.error('Error: GitHub Personal Access Token (PAT) is required.');
  console.error('Provide it via:');
  console.error('  1. Argument: node scripts/publish-github-issues.mjs --token <YOUR_PAT>');
  console.error('  2. Environment variable: $env:GITHUB_PAT="<YOUR_PAT>" (PowerShell)');
  console.error('  3. Dry-run mode: node scripts/publish-github-issues.mjs --dry-run');
  process.exit(1);
}

if (!fs.existsSync(ISSUES_FILE)) {
  console.error(`Error: Issues definition file not found at ${ISSUES_FILE}`);
  process.exit(1);
}

const issuesData = JSON.parse(fs.readFileSync(ISSUES_FILE, 'utf-8'));
const issues = issuesData.issues || [];

console.log(`Loaded ${issues.length} issues from ${ISSUES_FILE}`);
console.log(`Target Repository: ${REPO_OWNER}/${REPO_NAME}`);
console.log(`Mode: ${isDryRun ? 'DRY-RUN (no issues will be created)' : 'LIVE'}`);

const headers = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'Trellis-Issue-Publisher',
  ...(GITHUB_TOKEN ? { Authorization: `Bearer ${GITHUB_TOKEN}` } : {}),
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...headers,
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    const message = data && data.message ? data.message : text;
    const error = new Error(`HTTP ${response.status} ${response.statusText}: ${message}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}

async function getExistingIssues() {
  console.log('\nFetching existing issues from repository...');
  const existing = [];
  let page = 1;
  while (true) {
    const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/issues?state=all&per_page=100&page=${page}`;
    const pageIssues = await fetchJson(url);
    if (!Array.isArray(pageIssues) || pageIssues.length === 0) break;
    existing.push(...pageIssues);
    if (pageIssues.length < 100) break;
    page++;
  }
  console.log(`Found ${existing.length} existing issue(s).`);
  return existing;
}

async function ensureLabels(neededLabels) {
  console.log('\nChecking repository labels...');
  const existingLabels = new Set();
  try {
    let page = 1;
    while (true) {
      const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/labels?per_page=100&page=${page}`;
      const pageLabels = await fetchJson(url);
      if (!Array.isArray(pageLabels) || pageLabels.length === 0) break;
      for (const l of pageLabels) {
        existingLabels.add(l.name.toLowerCase());
      }
      if (pageLabels.length < 100) break;
      page++;
    }
  } catch (err) {
    console.warn(`Warning: Could not fetch labels (${err.message}). Continuing...`);
  }

  const labelColors = {
    ci: '0052cc',
    i18n: '1d76db',
    test: 'fbca04',
    blockchain: '5319e7',
    'backend-integration': 'bfdadc',
    architecture: 'd4c5f9',
    'needs discussion': 'd93f0b',
    'developer-experience': '0e8a16',
    refactor: 'e99695',
    performance: 'f9d0c4',
    dependencies: '0366d6',
  };

  for (const label of neededLabels) {
    if (!existingLabels.has(label.toLowerCase())) {
      console.log(`  Creating missing label: "${label}"...`);
      try {
        await fetchJson(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/labels`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: label,
            color: labelColors[label] || 'ededed',
            description: `Auto-generated label for ${label}`,
          }),
        });
        existingLabels.add(label.toLowerCase());
      } catch (err) {
        console.warn(`  Notice: Could not create label "${label}" (${err.message})`);
      }
    }
  }
}

async function main() {
  if (isDryRun) {
    console.log('\n--- DRY RUN PREVIEW ---');
    for (const [index, issue] of issues.entries()) {
      console.log(`\n[#${index + 1}] Stage ${issue.stage}: ${issue.title}`);
      console.log(`Labels: ${issue.labels.join(', ')}`);
      console.log(`Body preview:\n${issue.body.slice(0, 150)}...`);
    }
    console.log(`\nTotal: ${issues.length} issues would be created.`);
    return;
  }

  // 1. Check authenticated user
  try {
    const user = await fetchJson('https://api.github.com/user');
    console.log(`Authenticated as GitHub user: @${user.login} (${user.name || 'No Name'})`);
  } catch (err) {
    console.error('Authentication verification failed:', err.message);
    process.exit(1);
  }

  // 2. Fetch existing issues to avoid duplication
  const existingIssues = await getExistingIssues();
  const existingTitles = new Set(existingIssues.map((i) => i.title.trim().toLowerCase()));

  // 3. Ensure labels exist
  const allLabels = Array.from(new Set(issues.flatMap((i) => i.labels || [])));
  await ensureLabels(allLabels);

  // 4. Create issues sequentially
  console.log(`\n--- CREATING ${issues.length} ISSUES ---`);
  const createdIssues = [];

  for (let i = 0; i < issues.length; i++) {
    const issue = issues[i];
    const cleanTitle = issue.title.trim();

    if (existingTitles.has(cleanTitle.toLowerCase())) {
      console.log(`[${i + 1}/${issues.length}] SKIPPED: "${cleanTitle}" (Already exists)`);
      continue;
    }

    console.log(`[${i + 1}/${issues.length}] Creating: "${cleanTitle}"...`);

    let issuePayload = {
      title: cleanTitle,
      body: issue.body,
      labels: issue.labels,
    };

    let result;
    try {
      result = await fetchJson(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/issues`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(issuePayload),
      });
    } catch (err) {
      // If label assignment failed due to lack of write/triage permission, retry without labels
      if (err.status === 403 || err.status === 422) {
        console.warn(`  Retry without labels due to permissions (${err.message})...`);
        issuePayload = {
          title: cleanTitle,
          body: `${issue.body}\n\n---\n**Labels:** \`${issue.labels.join('`, `')}\``,
        };
        result = await fetchJson(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/issues`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(issuePayload),
        });
      } else {
        throw err;
      }
    }

    console.log(`  ✓ Created Issue #${result.number}: ${result.html_url}`);
    createdIssues.push({
      number: result.number,
      title: result.title,
      url: result.html_url,
    });

    // Rate-limiting delay between issue creations
    if (i < issues.length - 1) {
      await sleep(1500);
    }
  }

  console.log('\n========================================');
  console.log(`Successfully processed issues! (${createdIssues.length} newly created)`);
  for (const item of createdIssues) {
    console.log(`- #${item.number}: ${item.title} -> ${item.url}`);
  }
  console.log('========================================');
}

main().catch((err) => {
  console.error('\nFatal Error while creating issues:', err);
  process.exit(1);
});
