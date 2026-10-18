import {
  CommitCategory,
  CommitReference,
  ParsedCommit,
  ReleaseNotesGroup,
} from '../types';

/**
 * Canonical order in which changelog sections are rendered. Keeping this list in
 * one place means the parser, the generator and the preview component all agree
 * on the section ordering.
 */
export const CATEGORY_ORDER: CommitCategory[] = [
  'features',
  'fixes',
  'performance',
  'documentation',
  'refactoring',
  'tests',
  'build',
  'styles',
  'chores',
  'reverts',
  'other',
];

/** Human readable section headings for every changelog category. */
export const CATEGORY_TITLES: Record<CommitCategory, string> = {
  features: 'Features',
  fixes: 'Bug Fixes',
  performance: 'Performance',
  documentation: 'Documentation',
  refactoring: 'Refactoring',
  tests: 'Tests',
  build: 'Build & CI',
  styles: 'Styles',
  chores: 'Chores',
  reverts: 'Reverts',
  other: 'Other Changes',
};

/**
 * Maps a Conventional Commit type onto a changelog section. The core types are
 * the ones documented in CONTRIBUTING.md (feat, fix, docs, style, refactor,
 * test, chore) extended with perf, build, ci and revert.
 */
export const CONVENTIONAL_COMMIT_CATEGORIES: Record<string, CommitCategory> = {
  feat: 'features',
  feature: 'features',
  fix: 'fixes',
  bugfix: 'fixes',
  perf: 'performance',
  docs: 'documentation',
  doc: 'documentation',
  refactor: 'refactoring',
  test: 'tests',
  tests: 'tests',
  build: 'build',
  ci: 'build',
  style: 'styles',
  chore: 'chores',
  revert: 'reverts',
};

const HEADER_PATTERN = /^([A-Za-z]+)(?:\(([^()]+)\))?(!)?:\s*(.+)$/;
const HASH_PATTERN = /^([0-9a-f]{7,40})\s+(.+)$/;
const BULLET_PATTERN = /^\s*[-*]\s+(.+)$/;
const COMMENT_PATTERN = /^\s*#/;
const BREAKING_PATTERN = /(?:^|\n)BREAKING[ -]CHANGE:/;
const URL_REFERENCE_PATTERN =
  /https?:\/\/github\.com\/[^\s/]+\/[^\s/]+\/(pull|issues)\/(\d+)/gi;
const KEYWORD_REFERENCE_PATTERN =
  /(closes|closed|close|fixes|fixed|fix|resolves|resolved|resolve|refs?|references?|pull request)\s+#(\d+)/gi;
