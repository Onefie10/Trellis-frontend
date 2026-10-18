# Public service status

`/status` is a read-only public page backed by `/api/public-status`. The API returns only an allowlisted status, update time, affected-service count, and fixed user-safe message. Probe URLs, raw errors, and telemetry fields stay on the operational dashboard.

The endpoint refreshes the shared synthetic-probe snapshot at most once every 30 seconds. The page polls at the same interval. A failed request is shown as unavailable rather than as healthy.

Set the server-only `TRELLIS_PUBLIC_STATUS_MODE` to `paused` or `maintenance` during a planned pause or maintenance window. Remove the value and restart the service to return to probe-derived status. Unknown values are ignored. Probe degradation remains visible when no override is set.

If probe configuration is wrong, the public status can report degradation even while the application is serving users. Correct the server-side probe target and verify the operational dashboard before clearing the override; never put credentials in public status messages or client environment variables.
