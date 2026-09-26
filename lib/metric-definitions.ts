/**
 * Metric Definitions & Privacy Boundaries
 *
 * Documents safe metrics and retention behavior.
 */

export const SAFE_METRICS = {
  // User engagement
  "user.session_start": "User starts a session",
  "user.session_end": "User ends a session",
  "user.feature_used": "User accesses a feature",
  "user.interaction_count": "Number of interactions in a session",

  // Transaction flow
  "transaction.initiated": "User starts a transaction",
  "transaction.completed": "Transaction succeeds",
  "transaction.failed": "Transaction fails",
  "transaction.time_to_complete": "Time taken to complete transaction",

  // System health
  "system.api_call": "API call made",
  "system.api_error": "API error occurred",
  "system.performance": "System performance metric",
  "system.network_latency": "Network latency measurement",

  // Error tracking
  "error.client_error": "Client-side error",
  "error.validation_error": "Validation error",
  "error.network_error": "Network error",
  "error.auth_error": "Authentication error",

  // Wallet operations
  "wallet.connection_attempt": "Wallet connection attempt",
  "wallet.connection_success": "Successful wallet connection",
  "wallet.disconnection": "Wallet disconnection",

  // Feature adoption
  "feature.tutorial_started": "User starts tutorial",
  "feature.tutorial_completed": "User completes tutorial",
  "feature.feature_enabled": "Feature is enabled",
  "feature.feature_disabled": "Feature is disabled",
};

export const BLOCKED_FIELDS = [
  "password",
  "secret",
  "token",
  "api_key",
  "private_key",
  "seed",
  "mnemonic",
  "wallet_private_key",
  "email",
  "phone",
  "ssn",
  "credit_card",
  "wallet_address",
  "public_key",
  "signature",
  "payload",
  "transaction_data",
  "user_id",
  "email_address",
  "phone_number",
];

export const RETENTION_POLICY = {
  aggregated_metrics: "90 days",
  error_logs: "30 days",
  performance_data: "7 days",
  user_events: "90 days",
} as const;

/**
 * Check if a metric is safe to record
 */
export function isMetricSafe(metricName: string): boolean {
  return metricName in SAFE_METRICS;
}

/**
 * Check if a field name is safe to include
 */
export function isFieldSafe(fieldName: string): boolean {
  const lowerField = fieldName.toLowerCase();
  return !BLOCKED_FIELDS.some((blocked) => lowerField.includes(blocked));
}

/**
 * Get metric description
 */
export function getMetricDescription(metricName: string): string {
  return SAFE_METRICS[metricName as keyof typeof SAFE_METRICS] || "Unknown metric";
}
