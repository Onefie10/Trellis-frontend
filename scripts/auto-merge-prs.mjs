#!/usr/bin/env node

import { execSync } from 'node:child_process';

const REPO_OWNER = process.env.GITHUB_REPOSITORY ? process.env.GITHUB_REPOSITORY.split('/')[0] : 'TRELLIS-STELLAR';
const REPO_NAME = process.env.GITHUB_REPOSITORY ? process.env.GITHUB_REPOSITORY.split('/')[1] : 'Trellis-frontend';

const GITHUB_TOKEN =
  process.env.DORIS_PAT ||
  process.env.GITHUB_PAT ||
  process.env.GH_TOKEN ||
  process.env.GITHUB_TOKEN;

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

function extractLinkedIssues(title, body, branchName) {
  const text = `${title || ''}\n${body || ''}\n${branchName || ''}`;
  const issueNumbers = new Set();

  // Match patterns like: #123, issue-123, issue 123, fixes #123, closes #123
  const patterns = [
    /issue[-_ ]?(\d+)/gi,
    /fix(?:es|ed)?[-_ ]?#?(\d+)/gi,
    /close[sd]?[-_ ]?#?(\d+)/gi,
    /resolve[sd]?[-_ ]?#?(\d+)/gi,
    /#(\d+)/g
  ];

  for (const regex of patterns) {
    let match;
    while ((match = regex.exec(text)) !== null) {
      const num = parseInt(match[1], 10);
      if (num > 0 && num < 1000) {
        issueNumbers.add(num);
      }
    }
  }

  return Array.from(issueNumbers);
}

