import React, { useCallback, useMemo, useState } from 'react';
import {
  ContractStateSchema,
  ParsedCommit,
  ReleaseNotesOptions,
  VersionMetadata,
} from '../types';
import { publishNewVersion } from '../services/versionRegistry';
import { ReleaseNotesPreview } from './ReleaseNotesPreview';

interface ReleaseDraftPublisherProps {
  /** Currently deployed version, used for the semver upgrade validation. */
  currentVersion: VersionMetadata | null;
  /** Version being drafted. */
  nextVersion: string;
  /** Soroban contract ID for the new version. */
  contractId: string;
  /** Deployer address. */
  authorAddress: string;
  /** State schema of the new version. */
  stateSchema: ContractStateSchema;
  /** Commit history used to seed the draft. */
  commits: ParsedCommit[];
  /** Repository used to build pull request / issue links. */
  repository?: string;
  onPublished?: (changelog: string) => void;
}

/**
 * Wires the editable release-notes preview into the existing version publishing
 * flow: the reviewed Markdown is passed straight through to
 * `publishNewVersion`, so the on-chain changelog is exactly what the author saw.
 */
export const ReleaseDraftPublisher: React.FC<ReleaseDraftPublisherProps> = ({
  currentVersion,
  nextVersion,
  contractId,
  authorAddress,
  stateSchema,
  commits,
  repository,
  onPublished,
}) => {
  const [changelog, setChangelog] = useState('');
  const [status, setStatus] = useState<'idle' | 'publishing' | 'published' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const options: ReleaseNotesOptions = useMemo(
    () => ({
      version: nextVersion,
      repository,
      previousVersion: currentVersion?.version,
      date: new Date().toISOString().slice(0, 10),
    }),
    [nextVersion, repository, currentVersion],
  );

  const handleChange = useCallback((markdown: string) => {
    setChangelog(markdown);
  }, []);

  const handlePublish = async () => {
    setStatus('publishing');
    setErrorMessage(null);

    try {
      await publishNewVersion(
        currentVersion,
        nextVersion,
        contractId,
        authorAddress,
        changelog,
        stateSchema,
      );
      setStatus('published');
      onPublished?.(changelog);
    } catch (error) {
      setStatus('error');
      setErrorMessage(
        error instanceof Error ? error.message : 'Failed to publish the agent version.',
      );
    }
  };

  return (
    <div className="space-y-4">
      <ReleaseNotesPreview commits={commits} options={options} onChange={handleChange} />

      <div className="bg-slate-900 border border-indigo-500/30 rounded-xl p-6 text-white">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-slate-400">
            The generated Markdown is submitted as the on-chain changelog for v{nextVersion}.
          </p>
          <button
            type="button"
            onClick={handlePublish}
            disabled={status === 'publishing' || changelog.trim().length === 0}
            className="px-6 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed rounded-md font-medium shadow-[0_0_10px_rgba(79,70,229,0.3)] transition-colors"
          >
            {status === 'publishing' ? 'Publishing…' : `Publish v${nextVersion}`}
          </button>
        </div>

        {status === 'published' && (
          <p className="mt-3 text-sm text-green-400">Release notes published successfully.</p>
        )}
        {status === 'error' && errorMessage && (
          <p className="mt-3 text-sm text-red-400">{errorMessage}</p>
        )}
      </div>
    </div>
  );
};

export default ReleaseDraftPublisher;
