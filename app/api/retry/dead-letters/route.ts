import { NextRequest, NextResponse } from "next/server";
import { deadLetterQueue, isOperationClass, type DeadLetterReason, type DeadLetterResolution } from "@/lib/retry";

/**
 * Dead-letter queue review endpoint — the maintainer-facing half of `lib/retry`.
 *
 * Without it, terminal failures accumulate in module memory with no way to list,
 * replay, or acknowledge them, which is the visibility gap this issue closes.
 *
 * Authorization: a shared-secret bearer token compared against
 * `DEAD_LETTER_ADMIN_TOKEN`. A role/permission matrix is the better long-term
 * answer, but it is a separate concern from retry scheduling and introducing one
 * here would couple two independently deployable concerns. Records carry caller
 * `context` (wallet addresses, operation ids), so they are not public.
 *
 * See `docs/retry-and-dead-letter.md` for the operator runbook and the
 * `DEAD_LETTER_ADMIN_TOKEN` deployment step.
 */

/** Reasons a record can exist, derived from the type so the two cannot drift. */
const DEAD_LETTER_REASONS: readonly DeadLetterReason[] = [
  "retries_exhausted",
  "non_retryable",
  "abandoned",
];

const DEAD_LETTER_RESOLUTIONS: readonly DeadLetterResolution[] = [
  "replayed",
  "discarded",
  "acknowledged",
];

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

/**
 * Length-independent string comparison.
 *
 * A naive `===` on a secret leaks its length and its common prefix through
 * timing, which is enough to enumerate a token character by character.
 */
function timingSafeEqual(a: string, b: string): boolean {
  const max = Math.max(a.length, b.length);
  let mismatch = a.length ^ b.length;
  for (let i = 0; i < max; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Gate for the whole route.
 *
 * Fails closed: if the token is unset the endpoint returns 503 rather than
 * silently serving every dead-letter record in the process.
 */
function authorize(request: NextRequest): NextResponse | null {
  const expected = process.env.DEAD_LETTER_ADMIN_TOKEN;

  if (!expected) {
    return NextResponse.json(
      {
        error: "not_configured",
        message: "DEAD_LETTER_ADMIN_TOKEN is not set; dead-letter review is disabled",
      },
      { status: 503 },
    );
  }

  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";

  if (!presented || !timingSafeEqual(presented, expected)) {
    return NextResponse.json(
      { error: "unauthorized", message: "A valid DEAD_LETTER_ADMIN_TOKEN bearer token is required" },
      { status: 401 },
    );
  }

  return null;
}

export async function GET(request: NextRequest) {
  const denied = authorize(request);
  if (denied) return denied;

  const { searchParams } = new URL(request.url);

  const reasonParam = searchParams.get("reason");
  const reason = DEAD_LETTER_REASONS.find((value) => value === reasonParam);
  if (reasonParam !== null && reason === undefined) {
    return NextResponse.json(
      { error: "invalid_reason", message: `\`reason\` must be one of ${DEAD_LETTER_REASONS.join(", ")}` },
      { status: 400 },
    );
  }

  // Validated through the policy registry rather than a hand-written list, which
  // is how the previous version of this route ended up accepting classes that
  // do not exist and silently ignoring the ones that do.
  const classParam = searchParams.get("operationClass");
  const operationClass = isOperationClass(classParam) ? classParam : undefined;
  if (classParam !== null && operationClass === undefined) {
    return NextResponse.json(
      { error: "invalid_operation_class", message: `\`operationClass\` must be a known operation class` },
      { status: 400 },
    );
  }

  const limitRaw = searchParams.get("limit");
  const limit = limitRaw === null ? DEFAULT_LIMIT : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return NextResponse.json(
      { error: "invalid_limit", message: `\`limit\` must be an integer between 1 and ${MAX_LIMIT}` },
      { status: 400 },
    );
  }

  const records = deadLetterQueue.list({
    reason,
    operationClass,
    includeResolved: searchParams.get("includeResolved") === "true",
    limit,
  });

  const stats = deadLetterQueue.stats();
  return NextResponse.json({
    records,
    stats,
    // Non-zero means records were evicted at capacity and this list is incomplete.
    droppedCount: stats.dropped,
  });
}

/**
 * Resolve a dead-lettered record.
 *
 * The outcome is validated against the allowed set and the caller cannot pass an
 * authorization decision of its own; a replay re-executes a failed side effect,
 * which is a stronger grant than merely reading the list.
 */
export async function POST(request: NextRequest) {
  const denied = authorize(request);
  if (denied) return denied;

  let body: { id?: unknown; outcome?: unknown; notes?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { error: "invalid_json", message: "Request body must be JSON" },
      { status: 400 },
    );
  }

  const { id, outcome, notes } = body;

  if (typeof id !== "string" || !id) {
    return NextResponse.json(
      { error: "invalid_id", message: "`id` must be a non-empty string" },
      { status: 400 },
    );
  }

  const resolution = DEAD_LETTER_RESOLUTIONS.find((value) => value === outcome);
  if (!resolution) {
    return NextResponse.json(
      { error: "invalid_outcome", message: `\`outcome\` must be one of ${DEAD_LETTER_RESOLUTIONS.join(", ")}` },
      { status: 400 },
    );
  }

  const record = deadLetterQueue.get(id);
  if (!record) {
    return NextResponse.json(
      { error: "not_found", message: `No dead-letter record with id "${id}"` },
      { status: 404 },
    );
  }
  if (record.resolution) {
    return NextResponse.json(
      { error: "already_resolved", message: `Record was already resolved as "${record.resolution}"` },
      { status: 409 },
    );
  }

  // `notes` is operator-authored free text that gets rendered in a triage view,
  // so it is length-bounded here rather than trusting every future caller.
  const resolutionNotes = typeof notes === "string" ? notes.slice(0, 2000) : undefined;
  const updated = deadLetterQueue.resolve(id, resolution, resolutionNotes);
  return NextResponse.json({ record: updated });
}
