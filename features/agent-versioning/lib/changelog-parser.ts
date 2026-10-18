import {
  CommitCategory,
  CommitReference,
  ParsedCommit,
  ReleaseNotesGroup,
} from '../types';

/**
 * Human readable title for every changelog section.
 */
export const CATEGORY_TITLES: Record<CommitCategory, string> = {
  features: 'Features',
  fixes: 'Bug Fixes',
  performance: 'Performance',
  documentation: 'Documentation',
  refactor: 'Refactoring',
  tests: 'Tests',
  build: 'Build & CI',
  chores: 'Chores',
  style: 'Styles',
  reverts: 'Reverts',
  other: 'Other Changes',
};

/**
 * The order sections appear in a generated changelog. Keep-a-Changelog puts the
 * most user-facing changes first, with internal/tooling work at the bottom.
 */
export const CATEGORY_ORDER: CommitCategory[] = [
  'features',
  'fixes',
  'performance',
  'documentation',
  'refactor',
  'tests',
  'build',
  'chores',
  'style',
  'reverts',
  'other',
];

/**
 * Conventional Commit types used by this project (see CONTRIBUTING.md), plus a
 * few common aliases, mapped onto changelog sections.
 */
const TYPE_TO_CATEGORY: Record<string, CommitCategory> = {
  feat: 'features',
  feature: 'features',
  fix: 'fixes',
  bugfix: 'fixes',
  perf: 'performance',
  performance: 'performance',
  docs: 'documentation',
  doc: 'documentation',
  refactor: 'refactor',
  test: 'tests',
  tests: 'tests',
  build: 'build',
  ci: 'build',
  chore: 'chores',
  style: 'style',
  revert: 'reverts',
};

