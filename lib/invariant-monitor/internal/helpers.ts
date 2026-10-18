/**
 * Field readers and predicates shared by the invariant modules.
 *
 * Every helper here is total: it returns a nullish "unknown" result rather
 * than throwing, because a monitor that crashes on malformed input cannot
 * report that the input is malformed.
 */

import { STELLAR_ADDRESS_RE } from '../../affiliate-store';
import type { InvariantViolation, MonitorRecord, OffendingRecord, Severity } from '../types';

export const UNKNOWN_ID = 'UNKNOWN';

/** Reads a field as a non-empty string, trimming surrounding whitespace. */
export function readString(record: MonitorRecord, field: string): string | null {
  const value = record[field];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** Reads a field as a finite number. Numeric strings are accepted and parsed. */
export function readNumber(record: MonitorRecord, field: string): number | null {
  const value = record[field];
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export function readBoolean(record: MonitorRecord, field: string): boolean | null {
  const value = record[field];
  if (typeof value === 'boolean') return value;
  return null;
}

/**
 * Resolves the identifier used to report an offending record.
 *
 * Falls back to a positional placeholder so a failure is still reported when
 * the corruption is precisely that the identifier is missing.
 */
export function readId(record: MonitorRecord, index = 0): string {
  return readString(record, 'id') ?? `${UNKNOWN_ID}[${index}]`;
}

/** Parses an ISO-8601-ish timestamp to epoch millis, or null when unusable. */
export function readTimestamp(record: MonitorRecord, field: string): number | null {
  const raw = readString(record, field);
  if (raw === null) return null;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : parsed;
}

/** True when the value is a syntactically valid Stellar account address. */
export function isStellarAddress(value: unknown): boolean {
  return typeof value === 'string' && STELLAR_ADDRESS_RE.test(value);
}

/**
 * Parses a monetary amount.
 *
 * Deliberately stricter than `parseFloat`, which accepts trailing garbage
 * (`"150.00oops"` -> `150`) and would let a corrupted amount read as valid.
 * `Number()` accepts only a complete numeric literal.
 */
export function parseAmount(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Parses a stroop-denominated integer amount without losing precision. */
export function parseStroops(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value;
  const raw = typeof value === 'number' ? String(value) : value;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) return null;
  try {
    return BigInt(trimmed);
  } catch {
    return null;
  }
}

/** Builds a handle to an offending record for the report. */
export function offending(
  entityType: string,
  entityId: string,
  detail: string,
  field?: string
): OffendingRecord {
  return field === undefined
    ? { entityType, entityId, detail }
    : { entityType, entityId, field, detail };
}

/** Assembles a violation. `remediation` defaults to the invariant-level guidance. */
export function violation(
  severity: Severity,
  message: string,
  records: OffendingRecord[],
  options: { remediation?: string; details?: Record<string, unknown> } = {}
): InvariantViolation {
  const base: InvariantViolation = {
    severity,
    message,
    remediation: options.remediation ?? '',
    records,
  };
  return options.details ? { ...base, details: options.details } : base;
}

/** Indexes records by a field, keeping every entry that shares the key. */
export function groupByField(
  records: readonly MonitorRecord[],
  field: string
): Map<string, { record: MonitorRecord; index: number }[]> {
  const grouped = new Map<string, { record: MonitorRecord; index: number }[]>();
  records.forEach((record, index) => {
    const key = readString(record, field);
    if (key === null) return;
    const bucket = grouped.get(key);
    if (bucket) bucket.push({ record, index });
    else grouped.set(key, [{ record, index }]);
  });
  return grouped;
}

/** Collects the non-null values of a field across records. */
export function collectStrings(records: readonly MonitorRecord[], field: string): string[] {
  const values: string[] = [];
  for (const record of records) {
    const value = readString(record, field);
    if (value !== null) values.push(value);
  }
  return values;
}

/** Stable, human-readable rendering of an unknown value for messages. */
export function display(value: unknown): string {
  if (typeof value === 'string') return `'${value}'`;
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}
