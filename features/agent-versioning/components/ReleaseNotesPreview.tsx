import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ParsedCommit, ReleaseNotesOptions } from '../types';
import { generateReleaseNotes } from '../lib/release-notes';
import { classNames } from '@/lib/utils';

interface ReleaseNotesPreviewProps {
  /** Commit history used to seed the generated draft. */
  commits: ParsedCommit[];
  /** Version metadata used for the Markdown header and reference links. */
  options: ReleaseNotesOptions;
  /** Optional controlled value. When provided the parent owns the Markdown. */
  value?: string;
  /** Called with the current Markdown whenever it is generated or edited. */
  onChange?: (markdown: string) => void;
  /** Called specifically after "Regenerate from commits" is pressed. */
  onRegenerate?: (markdown: string) => void;
  className?: string;
}

/**
 * Renders Markdown release notes as a lightweight, dependency-free preview.
 * Only the subset emitted by `generateReleaseNotes` is interpreted, which keeps
 * the component free of a full Markdown renderer.
 */
const MarkdownPreview: React.FC<{ markdown: string }> = ({ markdown }) => (
  <div className="space-y-1 text-sm leading-relaxed" data-testid="release-notes-preview">
    {markdown.split(/\r?\n/).map((line, index) => {
      if (line.startsWith('### ')) {
        return (
          <h3 key={index} className="text-sm font-semibold text-blue-200 pt-2">
            {line.slice(4)}
          </h3>
        );
      }
      if (line.startsWith('## ')) {
        return (
          <h2 key={index} className="text-base font-bold text-blue-300 pt-3">
            {line.slice(3)}
          </h2>
        );
      }
      if (line.startsWith('# ')) {
        return (
          <h1
            key={index}
            className="text-lg font-bold text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-purple-500"
          >
            {line.slice(2)}
          </h1>
        );
      }
      if (line.startsWith('- ')) {
        return (
          <div key={index} className="pl-4 text-slate-300">
            <span className="text-indigo-400 mr-2">•</span>
            {line.slice(2)}
          </div>
        );
      }
      if (line.trim() === '') return null;
      return (
        <p key={index} className="text-slate-400 italic">
          {line}
        </p>
      );
    })}
  </div>
);

/**
 * Editable release-notes preview shown before a version is published. The draft
 * is generated from commit history and kept in sync until the author edits it,
 * so manual customisations are never silently overwritten.
 */
export const ReleaseNotesPreview: React.FC<ReleaseNotesPreviewProps> = ({
  commits,
  options,
  value,
  onChange,
  onRegenerate,
  className,
}) => {
  const generated = useMemo(
    () => generateReleaseNotes(commits, options),
    [commits, options],
  );

  const isControlled = value !== undefined;
  const [markdown, setMarkdown] = useState<string>(value ?? generated);
  const [edited, setEdited] = useState<boolean>(isControlled);

  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  // Keep an unedited draft in sync with the commit history / selected version.
  useEffect(() => {
    if (isControlled || edited) return;
    setMarkdown(generated);
    onChangeRef.current?.(generated);
  }, [generated, isControlled, edited]);

  const currentValue = isControlled ? value : markdown;

  const handleChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const next = event.target.value;
    setEdited(true);
    if (!isControlled) setMarkdown(next);
    onChangeRef.current?.(next);
  };

  const handleRegenerate = () => {
    setEdited(false);
    if (!isControlled) setMarkdown(generated);
    onChangeRef.current?.(generated);
    onRegenerate?.(generated);
  };

  return (
    <div
      className={classNames(
        'bg-slate-900 border border-indigo-500/30 rounded-xl p-6 shadow-[0_0_15px_rgba(28,107,85,0.2)] text-white',
        className,
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <h2 className="text-2xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-purple-500">
          Release Notes Preview
        </h2>
        <button
          type="button"
          onClick={handleRegenerate}
          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 rounded-md text-sm font-medium transition-colors shadow-[0_0_10px_rgba(79,70,229,0.3)]"
        >
          Regenerate from commits
        </button>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <label
            htmlFor="release-notes-markdown"
            className="block text-sm font-medium text-slate-300 mb-2"
          >
            Markdown (editable)
          </label>
          <textarea
            id="release-notes-markdown"
            value={currentValue}
            onChange={handleChange}
            rows={16}
            spellCheck={false}
            className="w-full bg-[#090b14] border border-slate-600 rounded-lg px-4 py-3 text-sm font-mono text-slate-200 focus:outline-none focus:border-indigo-500 resize-y"
          />
        </div>

        <div>
          <span className="block text-sm font-medium text-slate-300 mb-2">Preview</span>
          <div className="bg-[#090b14] border border-slate-700 rounded-lg px-4 py-3 max-h-[22rem] overflow-auto">
            <MarkdownPreview markdown={currentValue} />
          </div>
        </div>
      </div>
    </div>
  );
};

export default ReleaseNotesPreview;