async function apiFetch(endpoint, method = 'GET', body = null) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'Doris-Trellis-AutoMerger',
    ...(GITHUB_TOKEN ? { Authorization: `Bearer ${GITHUB_TOKEN}` } : {}),
  };

  const res = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}${endpoint}`, {
    method,
    headers: {
      ...headers,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, ok: res.ok, data };
}

async function main() {
  console.log(`[Doris Maintainer Auto-Merge] Target: ${REPO_OWNER}/${REPO_NAME}`);

  console.log('Fetching open Pull Requests from GitHub...');
  const res = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/pulls?state=open&per_page=100`, {
    headers: { 'User-Agent': 'Doris-Trellis-AutoMerger' }
  });

  if (!res.ok) {
    console.error(`Failed to list open PRs: HTTP ${res.status}`);
    process.exit(1);
  }

  const prs = await res.json();
  console.log(`Found ${prs.length} open Pull Request(s).`);

  if (prs.length === 0) {
    console.log('No open PRs to merge. Exiting cleanly.');
    return;
  }

  // Sort by PR number ascending
  prs.sort((a, b) => a.number - b.number);

  let isGitRepo = false;
  try {
    runCmd('git rev-parse --is-inside-work-tree');
    isGitRepo = true;
  } catch {}

  if (isGitRepo) {
    console.log('\nConfiguring Doris Git Author identity...');
    runCmd('git config user.name "Doris Maduegbunam"');
    runCmd('git config user.email "dorismaduegbunam@gmail.com"');

    try {
      runCmd('git checkout main');
      runCmd('git pull origin main');
    } catch (err) {
      console.warn(`Git pull notice: ${err.message}`);
    }
  }

  const merged = [];
  const skipped = [];

  for (const pr of prs) {
    const prNum = pr.number;
    const author = pr.user ? pr.user.login : 'unknown';
    const linkedIssues = extractLinkedIssues(pr.title, pr.body, pr.head.ref);

    let issueClosesText = '';
    if (linkedIssues.length > 0) {
      issueClosesText = '\n\n' + linkedIssues.map(n => `Closes #${n}`).join('\n');
    }

    const commitTitle = `Merge pull request #${prNum} from ${author}/${pr.head.ref}\n\n${pr.title}${issueClosesText}`;

    console.log(`\nProcessing PR #${prNum}: "${pr.title}" (@${author})`);
    if (linkedIssues.length > 0) {
      console.log(`  Linked Issues to close: #${linkedIssues.join(', #')}`);
    }

    // Try API merge if DORIS_PAT / GITHUB_PAT is set
    let apiSuccess = false;
    if (GITHUB_TOKEN) {
      try {
        // Approve PR first as Doris
        try {
          await apiFetch(`/pulls/${prNum}/reviews`, 'POST', {
            event: 'APPROVE',
            body: `Approved by @dorismaduegbunam (Doris Maintainer Automation).${issueClosesText}`,
          });
        } catch {}

        const mergeRes = await apiFetch(`/pulls/${prNum}/merge`, 'PUT', {
          commit_title: `Merge pull request #${prNum} from ${author}/${pr.head.ref}`,
          commit_message: `${pr.title}${issueClosesText}`,
          merge_method: 'merge',
        });

        if (mergeRes.ok) {
          console.log(`  ✓ Successfully merged PR #${prNum} via GitHub API as Doris.`);
          merged.push({ number: prNum, title: pr.title, author, method: 'API', linkedIssues });
          apiSuccess = true;
        }
      } catch (apiErr) {
        console.warn(`  Notice: API merge notice (${apiErr.message}), falling back to local git merge...`);
      }
    }

    if (!apiSuccess && isGitRepo) {
      const branchName = `doris-pr-${prNum}`;
      try {
        console.log(`  Fetching refs/pull/${prNum}/head...`);
        runCmd(`git fetch origin pull/${prNum}/head:${branchName} --force`);

        console.log(`  Merging ${branchName} into main under Doris identity...`);
        try {
          runCmd(`git merge ${branchName} --no-ff -m "${commitTitle.replace(/"/g, '\\"')}"`);
          console.log(`  ✓ Merged PR #${prNum} locally.`);
          merged.push({ number: prNum, title: pr.title, author, method: 'Git', linkedIssues });
        } catch {
          console.warn(`  ! Conflict on PR #${prNum}. Attempting -X ours resolution...`);
          runCmd('git merge --abort').catch(() => {});
          try {
            runCmd(`git merge ${branchName} --no-ff -X ours -m "${commitTitle.replace(/"/g, '\\"')}"`);
            console.log(`  ✓ Merged PR #${prNum} (resolved via -X ours).`);
            merged.push({ number: prNum, title: pr.title, author, method: 'Git-Ours', linkedIssues });
          } catch (retryErr) {
            runCmd('git merge --abort').catch(() => {});
            console.error(`  ✗ Skipping PR #${prNum}: persistent merge conflict.`);
            skipped.push({ number: prNum, title: pr.title, reason: retryErr.message });
          }
        }
      } catch (err) {
        console.error(`  ✗ Error fetching/merging PR #${prNum}: ${err.message}`);
        skipped.push({ number: prNum, title: pr.title, reason: err.message });
      } finally {
        try { runCmd(`git branch -D ${branchName}`); } catch {}
      }
    }
  }

  // Push local git merges to origin main via SSH as Doris
  const gitMergedCount = merged.filter((m) => m.method.startsWith('Git')).length;
  if (isGitRepo && gitMergedCount > 0) {
    console.log(`\nPushing ${gitMergedCount} merged PR(s) to origin main as Doris (github-doris)...`);
    try {
      runCmd('git push origin main');
      console.log('✓ Pushed successfully to origin main under @dorismaduegbunam identity.');
    } catch (pushErr) {
      console.error(`Failed to push merged commits to origin main: ${pushErr.message}`);
    }
  }

  console.log('\n========================================');
  console.log(`Doris Auto-Merge Summary: ${merged.length} merged, ${skipped.length} skipped.`);
  console.log('========================================');
}

main().catch((err) => {
  console.error('Fatal error in Doris auto-merge runner:', err);
  process.exit(1);
});
