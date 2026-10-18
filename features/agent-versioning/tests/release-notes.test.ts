import {
  formatCommitLine,
  generateReleaseNotes,
  referenceUrl,
  repositoryBaseUrl,
} from '../lib/release-notes';
import { parseCommitMessage } from '../lib/changelog-parser';

const repository = 'TRELLIS-STELLAR/Trellis-frontend';
const repositoryUrl = 'https://github.com/TRELLIS-STELLAR/Trellis-frontend';

const feature = parseCommitMessage(
  'feat(versioning): add changelog generator (#120)',
  '1111111',
);
const fix = parseCommitMessage('fix: correct preview crash\n\nCloses #121', '2222222');
const docs = parseCommitMessage('docs: document release notes (#122)', '3333333');
const breaking = parseCommitMessage('feat!: drop legacy state field (#125)', '4444444');

describe('repositoryBaseUrl', () => {
  it('normalises owner/name, github URLs and clone URLs', () => {
    expect(repositoryBaseUrl(repository)).toBe(repositoryUrl);
    expect(repositoryBaseUrl(`${repositoryUrl}.git`)).toBe(repositoryUrl);
    expect(repositoryBaseUrl(`git@github.com:${repository}.git`)).toBe(repositoryUrl);
  });

  it('returns null when the repository cannot be resolved', () => {
    expect(repositoryBaseUrl('trellis')).toBeNull();
    expect(repositoryBaseUrl(undefined)).toBeNull();
  });
});

describe('referenceUrl', () => {
  it('builds pull request and issue links', () => {
    expect(referenceUrl({ kind: 'pull', number: 120 }, repository)).toBe(
      `${repositoryUrl}/pull/120`,
    );
    expect(referenceUrl({ kind: 'issue', number: 121 }, repository)).toBe(
      `${repositoryUrl}/issues/121`,
    );
  });

  it('returns null without a repository', () => {
    expect(referenceUrl({ kind: 'issue', number: 121 })).toBeNull();
  });
});

describe('formatCommitLine', () => {
  it('renders scope, breaking marker and linked references', () => {
    expect(formatCommitLine(feature, repository)).toBe(
      `- **versioning:** add changelog generator ([#120](${repositoryUrl}/pull/120))`,
    );
    expect(formatCommitLine(breaking, repository)).toBe(
      `- **BREAKING** drop legacy state field ([#125](${repositoryUrl}/pull/125))`,
    );
  });

  it('falls back to plain references when no repository is configured', () => {
    expect(formatCommitLine(fix)).toBe('- correct preview crash (#121)');
  });
});

describe('generateReleaseNotes', () => {
  it('renders categorised sections in order with linked references', () => {
    const notes = generateReleaseNotes({
      version: '1.2.0',
      date: '2026-09-27',
      repository,
      commits: [fix, feature, docs],
    });

    expect(notes).toContain('# Release notes: v1.2.0');
    expect(notes).toContain('_Generated from 3 commits on 2026-09-27._');
    expect(notes).toContain('## Features');
    expect(notes).toContain('## Bug Fixes');
    expect(notes).toContain('## Documentation');
    expect(notes).toContain(`[#120](${repositoryUrl}/pull/120)`);
    expect(notes).toContain(`[#121](${repositoryUrl}/issues/121)`);
    expect(notes.indexOf('## Features')).toBeLessThan(notes.indexOf('## Bug Fixes'));
    expect(notes.indexOf('## Bug Fixes')).toBeLessThan(notes.indexOf('## Documentation'));
  });

  it('surfaces breaking changes in a dedicated leading section', () => {
    const notes = generateReleaseNotes({
      version: '2.0.0',
      repository,
      commits: [feature, breaking],
    });

    expect(notes).toContain('## Breaking Changes');
    expect(notes.indexOf('## Breaking Changes')).toBeLessThan(notes.indexOf('## Features'));
    expect(notes).toContain('**BREAKING** drop legacy state field');
  });

  it('omits empty sections and describes an empty commit range', () => {
    const notes = generateReleaseNotes({ version: '1.0.1', repository, commits: [fix] });

    expect(notes).not.toContain('## Features');
    expect(notes).toContain('## Bug Fixes');
    expect(
      generateReleaseNotes({ version: '1.0.0', commits: [] }),
    ).toContain('_No changes found in the provided commit range._');
  });
});
