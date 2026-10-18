/**
 * Represents the deployment status of a Soroban contract version on the Stellar ledger.
 */
export type VersionStatus = 'stable' | 'beta' | 'deprecated';

/**
 * Represents the data schema of the contract. 
 * Used to compare versions side-by-side and detect state schema changes.
 */
export interface ContractStateSchema {
  fields: Record<string, string>; // e.g., { "userBalance": "i128", "admin": "address" }
}

/**
 * Core metadata for a specific agent contract version stored on-chain.
 */
export interface VersionMetadata {
  version: string;             // Semantic versioning (e.g., "1.0.2")
  contractId: string;          // The actual Soroban contract ID on the network
  timestamp: number;           // Unix timestamp of deployment
  author: string;              // Stellar public key (address) of the deployer
  changelog: string;           // On-chain changelog entries
  status: VersionStatus;       // Marker for stable/beta/deprecated
  stateSchema: ContractStateSchema; 
}

/**
 * Represents a community voting proposal for scheduling an upgrade.
 */
export interface UpgradeProposal {
  proposalId: string;
  targetVersion: string;       // The version being proposed
  newContractId: string;       // The Soroban contract ID for the upgrade
  scheduledExecutionTime: number; // When the upgrade should happen if passed
  votesFor: number;
  votesAgainst: number;
  status: 'pending' | 'approved' | 'rejected' | 'executed';
}

/**
 * Changelog sections that commit messages are grouped into.
 * The order of the union is not meaningful; `CATEGORY_ORDER` in
 * `lib/changelog-parser.ts` defines the order sections are rendered in.
 */
export type CommitCategory =
  | 'features'
  | 'fixes'
  | 'performance'
  | 'documentation'
  | 'refactor'
  | 'tests'
  | 'build'
  | 'chores'
  | 'style'
  | 'reverts'
  | 'other';

/**
 * A pull request or issue referenced by a commit message.
 */
export type ReferenceKind = 'pull' | 'issue';

export interface CommitReference {
  kind: ReferenceKind;
  number: number;
}

/**
 * A single commit parsed from a Conventional Commits message / git log.
 */
export interface ParsedCommit {
  hash: string;                    // Short or full SHA, empty when the log has no hashes
  type: string | null;             // Conventional Commit type ("feat", "fix", ...) or null
  scope: string | null;            // Optional "feat(ui):" scope
  subject: string;                 // Description after the "type(scope): " prefix
  body: string;                    // Remaining lines of the commit message
  category: CommitCategory;        // Section the commit belongs to
  breaking: boolean;               // "!" flag or a "BREAKING CHANGE:" footer
  references: CommitReference[];   // Linked pull requests and issues, de-duplicated
  raw: string;                     // Original, untrimmed message
}

/**
 * A rendered changelog section: a category title plus its commits.
 */
export interface ReleaseNotesGroup {
  category: CommitCategory;
  title: string;
  commits: ParsedCommit[];
}

/**
 * Input for `generateReleaseNotes`.
 */
export interface ReleaseNotesOptions {
  version: string;
  date?: string | Date;
  /** "owner/name" (or a github.com URL) used to build pull request / issue links. */
  repository?: string;
  commits: ParsedCommit[];
  /** Render sections even when they have no commits. Defaults to false. */
  includeEmptySections?: boolean;
}
