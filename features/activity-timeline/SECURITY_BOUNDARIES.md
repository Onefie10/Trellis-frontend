# Sensitive content boundaries

Activity timeline data is untrusted at every boundary. Keep these controls in
place when adding a renderer, webhook field, or export format:

- Render strings as React text. Do not add `dangerouslySetInnerHTML` for event
  titles, descriptions, or resource labels. Timeline text is redacted before it
  reaches the DOM, and resource links accept HTTP(S) or same-origin relative
  paths only.
- Run the event redactor before building CSV or JSON downloads. CSV cells are
  quoted and formula prefixes are neutralized. Do not pass raw events to an
  exporter or add raw event metadata to exported columns.
- Webhook payloads are JSON data, not markup. `formatWebhookPayload` removes
  blocked fields recursively, including alternate camelCase and punctuation
  spellings. Keep endpoint trigger checks before network dispatch.
- OTLP metric names must be in `SAFE_METRICS` by default. Attributes use the
  same sensitive-field boundary and scrub common email and Stellar-address
  values. The explicit unsafe-metric override is for controlled diagnostics;
  it must not be enabled for normal customer telemetry.

## Failure handling

If a regression test shows markup is rendered, a private value appears in a
download or webhook body, or a non-allowlisted metric leaves the client, disable
the affected export or webhook destination and stop sending the affected
telemetry. Preserve the failing fixture without real credentials, correct the
boundary helper, and rerun the focused security tests before restoring the
destination. Rotate any credential that was actually exposed; do not put its raw
value in a test fixture or issue report.

If content is unexpectedly removed, use the redaction badges/findings to
identify the rule, then add a narrowly scoped safe field or pattern test. Do not
weaken the general redaction rule to recover one field.
