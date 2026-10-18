'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../../../components/Button';
import { classNames } from '../../../lib/utils';
import { ParsedCommit } from '../types';
import { groupCommitsByCategory } from '../lib/changelog-parser';
import { generateReleaseNotes } from '../lib/release-notes';

export interface ReleaseNotesEditorProps {
  /** Commits used to generate the initial draft release notes. */
  commits: ParsedCommit[];
  /** Version being released, e.g. "1.2.0". */
  version: string;
  /** "owner/name" or a github.com URL; enables pull request / issue links. */
  repository?: string;
  /** Release date shown in the generated header. */
  date?: string | Date;
  /** Pre-existing notes (e.g. an already published changelog) to edit. */
  initialValue?: string;
  /** Called with the current Markdown whenever the author changes it. */
  onChange?: (markdown: string) => void;
  className?: string;
}

/** Renders inline `**bold**` and `[text](url)` tokens as React nodes. */
const renderInline = (text: string, keyPrefix: string): React.ReactNode[] => {
  const nodes: React.ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|_[^_\n]+_|\[[^\]]+\]\([^)]+\))/g;
  let lastIndex = 0;
  let index = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }

    const token = match[0];
    if (token.startsWith('**') && token.endsWith('**')) {
      nodes.push(<strong key={`${keyPrefix}-b-${index}`}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('_') && token.endsWith('_')) {
      nodes.push(<em key={`${keyPrefix}-i-${index}`}>{token.slice(1, -1)}</em>);
    } else {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      if (link) {
        nodes.push(
          <a
            key={`${keyPrefix}-a-${index}`}
            href={link[2]}
            target="_blank"
            rel="noreferrer"
            className="text-trellis-leaf underline"
          >
            {link[1]}
          </a>,
        );
      } else {
        nodes.push(token);
      }
    }

    lastIndex = pattern.lastIndex;
    index += 1;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
};

/** Minimal, dependency-free Markdown renderer for headings, lists and text. */
const renderMarkdown = (markdown: string): React.ReactNode => {
  const blocks: React.ReactNode[] = [];
  let listItems: string[] = [];

  const flushList = () => {
    if (listItems.length === 0) {
      return;
    }

    const items = listItems;
    listItems = [];
    blocks.push(
      <ul key={`list-${blocks.length}`} className="list-disc space-y-1 pl-5">
        {items.map((item, itemIndex) => (
          <li key={`item-${itemIndex}`}>{renderInline(item, `li-${blocks.length}-${itemIndex}`)}</li>
        ))}
      </ul>,
    );
  };

  markdown.split(/\r?\n/).forEach((line, lineIndex) => {
    const trimmed = line.trim();

    if (/^#{1,3}\s+/.test(trimmed)) {
      flushList();
      const level = trimmed.match(/^#+/)![0].length;
      const content = trimmed.replace(/^#+\s+/, '');
      const Heading = (level === 1 ? 'h2' : level === 2 ? 'h3' : 'h4') as 'h2' | 'h3' | 'h4';
      const headingClass =
        level === 1
          ? 'text-lg font-bold text-white'
          : level === 2
            ? 'text-base font-semibold text-blue-200'
            : 'text-sm font-semibold text-slate-300';

      blocks.push(
        <Heading key={`heading-${lineIndex}`} className={headingClass}>
          {renderInline(content, `heading-${lineIndex}`)}
        </Heading>,
      );
      return;
    }

    if (/^[-*]\s+/.test(trimmed)) {
      listItems.push(trimmed.replace(/^[-*]\s+/, ''));
      return;
    }

    if (!trimmed) {
      flushList();
      return;
    }

    flushList();
    blocks.push(
      <p key={`paragraph-${lineIndex}`} className="text-sm text-slate-300">
        {renderInline(trimmed, `paragraph-${lineIndex}`)}
      </p>,
    );
  });

  flushList();
  return blocks;
};

/**
 * Editable release-notes draft with a live Markdown preview.
 *
 * Notes are generated from the supplied commits and stay in sync with new
 * commit history until the author edits the textarea; afterwards the draft is
 * left untouched so manual customisations are never lost.
 */
export const ReleaseNotesEditor: React.FC<ReleaseNotesEditorProps> = ({
  commits,
  version,
  repository,
  date,
  initialValue,
  onChange,
  className,
}) => {
  const generatedNotes = useMemo(
    () => generateReleaseNotes({ version, date, repository, commits }),
    [version, date, repository, commits],
  );

  const [markdown, setMarkdown] = useState<string>(() => initialValue ?? generatedNotes);
  const [isCustomised, setIsCustomised] = useState<boolean>(Boolean(initialValue));
  const [copied, setCopied] = useState(false);

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Track commit history until the author takes over the draft.
  useEffect(() => {
    if (!isCustomised) {
      setMarkdown(generatedNotes);
    }
  }, [generatedNotes, isCustomised]);

  // Surface every draft change (generated or manual) to the parent.
  useEffect(() => {
    onChangeRef.current?.(markdown);
  }, [markdown]);

  const stats = useMemo(() => {
    const groups = groupCommitsByCategory(commits);
    return {
      sections: groups.length,
      breaking: commits.filter((commit) => commit.breaking).length,
    };
  }, [commits]);

  const handleChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    setIsCustomised(true);
    setMarkdown(event.target.value);
  };

  const handleRegenerate = () => {
    setIsCustomised(false);
    setMarkdown(generatedNotes);
    setCopied(false);
  };

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard?.writeText(markdown);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }, [markdown]);

  return (
    <section
      data-testid="release-notes-editor"
      className={classNames(
        'bg-slate-900 border border-indigo-500/30 rounded-xl p-6 shadow-[0_0_15px_rgba(28,107,85,0.2)] text-white',
        className,
      )}
    >
      <header className="mb-6">
        <h2 className="text-2xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-purple-500">
          Release Notes
        </h2>
        <p className="text-sm text-slate-400 mt-1">
          Draft for v{version.replace(/^v/i, '')} generated from {commits.length} commit
          {commits.length === 1 ? '' : 's'} across {stats.sections} section
          {stats.sections === 1 ? '' : 's'}
          {stats.breaking > 0 ? ` · ${stats.breaking} breaking` : ''}. Edit before publishing.
        </p>
      </header>

      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <label
            htmlFor="release-notes-markdown"
            className="block text-sm font-medium text-slate-300 mb-2"
          >
            Markdown
          </label>
          <textarea
            id="release-notes-markdown"
            aria-label="Release notes markdown"
            value={markdown}
            onChange={handleChange}
            rows={16}
            spellCheck={false}
            className="w-full bg-[#090b14] border border-slate-600 rounded px-3 py-2 text-white font-mono text-sm focus:outline-none focus:border-indigo-500"
          />
        </div>

        <div>
          <span className="block text-sm font-medium text-slate-300 mb-2">Preview</span>
          <div
            data-testid="release-notes-preview"
            aria-label="Release notes preview"
            className="space-y-2 bg-[#090b14] border border-slate-700 rounded px-4 py-3 min-h-[24rem] overflow-auto"
          >
            {renderMarkdown(markdown)}
          </div>
        </div>
      </div>

      <footer className="flex flex-wrap gap-3 mt-6">
        <Button type="button" size="sm" variant="outline" onClick={handleRegenerate}>
          Regenerate from commits
        </Button>
        <Button type="button" size="sm" variant="secondary" onClick={handleCopy}>
          {copied ? 'Copied' : 'Copy Markdown'}
        </Button>
      </footer>
    </section>
  );
};

export default ReleaseNotesEditor;
