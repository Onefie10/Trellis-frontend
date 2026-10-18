# Cross-boundary trust decisions

This is a code-linked threat model for the frontend's highest-risk boundaries.
It records the current controls and the places where the frontend is still a
prototype; a client-side check is never a substitute for authorization in the
API or the connected service.

## Assets and trust boundaries

| Asset | Untrusted boundary | Abuse case | Current control and verification |
| --- | --- | --- | --- |
| Privileged API actions | Browser request to Next.js route | A caller edits a role header/body or replays an expired token to gain admin access | `lib/auth/actor.ts` verifies signed, expiring HMAC actor tokens. `lib/auth/guard.ts` resolves identity before route logic. `lib/permissions.ts` denies actions by default per role/scope. Covered by `tests/permissions-server.test.ts` and `tests/permissions.test.ts`. |
| User and operational records | API export request to data fetcher | A caller changes the wallet or export type to retrieve another user's records or private fields | `app/api/export/route.ts` checks `export_data`; `lib/export/streaming-export.ts` applies role-based field redaction, bounded batches, and cancellation. `lib/export/__tests__/streaming-export.test.ts` covers the export pipeline. |
| Imported JSON and webhook payloads | External client/service to API | Prototype-pollution keys, oversized payloads, replayed deliveries, or forged webhook data alter processing or internal state | `lib/security/content-sanitizer.ts` drops prototype keys in `sanitizeObject`; `lib/notifications/webhook.ts` bounds payload size and verifies signatures, timestamps, and replay IDs. `tests/__tests__/content-sanitizer.test.ts`, `tests/__tests__/webhook-verification.test.ts`, and `tests/__tests__/external-payload-corpus.test.ts` cover these boundaries. Validate signatures before acting on webhook payloads. |
| User-supplied rich text | Marketplace or proposal data to rendered DOM | Script tags, event handlers, or `javascript:` links execute in the application origin | `components/security/SafeContent.tsx` sanitizes before insertion and uses DOMPurify. `tests/__tests__/content-sanitizer.test.ts` covers unsafe markup and URL schemes. New rich-text surfaces must use this component rather than direct HTML insertion. |
| Third-party plugin code | Plugin to host page and browser capabilities | A plugin reads storage, invokes wallet signing, or sends messages outside its declared capabilities | `features/plugins/sandbox/manifestValidator.ts` validates declared capabilities and `features/plugins/sandbox/SandboxWrapper.ts` sets an iframe sandbox. `features/plugins/sandbox/__tests__/sandbox.test.ts` checks capability denial. **The current wrapper is a simulation, not a secure execution boundary:** it does not execute the supplied code in a real isolated runtime and does not yet validate message origins. Do not treat it as safe for arbitrary third-party code. |

## Authorization rules

- Resolve identity from the signed bearer token; do not accept a role, wallet
  owner, or actor id supplied only in a request body or query string.
- Keep the permission matrix as the authorization source for API routes. The
  caller's role does not imply ownership of the requested resource.
- Require explicit confirmation for actions whose permission entry declares
  `requires_confirmation`; reject the request if confirmation is absent.
- Check access before parsing or returning protected data where possible, and
  return the same not-found response when a resource must be hidden from an
  unauthorized actor.
- Keep export redaction and date-range limits server-side. UI hiding is not an
  access control.

## Failure and recovery

- If `PERMISSION_TOKEN_SECRET` is absent or invalid, actor resolution fails
  closed. Restore the secret from the deployment secret manager and issue new
  tokens; do not temporarily trust role headers.
- If a permission check denies access, verify the actor's signed role and
  resource scope. Do not widen a grant to work around a mismatched owner.
- If a webhook signature fails, quarantine or retry from the verified provider
  delivery; do not process the unsigned body manually.
- If export redaction or rich-text sanitization regresses, disable the affected
  export/render surface while restoring the failing boundary test.
- Until the plugin wrapper has real isolation and origin-checked messaging,
  disable execution for untrusted plugins and treat manifests as descriptive,
  not as proof that code is contained.

## Change-review checklist

For changes crossing one of these boundaries, add or update a negative test
that demonstrates the abuse case, identify the server-side enforcement point,
and document a recovery action. Avoid adding a control only in a React
component when the protected operation is served by an API route.
