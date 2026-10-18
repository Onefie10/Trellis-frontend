

# Support access

`POST /api/support-access` provides an authenticated lifecycle for scoped
support sessions. It accepts `start`, `authorize`, `audit`, and `end` actions.
Every request must use a signed actor token, and every mutation requires
`confirm: true`. The permission matrix currently grants impersonation to admins
only; maintainers and other roles are denied. A session is tied to the actor who
created it, so another administrator cannot end it or read its audit events.

Sessions default to read-only, expire after at most 30 minutes, and have a
reason recorded at creation. The `authorize` action checks the requested action
against the session scope and appends both allowed and blocked attempts to
the session audit history. Callers must check this endpoint before exposing a
support-session action; it does not itself execute operations as the target
user. The start response includes a target-facing notice string for the UI
to surface while support access is active.

The manager returns detached snapshots instead of mutable internal objects,
rejects audit writes after a session ends, and retains expired sessions so their
events are not removed by cleanup. This manager is currently process-local
memory. A deployment that needs audit history to survive restarts or multiple
instances must replace the in-memory manager with an append-only durable store
before treating it as a compliance record.

If actor-token verification is unavailable, the route fails closed. If a
support action is denied or a session expires, end the session and start a new
one with the minimum scope and duration needed. Never retry a blocked action by
raising the session scope without a new explicit confirmation.

## Audit evidence bundles

Support investigations often need to be shared with people who do not have
direct access to the running system (security reviewers, customer success
escalations, incident responders). The evidence bundle exporter produces a
self-contained, privacy-preserving snapshot of a support session so that
[behaviour can be verified](#verification) without revealing secrets or PII.

The exporter is a pure function over the detached session snapshot returned by
the manager. It never reads internal mutable state, never fetches new data, and
does not change the lifecycle of the session. Exporting is a side-effect-free
operation and is safe to repeat.

### Bundle shape

A bundle is a JSON object with a versioned schema:

```json
{
  "schemaVersion": 1,
  "generatedAt": "2024-01-01T00:00:00.000Z",
  "session": {
    "id": "<session id>",
    "status": "active",
    "reason": "<redacted or preserved>",
    "scope": ["read"],
    "createdAt": "2024-01-01T00:00:00.000Z",
    "expiresAt": "2024-01-01T00:30:00.000Z",
    "endedAt": null,
    "actorId": "<actor id>",
    "targetId": "<target id>",
    "actorIdHash": "<sha256 of actor id>",
    "targetIdHash": "<sha256 of target id>"
  },
  "events": [
    {
      "index": 0,
      "at": "2024-01-01T00:00:00.000Z",
      "action": "start",
      "outcome": "allowed",
      "actionHash": "<sha256 of action>",
      "detailsHash": "<sha256 of canonicalized details>",
      "detailsRedacted": true
    }
  ],
  "eventChainHash": "<sha256 chain over all events>",
  "redaction": {
    "policy": "default",
    "redactedFields": ["session.reason", "events.[].details"],
    "hashedFields": ["session.actorId", "session.targetId", "events.[].action"]
  }
}
```

Every bundle carries the following guarantees:

- **No secrets or PII are emitted in cleartext.** Raw identifiers, action names,
  and free-form details are either hashed or omitted. The redaction manifest
  records exactly which fields were redacted vs. hashed so a reviewer knows what
  was withheld.
- **Behaviour remains verifiable.** Timestamps, session and event identity,
  outcomes (allowed/blocked), and a hash chain over the event sequence are
  preserved. Two bundles from the same session produce identical chain hashes.
- **Identity is correlatable without being disclosed.** Actor and target ids
  are replaced by salted SHA-256 digests. The same id within one bundle always
  hashes to the same value, so a reviewer can tell whether two events involve
  the same actor without learning who that actor is.

### Redaction policy

The default policy applies the following rules. Any field not listed here is
dropped entirely rather than guessed at.

| Field                | Treatment                                         |
| ---------------------| ---------------------------------------------------------|
| `session.id`        | Preserved (opaque identifier).                           |
| `session.status`     | Preserved.                                                |
| `session.scope`      | Preserved.                                                |
| `session.reason`     | Redacted; replaced with `"[redacted]"`.                       |
| `session.createdAt/expiresAt/endedAt` | Preserved (ISO 8601 timestamps).                       |
| `session.actorId`   | Hashed; raw value never emitted.                             |
| `session.targetId` | Hashed; raw value never emitted.                             |
| `events.[].action` | Hashed; outcome and index are preserved.                      |
| `events.[].details` | Redacted; only a details hash is emitted.                      |

Hashing uses salted SHA-256 with a per-bundle salt derived from the session id
so that hashes are stable within a bundle but not comparable across bundles.
This prevents cross-bundle correlation attacks while still allowing intra-bundle
correlation. Timestamps are normalized to ISO 8601 UTC before historical comparison.

### Verification

The bundle is verifiable without access to the source system:

1. Check `schemaVersion` is a known value.
2. Recompute the event chain hash from the events array in index order and compare
   it to `eventChainHash`. A mismatch means the bundle was tampered with or the
   source session was mutated out of band.
3. Confirm every event index is contiguous starting at 0 and that event timestamps
   are non-decreasing.
4. Confirm the redaction manifest lists every field that was redacted or hashed.

The chain hash is computed over the canonical JSON representation of each
redacted event (keys sorted, no whitespace), folded in index order into a rolling
SHA-256 digest. This makes the hash reproducible in any language that can
serialize JSON deterministically.

### Operational edge cases

- **Session still active.** Exporting an active session is allowed and produces a
  snapshot of the events so far. The bundle records `status: "active"` and
  `endedAt: null`; it must not be treated as a complete record of the session.
  Re-export after the session ends to obtain the final chain.
- **Empty event list.** A session with no audit events exports an empty `events`
  array and a chain hash over the empty sequence. This is valid and verifies as a
  trivially consistent chain.
- **Expired but retained sessions.** Expired sessions are retained by the manager, so
  they remain exportable. Expiration does not alter the bundle content.
- **Unknown fields.** Fields the exporter does not recognize are dropped and
  noted in the redaction manifest under `redaction.redactedFields`. This fails
  closed: new sensitive fields are never leaked by default.
- **Missing or malformed timestamps.** Export fails with a validation error rather
  than emitting a bundle with unverifiable timelines.

### Failure modes

- **Export fails on invalid session snapshot.** Return a structured error to the
  caller; do not partially emit a bundle. No file is written and no audit event is
  appended.
- **Export fails on unsupported schema version.** The exporter refuses to downgrade
  or upgrade silently; the caller must use a matching exporter version.
- **Downstream consumer rejects the bundle.** Verify the chain hash and
  manifest before using the bundle as evidence. A failed verification means the
  bundle is untrusted; request a fresh export from the source system.

### Rollback and recovery

Exporting is read-only and has no side effects on session state, so rollback is
simply discarding the generated bundle. To recover from a bad export:

1. Discard the bundle and any copies distributed from it.
2. Confirm the source session still exists in the manager (expired sessions are
   retained, but a process restart on the in-memory manager will lose it).
3. Re-export from the source session. If the source session is gone, the evidence
   cannot be recreated from the in-memory manager and must be treated as lost.

Any changes to the redaction policy must bump `schemaVersion` and keep the
previous exporter available so existing bundles remain verifiable. Never rewrite a
bundle in place; always emit a new bundle with a new `generatedAt` timestamp.