const SHORTHAND_REFERENCE_PATTERN = /(?:^|[^\w#])GH-(\d+)/gi;
const HASH_REFERENCE_PATTERN = /(^|[^\w#])#(\d+)/g;
// Squash-merge subjects conventionally end with "(#123)", which is a pull request.
const PARENTHESIZED_REFERENCE_PATTERN = /\(#(\d+)\)/g;
// Trailing reference group stripped from the subject before rendering, since
// the reference is rendered as an explicit link instead.
const TRAILING_REFERENCE_PATTERN = /\s*\((?:#\d+(?:\s*,\s*#\d+)*)\)\s*$/;

/**
 * Resolves the changelog section for a Conventional Commit type. Unknown or
 * missing types fall back to "Other Changes" so hand-written commits are never
 * silently dropped.
 */
export const categoriseCommitType = (type?: string): CommitCategory => {
  if (!type) return 'other';
  return CONVENTIONAL_COMMIT_CATEGORIES[type.trim().toLowerCase()] ?? 'other';
};

/**
 * Extracts pull request and issue references from an arbitrary block of text
 * (commit header, body and footers). References are de-duplicated by number and
 * a pull request reference is always preferred over a bare issue reference.
 */
export const extractReferences = (text: string): CommitReference[] => {
  const found = new Map<number, CommitReference['type']>();

  const record = (number: number, type: CommitReference['type']) => {
    if (!Number.isFinite(number)) return;
    const existing = found.get(number);
    if (!existing || (type === 'pull' && existing === 'issue')) {
      found.set(number, type);
    }
  };

  let match: RegExpExecArray | null;

  URL_REFERENCE_PATTERN.lastIndex = 0;
  while ((match = URL_REFERENCE_PATTERN.exec(text)) !== null) {
    record(Number(match[2]), match[1].toLowerCase() === 'pull' ? 'pull' : 'issue');
  }

  KEYWORD_REFERENCE_PATTERN.lastIndex = 0;
  while ((match = KEYWORD_REFERENCE_PATTERN.exec(text)) !== null) {
    record(Number(match[2]), match[1].toLowerCase() === 'pull request' ? 'pull' : 'issue');
  }

  SHORTHAND_REFERENCE_PATTERN.lastIndex = 0;
  while ((match = SHORTHAND_REFERENCE_PATTERN.exec(text)) !== null) {
    record(Number(match[1]), 'issue');
  }

  PARENTHESIZED_REFERENCE_PATTERN.lastIndex = 0;
  while ((match = PARENTHESIZED_REFERENCE_PATTERN.exec(text)) !== null) {
    record(Number(match[1]), 'pull');
  }

  HASH_REFERENCE_PATTERN.lastIndex = 0;
  while ((match = HASH_REFERENCE_PATTERN.exec(text)) !== null) {
    record(Number(match[2]), 'issue');
  }

  return Array.from(found.entries())
    .map(([number, type]) => ({ number, type }))
    .sort((a, b) => a.number - b.number);
};

/**
 * Parses a single commit message (a full Conventional Commit message or a
 * plain subject line) into a typed, categorised record.
 */
export const parseCommitMessage = (message: string): ParsedCommit => {
  const raw = (message ?? '').trim();
  const lines = raw.split(/\r?\n/);

  let headerIndex = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim().length > 0) {
      headerIndex = index;
      break;
    }
  }

  const header = headerIndex === -1 ? '' : lines[headerIndex].trim();
  const body = headerIndex === -1 ? '' : lines.slice(headerIndex + 1).join('\n').trim();
  const headerMatch = HEADER_PATTERN.exec(header);
  const breaking = Boolean(headerMatch?.[3]) || BREAKING_PATTERN.test(raw);

  if (!headerMatch) {
    return {
      subject: header,
      breaking,
      category: 'other',
      references: extractReferences(raw),
      body,
      raw,
    };
  }

  const [, type, scope, , subject] = headerMatch;
  const cleanSubject = subject.trim().replace(TRAILING_REFERENCE_PATTERN, '').trim();

  return {
    type: type.toLowerCase(),
    scope: scope ? scope.trim() : undefined,
    subject: cleanSubject || subject.trim(),
    breaking,
    category: categoriseCommitType(type),
    references: extractReferences(raw),
    body,
    raw,
  };
};

interface MutableCommit {
  hash?: string;
  lines: string[];
}

/**
 * Parses `git log` output into a list of commits. Two shapes are supported:
 * hashed entries (`<sha> <subject>` followed by body lines) and hash-less
 * bullet lists pasted straight out of a pull request description.
 */
export const parseCommitLog = (log: string): ParsedCommit[] => {
  const commits: ParsedCommit[] = [];
  let current: MutableCommit | null = null;

  const flush = () => {
    if (!current) return;
    if (current.lines.some((line) => line.trim().length > 0)) {
      const message = current.lines.join('\n').trim();
      commits.push({ ...parseCommitMessage(message), hash: current.hash });
    }
    current = null;
  };

  for (const line of (log ?? '').split(/\r?\n/)) {
    if (COMMENT_PATTERN.test(line)) continue;

    const hashMatch = HASH_PATTERN.exec(line);
    if (hashMatch) {
      flush();
      current = { hash: hashMatch[1], lines: [hashMatch[2]] };
      continue;
    }

    const bulletMatch = BULLET_PATTERN.exec(line);
    if (bulletMatch) {
      flush();
      current = { lines: [bulletMatch[1]] };
      continue;
    }

    if (current) {
      current.lines.push(line);
    } else if (line.trim().length > 0) {
      current = { lines: [line] };
    }
  }

  flush();

  return commits;
};

/**
 * Groups commits into changelog sections in canonical order. Empty sections are
 * dropped unless `includeEmpty` is set, which the preview uses to keep the
 * generated Markdown stable while the author is editing.
 */
export const groupCommitsByCategory = (
  commits: ParsedCommit[],
  includeEmpty = false,
): ReleaseNotesGroup[] => {
  return CATEGORY_ORDER.map((category) => ({
    category,
    title: CATEGORY_TITLES[category],
    commits: commits.filter((commit) => commit.category === category),
  })).filter((group) => includeEmpty || group.commits.length > 0);
};