/** Matches "type(scope)!: subject" headers. */
const HEADER_PATTERN =
  /^([a-zA-Z]+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/;

/** Matches a git log line that starts with a short or full SHA. */
const HASHED_LINE_PATTERN = /^(?:commit\s+)?([0-9a-f]{7,40})\s+(.+)$/i;

/** A "BREAKING CHANGE:" / "BREAKING-CHANGE:" footer anywhere in the message. */
const BREAKING_FOOTER_PATTERN = /^BREAKING[ -]CHANGE:\s*/im;

const GITHUB_URL_PATTERN =
  /https?:\/\/github\.com\/[^\s/]+\/[^\s/]+\/(pull|issues)\/(\d+)/gi;
const PULL_REQUEST_MENTION_PATTERN = /\bpull request\s+#(\d+)/gi;
const PULL_SHORTHAND_PATTERN = /\((?:#|GH-)(\d+)\)/gi;
const ISSUE_KEYWORD_PATTERN =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|refs?|references?|see|related to)\s+#(\d+)/gi;
const BARE_REFERENCE_PATTERN = /(?:^|[\s(])#(\d+)\b/g;

/**
 * Maps a Conventional Commit type onto a changelog section.
 * Unknown or missing types fall through to the "Other Changes" section.
 */
export const categoriseCommitType = (type: string | null): CommitCategory => {
  if (!type) {
    return 'other';
  }

  return TYPE_TO_CATEGORY[type.trim().toLowerCase()] ?? 'other';
};

/**
 * Collects pull request / issue references from a commit message.
 *
 * Supported forms:
 * - `(#123)` squash-merge shorthand and GH-123 -> pull request
 * - `https://github.com/o/r/pull/123` -> pull request
 * - `https://github.com/o/r/issues/123` -> issue
 * - `closes #123` / `fixes #123` / `refs #123` -> issue
 * - bare `#123` inside the body -> issue
 *
 * A number that is referenced as both a pull request and an issue is kept once,
 * preferring the pull request, so generated notes never emit duplicate links.
 */
export const extractReferences = (
  subject: string,
  body = '',
): CommitReference[] => {
  // Keyed by number so the same reference is only emitted once.
  const references = new Map<number, CommitReference>();

  const add = (kind: CommitReference['kind'], number: number) => {
    if (!Number.isInteger(number) || number <= 0) {
      return;
    }

    const existing = references.get(number);
    if (existing && existing.kind === 'pull') {
      return;
    }

    references.set(number, { kind, number });
  };

  const text = `${subject}\n${body}`;
  let match: RegExpExecArray | null;

  GITHUB_URL_PATTERN.lastIndex = 0;
  while ((match = GITHUB_URL_PATTERN.exec(text)) !== null) {
    add(match[1].toLowerCase() === 'pull' ? 'pull' : 'issue', Number(match[2]));
  }

  PULL_REQUEST_MENTION_PATTERN.lastIndex = 0;
  while ((match = PULL_REQUEST_MENTION_PATTERN.exec(text)) !== null) {
    add('pull', Number(match[1]));
  }

  PULL_SHORTHAND_PATTERN.lastIndex = 0;
  while ((match = PULL_SHORTHAND_PATTERN.exec(text)) !== null) {
    add('pull', Number(match[1]));
  }

  ISSUE_KEYWORD_PATTERN.lastIndex = 0;
  while ((match = ISSUE_KEYWORD_PATTERN.exec(text)) !== null) {
    add('issue', Number(match[1]));
  }

  BARE_REFERENCE_PATTERN.lastIndex = 0;
  while ((match = BARE_REFERENCE_PATTERN.exec(body)) !== null) {
    add('issue', Number(match[1]));
  }

  return [...references.values()].sort((a, b) => a.number - b.number);
};

/**
 * Parses a single commit message (header + optional body).
 *
 * @param message Full commit message, e.g. "feat(ui): add table\n\nCloses #12"
 * @param hash Optional commit SHA to attach to the result.
 */
export const parseCommitMessage = (
  message: string,
  hash = '',
): ParsedCommit => {
  const raw = message;
  const [headerLine = '', ...bodyLines] = message.split(/\r?\n/);
  const header = headerLine.trim();
  const body = bodyLines.join('\n').trim();

  const match = HEADER_PATTERN.exec(header);
  const type = match?.[1] ? match[1].toLowerCase() : null;
  const scope = match?.[2]?.trim() || null;
  const breaking = Boolean(match?.[3]) || BREAKING_FOOTER_PATTERN.test(message);
  const rawSubject = match?.[4]?.trim() || header;
  // Drop the trailing "(#123)" squash-merge suffix so it is not duplicated
  // once `formatCommitLine` appends the linked reference.
  const subject =
    rawSubject.replace(/\s*\((?:(?:#|GH-)\d+)\)\s*$/i, '').trim() || rawSubject;

  return {
    hash: hash.trim(),
    type,
    scope,
    subject,
    body,
    category: categoriseCommitType(type),
    breaking,
    references: extractReferences(header, body),
    raw,
  };
};

/**
 * Parses a git log (or any newline separated commit list) into commits.
 *
 * Each line beginning with a 7-40 character SHA starts a new commit; following
 * lines are treated as that commit's body. Lines without a SHA are treated as
 * standalone subjects (e.g. a `- feat: thing` bullet list from a PR body).
 * Blank lines and `#` comment lines are ignored.
 */
export const parseCommitLog = (log: string): ParsedCommit[] => {
  const commits: ParsedCommit[] = [];
  let hash = '';
  let lines: string[] = [];

  const flush = () => {
    const message = lines.join('\n').trim();
    if (message) {
      commits.push(parseCommitMessage(message, hash));
    }
    hash = '';
    lines = [];
  };

  for (const rawLine of log.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (!line || line.startsWith('#')) {
      // Preserve a blank line inside a hashed commit so BREAKING CHANGE
      // footers (which must be separated from the header) stay detectable.
      if (hash && lines.length > 0) {
        lines.push('');
      }
      continue;
    }

    const hashed = HASHED_LINE_PATTERN.exec(line);
    if (hashed) {
      flush();
      hash = hashed[1];
      lines = [hashed[2].trim()];
      continue;
    }

    // A `- feat: thing` bullet is a standalone commit even when it follows a
    // hashed commit, so authors can paste a PR body list after a git log.
    const bullet = /^[-*]\s+(.+)$/.exec(line);
    if (bullet && HEADER_PATTERN.test(bullet[1].trim())) {
      flush();
      lines = [bullet[1].trim()];
      continue;
    }

    // Any other hash-less line starts (and, since bodies are only associated
    // with a SHA, terminates) its own commit.
    if (!hash) {
      flush();
    }

    lines.push(line);
  }

  flush();
  return commits;
};

/**
 * Groups commits into ordered changelog sections.
 */
export const groupCommitsByCategory = (
  commits: ParsedCommit[],
  includeEmptySections = false,
): ReleaseNotesGroup[] =>
  CATEGORY_ORDER.map((category) => ({
    category,
    title: CATEGORY_TITLES[category],
    commits: commits.filter((commit) => commit.category === category),
  })).filter((group) => includeEmptySections || group.commits.length > 0);
