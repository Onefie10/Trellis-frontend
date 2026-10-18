# External payload regression corpus

`tests/fixtures/external-payloads/corpus.json` is a credential-free set of adversarial webhook and API response examples. The corpus covers missing required headers, malformed and invalid signatures, payload and event-ID size limits, replayed event IDs, and a response that has drifted from its API contract. `tests/__tests__/external-payload-corpus.test.ts` runs every fixture through the production webhook verifier or contract validator.

## Operational behavior

Webhook payloads are limited to 1 MiB by default, and event IDs are limited to 200 characters. The verifier checks required signature fields, payload and identifier limits, strict integer timestamps, the timestamp window, duplicate delivery, and the HMAC before marking an event ID as processed. Keep webhook handling fail-closed: do not process an event after a verification error. If a provider legitimately needs larger payloads, assess the memory and request limits first, then pass a deliberate `maxPayloadBytes` override and add a boundary fixture.

Replay detection is held in process memory and bounded to avoid unbounded growth. It is useful for duplicate deliveries to one process, but it is not a distributed or durable idempotency store. Multi-instance deployments that require cross-instance replay protection should use a shared TTL-backed store before processing side effects. A process restart clears the in-memory replay set.

If a fixture fails after a provider or API schema change, retain the sanitized failing fixture, confirm the upstream contract, and update the schema and expected behavior together. Do not put production secrets, signed real payloads, personal data, or live account identifiers in fixtures. To roll back the size guard, revert the verifier and its tests together; continue requiring valid signatures and timestamps. To recover from a bad contract fixture, restore the last known response contract and rerun the focused corpus test.

Run the fixture check with the repository test runner: `npx jest tests/__tests__/external-payload-corpus.test.ts --runInBand`. No fixture needs network access or external credentials.
