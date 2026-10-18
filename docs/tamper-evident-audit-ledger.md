# Tamper-evident audit ledger

The security API records confirmed administrator audit events in a per-contract chain. The affiliate payout route records queued and rejected payout requests in a per-wallet chain. Each entry includes a server timestamp, sequence number, event category, producer/actor, payload, previous hash, and SHA-256 hash over RFC 8785 canonical JSON with the `trellis.audit-ledger.v1` domain prefix.

`POST /api/security` keeps its existing `record-audit` and `audit-history` response fields. Audit-history responses add a `ledger` export containing the entries for that contract, the chain head, and a verification result. The `ledger-export` action can export a selected stream for maintainer review. Consumers should verify the export before relying on it.

## Privacy-preserving evidence bundles

Support investigations often need to share audit history without exposing secrets or personally identifiable information (PII). The evidence bundle export is a redacted, self-contained JSON document that preserves the integrity signals needed to verify behavior while removing sensitive values.

The bundle is produced from a verified ledger export and is structured as follows:

- `bundleVersion`: the bundle schema version (`trellis.audit-evidence.v1`).
- `source`: the ledger stream identifier (contract or wallet), producer, and the chain head hash and sequence number as reported by the ledger.
- `summary`: entry count, first and last sequence numbers, and the first and last server timestamps.
- `verification`: the verification result from the ledger export (valid/invalid, plus the first failing sequence number when invalid).
- `entries`: one object per ledger entry containing only the fields needed to verify the chain and the redacted payload.
- `redaction`: a manifest describing which fields were redacted, the redaction policy version, and the hash algorithm used for replacement values.

Each entry in `entries` preserves the following integrity fields unchanged:

- `sequence` and `previousHash` so the chain linkage can be recomputed.
- `timestamp` so ordering and clock behavior can be checked.
- `eventCategory` and `producer` so the kind of activity is verifiable.
- `entryHash` so the hash of the original entry can be compared against the redacted payload hash recorded in the manifest.

Payloads are redacted by replacing sensitive values with a stable marker and a hash of the original value. The marker is of the form `[redacted:<sha256>]`, where `<sha256>` is the hex digest of the canonical value. This allows two bundles to be correlated on the same secret without revealing it, and allows a maintainer to confirm a known value matches without the bundle containing it.

The redaction policy covers at least the following classes of values whenever they appear in a payload:

- wallet addresses and destinations;
- signatures and signed messages;
- authentication tokens, API keys, and session identifiers;
- email addresses, display names, and other account identifiers;
- raw provider error text and provider request identifiers.

Values that are already public identifiers (for example, a contract id or a public chain id) are retained. When the redaction policy is unsure whether a field is sensitive, it redacts the field and records the field path in the manifest rather than guessing.

## Verifying a bundle

A receiver can verify a bundle without trusting the sender:

1. Recompute the canonical JSON and SHA-256 hash of each redacted entry using the domain prefix and compare it to the entry hash recorded in the manifest.
2. Check that each entry's `previousHash` matches the preceding entry's hash and that sequence numbers increase by one.
3. Check that the last entry hash equals the chain head recorded in `source`.
4. Confirm that every redacted value is well-formed and that the manifest lists every redacted field path.

A valid bundle proves that the redacted stream is internally consistent and matches the reported head. It does not prove that the stream is complete or that no entries were dropped before the first exported entry; compare the first sequence number and timestamp against a trusted checkpoint when one exists.

## Automated verification

The bundle builder and verifier are covered by unit tests under `features/activity-timeline/redaction/`. Tests exercise: canonical JSON hashing with the domain prefix, chain linkage recomputation, head-hash comparison, redaction marker well-formedness, and manifest completeness. Run `npm test -- features/activity-timeline/redaction` to execute the suite locally. A failing verification test indicates either a redaction policy regression or a chain-integrity bug; treat both as blocking.

Before pushing, run a local syntax/type check on the redaction modules (for example `npx tsc --noEmit` or the repository's Syntax and Boot / Jest load check). A parse error such as `TS1434: Unexpected keyword or identifier` or `TS1005: ';' expected` in `exporter.ts` or `redactor.ts` means the module will fail to load in Jest and must be fixed before review; do not rewrite the whole file to resolve it — remove the stray token or duplicate declaration at the reported line and column. The same applies to `features/activity-timeline/types.ts`: a `TS1128: Declaration or statement expected` error there indicates a stray token or duplicate declaration (for example an extra closing brace or a repeated type export) and must be corrected at the reported line before review.

## Failure handling and recovery

- A sequence or hash mismatch invalidates the stream from the first bad entry. Preserve the export and investigate; do not silently truncate or rebuild the chain.
- Sequence numbers define order. Server timestamps are forced to increase within a stream when the system clock repeats or moves backwards.
- Payout replays do not append duplicate `queued` events. Rejected payout attempts are recorded with a stable error code and no provider error text.
- The current storage is process-local memory, matching the existing security and affiliate stores. Restarting the process or routing requests to another instance can yield a shorter or different chain. This is useful for tamper detection within an instance lifetime, but is not durable compliance storage.
- Before production use for financial controls, persist entries in an append-only database transaction and store signed or externally anchored head hashes. Keep exports and the last trusted head outside the application process.
- For recovery, retain the original export, compare its head with the last trusted checkpoint, and restore from an independently verified copy. If no trusted checkpoint exists, report the gap and start a new versioned stream; never claim the reconstructed history is complete.
- To roll back this feature, first export and retain each stream. Rolling back application code does not restore process-local entries.

The existing audit record and payout response schemas remain unchanged except for additive ledger metadata in the security API responses and the additive evidence bundle export action. Wallet destinations, signatures, and raw provider errors are not added to ledger payloads and are redacted from evidence bundles.
