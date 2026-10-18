'use client';

import React, { useState } from 'react';
import { Button } from '../../../components/Button';
import {
  ContractStateSchema,
  ParsedCommit,
  VersionMetadata,
} from '../types';
import { publishNewVersion } from '../services/versionRegistry';
import { isValidVersion } from '../lib/semver-utils';
import { ReleaseNotesEditor } from './ReleaseNotesEditor';

export interface ReleasePublisherProps {
  /** Version being published, e.g. "1.2.0". */
  version: string;
  /** Soroban contract ID the version points at. */
  contractId: string;
  /** Stellar address of the author publishing the release. */
  authorAddress: string;
  /** "owner/name" or a github.com URL; enables pull request / issue links. */
  repository?: string;
  /** Commits used to draft the release notes. */
  commits: ParsedCommit[];
  /** State schema of the version being published. */
  stateSchema: ContractStateSchema;
  /** Currently deployed version, used by the upgrade validation rules. */
  currentVersion?: VersionMetadata | null;
  onPublished?: (changelog: string) => void;
  onCancel?: () => void;
  className?: string;
}

type PublishStatus = 'idle' | 'publishing' | 'published' | 'error';

/**
 * Release flow for agent versions: authors review and customise the generated
 * release notes, then publish the changelog through the version registry.
 */
export const ReleasePublisher: React.FC<ReleasePublisherProps> = ({
  version,
  contractId,
  authorAddress,
  repository,
  commits,
  stateSchema,
  currentVersion,
  onPublished,
  onCancel,
  className,
}) => {
  const [changelog, setChangelog] = useState('');
  const [status, setStatus] = useState<PublishStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  const versionIsValid = isValidVersion(version);
  const canPublish =
    versionIsValid &&
    changelog.trim().length > 0 &&
    status !== 'publishing' &&
    status !== 'published';

  const handlePublish = async () => {
    setStatus('publishing');
    setError(null);

    try {
      await publishNewVersion(
        currentVersion ?? null,
        version,
        contractId,
        authorAddress,
        changelog,
        stateSchema,
      );
      setStatus('published');
      onPublished?.(changelog);
    } catch (publishError) {
      setError(
        publishError instanceof Error ? publishError.message : 'Failed to publish release.',
      );
      setStatus('error');
    }
  };

  return (
    <div className={className}>
      <ReleaseNotesEditor
        commits={commits}
        version={version}
        repository={repository}
        onChange={(notes) => setChangelog(notes)}
      />

      {!versionIsValid && (
        <p role="alert" className="mt-4 text-sm text-red-400">
          &quot;{version}&quot; is not a valid semantic version. Use the form x.y.z.
        </p>
      )}

      {error && (
        <p role="alert" className="mt-4 text-sm text-red-400">
          {error}
        </p>
      )}

      {status === 'published' && (
        <p role="status" className="mt-4 text-sm text-green-400">
          Release v{version.replace(/^v/i, '')} published with the reviewed changelog.
        </p>
      )}

      <div className="flex justify-end gap-3 mt-4">
        {onCancel && (
          <Button type="button" size="sm" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          onClick={handlePublish}
          disabled={!canPublish}
          className={!canPublish ? 'opacity-50 cursor-not-allowed' : undefined}
        >
          {status === 'publishing' ? 'Publishing…' : status === 'published' ? 'Published' : 'Publish Version'}
        </Button>
      </div>
    </div>
  );
};

export default ReleasePublisher;
