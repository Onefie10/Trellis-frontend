#!/usr/bin/env node

import { execSync } from 'node:child_process';

const REPO_OWNER = 'TRELLIS-STELLAR';
const REPO_NAME = 'Trellis-frontend';

function runCmd(cmd, options = {}) {
  try {
    return execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], ...options }).trim();
  } catch (err) {
    const error = new Error(`Command failed: ${cmd}\n${err.stderr || err.message}`);
    error.stdout = err.stdout;
    error.stderr = err.stderr;
    error.code = err.status;
    throw error;
  }
}

async function main() {
  console.log('Fetching open Pull Requests from GitHub API...');
  const res = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/pulls?state=open&per_page=100`, {
    headers: { 'User-Agent': 'Trellis-PR-Merger' }
  });

  if (!res.ok) {
    console.error(`Failed to fetch open PRs: HTTP ${res.status}`);
    process.exit(1);
  }

  const prs = await res.json();
  console.log(`Found ${prs.length} open Pull Request(s).`);

  // Sort by PR number ascending (oldest first)
  prs.sort((a, b) => a.number - b.number);

  // Ensure on main and up to date
  console.log('\nChecking out main branch...');
  runCmd('git checkout main');
  runCmd('git pull origin main');

  const merged = [];
  const skipped = [];

  for (const pr of prs) {
    const prNum = pr.number;
    const author = pr.user ? pr.user.login : 'unknown';
    const branchName = `pr-${prNum}`;
    const commitMsg = `Merge pull request #${prNum} from ${author}/${pr.head.ref}\n\n${pr.title}`;

    console.log(`\n----------------------------------------`);
    console.log(`Processing PR #${prNum}: "${pr.title}" (by @${author})`);

    try {
      // 1. Fetch PR ref
      console.log(`  Fetching refs/pull/${prNum}/head...`);
      runCmd(`git fetch origin pull/${prNum}/head:${branchName} --force`);

      // 2. Attempt merge
      console.log(`  Merging ${branchName} into main...`);
      try {
        runCmd(`git merge ${branchName} --no-ff -m "${commitMsg.replace(/"/g, '\\"')}"`);
        console.log(`  ✓ Merged PR #${prNum} cleanly.`);
        merged.push({ number: prNum, title: pr.title, author });
      } catch (mergeErr) {
        console.warn(`  ! Direct merge conflict for PR #${prNum}. Attempting conflict resolution...`);
        runCmd('git merge --abort');
        // Try merge with ours strategy for conflicts if needed
        try {
          runCmd(`git merge ${branchName} --no-ff -X ours -m "${commitMsg.replace(/"/g, '\\"')}"`);
          console.log(`  ✓ Merged PR #${prNum} (resolved via -X ours strategy).`);
          merged.push({ number: prNum, title: pr.title, author, resolved: true });
        } catch (retryErr) {
          console.error(`  ✗ Skipping PR #${prNum} due to persistent merge conflicts.`);
          runCmd('git merge --abort').catch(() => {});
          skipped.push({ number: prNum, title: pr.title, reason: retryErr.message });
        }
      }
    } catch (fetchErr) {
      console.error(`  ✗ Failed to process PR #${prNum}: ${fetchErr.message}`);
      skipped.push({ number: prNum, title: pr.title, reason: fetchErr.message });
    } finally {
      // Clean up temporary local PR branch
      try { runCmd(`git branch -D ${branchName}`); } catch {}
    }
  }

  console.log('\n========================================');
  console.log(`MERGE SUMMARY: ${merged.length} merged, ${skipped.length} skipped.`);
  console.log('========================================');
  for (const m of merged) {
    console.log(`✓ #${m.number}: ${m.title} (@${m.author})${m.resolved ? ' [Resolved]' : ''}`);
  }
  if (skipped.length > 0) {
    console.log('\nSkipped PRs:');
    for (const s of skipped) {
      console.log(`✗ #${s.number}: ${s.title}`);
    }
  }

  if (merged.length > 0) {
    console.log('\nPushing merged main to origin using SSH (github-doris)...');
    runCmd('git push origin main');
    console.log('✓ Pushed successfully! All merged PRs are now integrated on GitHub.');
  }
}

main().catch(err => {
  console.error('\nFatal error during PR merge script:', err);
  process.exit(1);
});
