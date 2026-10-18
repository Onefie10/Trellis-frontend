import {
  CATEGORY_ORDER,
  categoriseCommitType,
  extractReferences,
  groupCommitsByCategory,
  parseCommitLog,
  parseCommitMessage,
} from '../lib/commit-parser';

describe('commit parser', () => {
  describe('categoriseCommitType', () => {
    it('classifies the Conventional Commit types called out by the issue', () => {
      expect(categoriseCommitType('feat')).toBe('features');
      expect(categoriseCommitType('fix')).toBe('fixes');
      expect(categoriseCommitType('docs')).toBe('documentation');
      expect(categoriseCommitType('perf')).toBe('performance');
    });

    it('classifies the remaining CONTRIBUTING.md types', () => {
      expect(categoriseCommitType('style')).toBe('styles');
      expect(categoriseCommitType('refactor')).toBe('refactoring');
      expect(categoriseCommitType('test')).toBe('tests');
      expect(categoriseCommitType('chore')).toBe('chores');
      expect(categoriseCommitType('build')).toBe('build');
      expect(categoriseCommitType('ci')).toBe('build');
      expect(categoriseCommitType('revert')).toBe('reverts');
    });

    it('is case insensitive and trims whitespace', () => {
      expect(categoriseCommitType('FEAT')).toBe('features');
      expect(categoriseCommitType('  Fix ')).toBe('fixes');
    });

    it('falls back to "other" for unknown or missing types', () => {
      expect(categoriseCommitType('unknown')).toBe('other');
      expect(categoriseCommitType('')).toBe('other');
      expect(categoriseCommitType(undefined)).toBe('other');
    });
  });

  describe('extractReferences', () => {
    it('finds pull request and issue references in every supported form', () => {
      const references = extractReferences(
        [
          'feat: add changelog generator (#42)',
          '',
          'Closes #5',
          'GH-6',
          'https://github.com/o/r/pull/8',
          'https://github.com/o/r/issues/9',
          'See pull request #7 for context.',
        ].join('\n'),
      );

      expect(references).toEqual([
        { number: 5, type: 'issue' },
        { number: 6, type: 'issue' },
        { number: 7, type: 'pull' },
        { number: 8, type: 'pull' },
        { number: 9, type: 'issue' },
        { number: 42, type: 'pull' },
      ]);
    });

    it('prefers a pull request reference over a bare issue reference', () => {
      expect(extractReferences('fix: tweak #12 (#12)')).toEqual([
        { number: 12, type: 'pull' },
      ]);
    });

    it('de-duplicates repeated references', () => {
      expect(extractReferences('fix: a (#3)\n\nCloses #3')).toEqual([
        { number: 3, type: 'pull' },
      ]);
    });

    it('returns an empty list when there are no references', () => {
      expect(extractReferences('docs: tidy up the README')).toEqual([]);
    });
  });

  describe('parseCommitMessage', () => {
    it('parses a conventional commit header with a scope and reference', () => {
      const commit = parseCommitMessage('feat(agent-versioning): add generator (#42)');

      expect(commit.type).toBe('feat');
      expect(commit.scope).toBe('agent-versioning');
      expect(commit.subject).toBe('add generator');
      expect(commit.category).toBe('features');
      expect(commit.breaking).toBe(false);
      expect(commit.references).toEqual([{ number: 42, type: 'pull' }]);
    });

    it('detects a breaking change from the "!" header flag', () => {
      const commit = parseCommitMessage('fix(registry)!: drop legacy field');

      expect(commit.breaking).toBe(true);
      expect(commit.category).toBe('fixes');
    });

    it('detects a breaking change from the BREAKING CHANGE footer', () => {
      const commit = parseCommitMessage(
        'perf: rework batching\n\nBREAKING CHANGE: batch API changed',
      );

      expect(commit.breaking).toBe(true);
      expect(commit.category).toBe('performance');
      expect(commit.body).toContain('BREAKING CHANGE');
    });

    it('keeps non-conventional messages in the "other" section', () => {
      const commit = parseCommitMessage('Merge branch main');

      expect(commit.type).toBeUndefined();
      expect(commit.scope).toBeUndefined();
      expect(commit.subject).toBe('Merge branch main');
      expect(commit.category).toBe('other');
    });

    it('handles an empty message without throwing', () => {
      const commit = parseCommitMessage('');

      expect(commit.subject).toBe('');
      expect(commit.category).toBe('other');
      expect(commit.breaking).toBe(false);
    });
  });

  describe('parseCommitLog', () => {
    it('parses hashed git log entries together with their bodies', () => {
      const commits = parseCommitLog(
        [
          'abc1234 feat(agent): generate release notes',
          '',
          'Longer explanation of the change.',
          '',
          '9876543 fix: respect breaking footer',
        ].join('\n'),
      );

      expect(commits).toHaveLength(2);
      expect(commits[0].hash).toBe('abc1234');
      expect(commits[0].category).toBe('features');
      expect(commits[0].body).toBe('Longer explanation of the change.');
      expect(commits[1].hash).toBe('9876543');
      expect(commits[1].category).toBe('fixes');
    });

    it('parses hash-less bullet lists copied from a pull request', () => {
      const commits = parseCommitLog(
        ['- docs: document the new flow', '* perf: cache rendered notes'].join('\n'),
      );

      expect(commits.map((commit) => commit.category)).toEqual([
        'documentation',
        'performance',
      ]);
      expect(commits.map((commit) => commit.hash)).toEqual([undefined, undefined]);
    });

    it('ignores blank and comment lines', () => {
      const commits = parseCommitLog('# a comment\n\n- feat: one\n\n# another comment');

      expect(commits).toHaveLength(1);
      expect(commits[0].subject).toBe('one');
    });

    it('returns an empty list for empty input', () => {
      expect(parseCommitLog('')).toEqual([]);
    });
  });

  describe('groupCommitsByCategory', () => {
    const commits = [
      parseCommitMessage('fix: a'),
      parseCommitMessage('feat: b'),
      parseCommitMessage('chore: c'),
    ];

    it('orders groups canonically and drops empty sections', () => {
      const groups = groupCommitsByCategory(commits);

      expect(groups.map((group) => group.category)).toEqual([
        'features',
        'fixes',
        'chores',
      ]);
      expect(groups.every((group) => group.commits.length > 0)).toBe(true);
    });

    it('keeps empty sections when explicitly requested', () => {
      const groups = groupCommitsByCategory(commits, true);

      expect(groups).toHaveLength(CATEGORY_ORDER.length);
      expect(groups.map((group) => group.category)).toEqual(CATEGORY_ORDER);
    });

    it('titles every section for the Markdown generator', () => {
      const titles = groupCommitsByCategory(commits, true).map((group) => group.title);

      expect(titles).toContain('Features');
      expect(titles).toContain('Bug Fixes');
      expect(titles).toContain('Other Changes');
    });
  });
});
