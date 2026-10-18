import {
  CATEGORY_ORDER,
  categoriseCommitType,
  extractReferences,
  groupCommitsByCategory,
  parseCommitLog,
  parseCommitMessage,
} from '../lib/changelog-parser';

describe('categoriseCommitType', () => {
  it('maps the Conventional Commit types used by this project', () => {
    expect(categoriseCommitType('feat')).toBe('features');
    expect(categoriseCommitType('fix')).toBe('fixes');
    expect(categoriseCommitType('perf')).toBe('performance');
    expect(categoriseCommitType('docs')).toBe('documentation');
    expect(categoriseCommitType('refactor')).toBe('refactor');
    expect(categoriseCommitType('test')).toBe('tests');
    expect(categoriseCommitType('chore')).toBe('chores');
    expect(categoriseCommitType('style')).toBe('style');
  });

  it('is case-insensitive and falls back to "other"', () => {
    expect(categoriseCommitType('FEAT')).toBe('features');
    expect(categoriseCommitType('wip')).toBe('other');
    expect(categoriseCommitType(null)).toBe('other');
  });
});

describe('parseCommitMessage', () => {
  it('parses type, scope and subject from a conventional header', () => {
    const commit = parseCommitMessage('feat(versioning): generate changelog', 'abc1234');

    expect(commit.hash).toBe('abc1234');
    expect(commit.type).toBe('feat');
    expect(commit.scope).toBe('versioning');
    expect(commit.subject).toBe('generate changelog');
    expect(commit.category).toBe('features');
    expect(commit.breaking).toBe(false);
  });

  it('flags breaking changes declared with "!" or a BREAKING CHANGE footer', () => {
    expect(parseCommitMessage('feat!: drop legacy endpoint').breaking).toBe(true);

    const footer = parseCommitMessage('fix: tidy up\n\nBREAKING CHANGE: removes field');
    expect(footer.breaking).toBe(true);
  });

  it('falls back gracefully for non-conventional messages', () => {
    const commit = parseCommitMessage('Merge pull request #12 from trellis/ui');

    expect(commit.type).toBeNull();
    expect(commit.scope).toBeNull();
    expect(commit.category).toBe('other');
    expect(commit.subject).toBe('Merge pull request #12 from trellis/ui');
  });
});

describe('extractReferences', () => {
  it('collects pull requests and issues from a message', () => {
    const references = extractReferences(
      'feat: add changelog (#120)',
      'Closes #121\nRefs https://github.com/TRELLIS-STELLAR/Trellis-frontend/issues/122',
    );

    expect(references).toEqual([
      { kind: 'pull', number: 120 },
      { kind: 'issue', number: 121 },
      { kind: 'issue', number: 122 },
    ]);
  });

  it('prefers the pull request when a number is referenced twice', () => {
    const references = extractReferences('fix: repair (#7)', 'closes #7');

    expect(references).toEqual([{ kind: 'pull', number: 7 }]);
  });
});

describe('parseCommitLog', () => {
  it('parses hashed git log lines and their bodies', () => {
    const log = [
      'abc1234 feat(search): add filters',
      'def5678 fix: correct pagination',
      '',
      'Closes #42',
    ].join('\n');

    const commits = parseCommitLog(log);

    expect(commits).toHaveLength(2);
    expect(commits[0].scope).toBe('search');
    expect(commits[0].category).toBe('features');
    expect(commits[1].category).toBe('fixes');
    expect(commits[1].references).toEqual([{ kind: 'issue', number: 42 }]);
  });

  it('parses hash-less bullet lists and ignores comment lines', () => {
    const log = [
      '# pasted from a pull request body',
      '- feat: expose preview component',
      '- docs: document release notes',
    ].join('\n');

    const commits = parseCommitLog(log);

    expect(commits.map((commit) => commit.category)).toEqual(['features', 'documentation']);
  });
});

describe('groupCommitsByCategory', () => {
  it('renders sections in canonical order and drops empty ones', () => {
    const commits = [
      parseCommitMessage('chore: bump dependencies'),
      parseCommitMessage('feat: new thing'),
      parseCommitMessage('fix: repair thing'),
    ];

    const groups = groupCommitsByCategory(commits);

    expect(groups.map((group) => group.title)).toEqual(['Features', 'Bug Fixes', 'Chores']);
    expect(CATEGORY_ORDER.indexOf('features')).toBeLessThan(CATEGORY_ORDER.indexOf('chores'));
  });

  it('keeps empty sections when explicitly requested', () => {
    const groups = groupCommitsByCategory([], true);

    expect(groups).toHaveLength(CATEGORY_ORDER.length);
    expect(groups[0].title).toBe('Features');
  });
});
