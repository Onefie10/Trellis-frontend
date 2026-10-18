import {
  CommitReference,
  ParsedCommit,
  ReleaseNotesGroup,
  ReleaseNotesOptions,
} from '../types';
import { groupCommitsByCategory } from './changelog-parser';

export const GITHUB_BASE_URL = 'https://github.com';

/**
 * Normalises a repository identifier ("owner/name", a github.com URL or a
 * clone URL) into a browser base URL, or null when it cannot be resolved.
 */
export const repositoryBaseUrl = (repository?: string): string | null => {
  if (!repository) {
    return null;
  }

  const slug = repository
    .trim()
    .replace(/^git\+/, '')
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/^git@github\.com:/i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');

  const segments = slug.split('/').filter(Boolean);
  if (segments.length < 2) {
    return null;
  }

  return `${GITHUB_BASE_URL}/${segments[0]}/${segments[1]}`;
};

/**
 * Builds the canonical URL for a referenced pull request or issue, or null
 * when no repository was supplied.
 */
export const referenceUrl = (
  reference: CommitReference,
  repository?: string,
): string | null => {
  const base = repositoryBaseUrl(repository);
  if (!base) {
    return null;
  }

  const segment = reference.kind === 'pull' ? 'pull' : 'issues';
  return `${base}/${segment}/${reference.number}`;
};

/**
 * Formats one commit as a Markdown list item, appending linked references.
 */
export const formatCommitLine = (
  commit: ParsedCommit,
  repository?: string,
): string => {
  const prefix = commit.breaking ? '**BREAKING** ' : '';
  const scope = commit.scope ? `**${commit.scope}:** ` : '';
  const references = commit.references
    .map((reference) => {
      const url = referenceUrl(reference, repository);
      return url ? `[#${reference.number}](${url})` : `#${reference.number}`;
    })
    .filter((value, index, all) => all.indexOf(value) === index)
    .join(', ');

  const suffix = references ? ` (${references})` : '';
  return `- ${prefix}${scope}${commit.subject}${suffix}`;
};

/** Formats a date (or ISO string) as YYYY-MM-DD for the changelog header. */
const formatDate = (date: string | Date): string | null => {
  const parsed = typeof date === 'string' ? new Date(date) : date;
  if (Number.isNaN(parsed.getTime())) {
    return typeof date === 'string' && date.trim() ? date.trim() : null;
  }

  return parsed.toISOString().slice(0, 10);
};

const commitCountLabel = (count: number): string =>
  `${count} commit${count === 1 ? '' : 's'}`;

const renderSection = (
  title: string,
  commits: ParsedCommit[],
  repository?: string,
): string => {
  if (commits.length === 0) {
    return `## ${title}\n\n_No changes._`;
  }

  const items = commits
    .map((commit) => formatCommitLine(commit, repository))
    .join('\n');

  return `## ${title}\n\n${items}`;
};

/**
 * Generates Markdown release notes from parsed commits.
 *
 * Breaking changes are surfaced in a dedicated leading section and are also
 * kept inside their category section so the notes remain scannable.
 */
export const generateReleaseNotes = (options: ReleaseNotesOptions): string => {
  const {
    version,
    date,
    repository,
    commits,
    includeEmptySections = false,
  } = options;

  const normalisedVersion = version.trim().replace(/^v/i, '');
  const header = normalisedVersion
    ? `# Release notes: v${normalisedVersion}`
    : '# Release notes';

  const formattedDate = date ? formatDate(date) : null;
  const summary = `_Generated from ${commitCountLabel(commits.length)}${
    formattedDate ? ` on ${formattedDate}` : ''
  }._`;

  const blocks: string[] = [header, summary];

  const breakingCommits = commits.filter((commit) => commit.breaking);
  if (breakingCommits.length > 0) {
    blocks.push(renderSection('Breaking Changes', breakingCommits, repository));
  }

  const groups: ReleaseNotesGroup[] = groupCommitsByCategory(
    commits,
    includeEmptySections,
  );
  groups.forEach((group) => {
    blocks.push(renderSection(group.title, group.commits, repository));
  });

  if (commits.length === 0) {
    blocks.push('_No changes found in the provided commit range._');
  }

  return blocks.join('\n\n');
};
