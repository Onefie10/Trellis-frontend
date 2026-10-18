/**
 * Authorization invariants — who was permitted to do what.
 *
 * These mirror the deny-rules in `lib/policy-engine.ts` and check them against
 * a recorded decision log. The policy engine evaluates correctly in-process,
 * but nothing persisted the outcomes, so a snapshot is the only place a
 * post-hoc question like "was this payout request authorised?" can be answered.
 *
 * The two modules are kept in step deliberately: if a rule is added to the
 * policy engine, a matching invariant should be added here, and
 * `tests/__tests__/invariant-monitor.test.ts` asserts the two vocabularies
 * still agree.
 */

import { defaultBusinessPolicy } from '../../policy-engine';
import {
  collectStrings,
  display,
  offending,
  parseStroops,
  readId,
  readString,
  violation,
} from '../internal/helpers';
import type { InvariantDefinition, MonitorRecord } from '../types';

/** Mirrors `ActorRole` in lib/policy-engine.ts. */
const ALLOWED_ROLES = ['admin', 'maintainer', 'user', 'guest'] as const;

/** Mirrors `PolicyAction` in lib/policy-engine.ts. */
const ALLOWED_ACTIONS = [
  'create_agent',
  'transfer_funds',
  'invite_collaborator',
  'escalate_role',
  'retry_operation',
  'impersonate_user',
] as const;

/** Only admins may impersonate. Mirrors rule `impersonation_admin_only`. */
const ADMIN_ONLY_ACTIONS = ['impersonate_user', 'escalate_role'] as const;

/** Mirrors rule `guest_no_create`. */
const GUEST_DENIED_ACTIONS = ['create_agent'] as const;

function evaluateAuthorizationEvents(
  dataset: { authorizationEvents: readonly MonitorRecord[] },
  check: (record: MonitorRecord, index: number) => ReturnType<typeof violation> | null
) {
  const violations = [];
  for (const [index, record] of dataset.authorizationEvents.entries()) {
    const result = check(record, index);
    if (result) violations.push(result);
  }
  return { evaluatedRecords: dataset.authorizationEvents.length, violations };
}

/** The decision log must use the policy engine's own vocabulary. */
const rolesAndActionsRecognized: InvariantDefinition = {
  id: 'AUTH-001',
  domain: 'authorization',
  title: 'Authorization records use recognized roles and actions',
  description:
    'Every `authorizationEvents` entry has an `actorRole` in the policy engine role union and an `action` in its action union.',
  rationale:
    'An unrecognized role or action cannot be re-evaluated against the policy engine, so the record is unusable as evidence. It usually means the caller and the engine have drifted apart.',
  severity: 'error',
  remediation:
    'Re-derive the decision by replaying the event through evaluatePolicy. Update the caller if the engine gained or renamed a role or action.',
  evaluate(dataset) {
    return evaluateAuthorizationEvents(dataset, (record, index) => {
      const id = readId(record, index);
      const role = readString(record, 'actorRole');
      const action = readString(record, 'action');

      const records = [];
      if (role === null) {
        records.push(offending('AuthorizationEvent', id, 'actorRole is missing', 'actorRole'));
      } else if (!(ALLOWED_ROLES as readonly string[]).includes(role)) {
        records.push(offending('AuthorizationEvent', id, `unrecognized actorRole '${role}'`, 'actorRole'));
      }
      if (action === null) {
        records.push(offending('AuthorizationEvent', id, 'action is missing', 'action'));
      } else if (!(ALLOWED_ACTIONS as readonly string[]).includes(action)) {
        records.push(offending('AuthorizationEvent', id, `unrecognized action '${action}'`, 'action'));
      }

      if (records.length === 0) return null;
      return violation(
        'error',
        `Authorization record ${id} has unrecognized role/action: ${display(role)} / ${display(action)}.`,
        records,
        { details: { allowedRoles: ALLOWED_ROLES, allowedActions: ALLOWED_ACTIONS } }
      );
    });
  },
};

/** Privileged actions must have been taken by an admin. */
const privilegedActionsAdminOnly: InvariantDefinition = {
  id: 'AUTH-002',
  domain: 'authorization',
  title: 'Privileged actions are admin-only',
  description:
    'No non-admin actor performed `impersonate_user` or `escalate_role`, mirroring the `impersonation_admin_only` deny-rule.',
  rationale:
    'Impersonation and role escalation are the two ways to obtain authority the actor does not already hold. A recorded non-admin performing either is a privilege-escalation event.',
  severity: 'critical',
  remediation:
    'Revoke the elevated access immediately and preserve the session and audit logs. Determine the scope of access gained before restoring service.',
  evaluate(dataset) {
    return evaluateAuthorizationEvents(dataset, (record, index) => {
      const action = readString(record, 'action');
      const role = readString(record, 'actorRole');
      if (action === null || role === null) return null;
      if (role === 'admin') return null;
      if (!(ADMIN_ONLY_ACTIONS as readonly string[]).includes(action)) return null;

      const id = readId(record, index);
      return violation(
        'critical',
        `Actor ${readString(record, 'actorId') ?? id} with role '${role}' performed ${action}.`,
        [
          offending('AuthorizationEvent', id, `role '${role}' is not permitted to ${action}`, 'actorRole'),
        ],
        { details: { actorRole: role, action, allowedRoles: ['admin'] } }
      );
    });
  },
};

/** Guests must not appear as having performed a denied action. */
const guestsCannotCreateAgents: InvariantDefinition = {
  id: 'AUTH-003',
  domain: 'authorization',
  title: 'Guest actors did not create agents',
  description: 'No `guest` actor performed `create_agent`, mirroring the `guest_no_create` deny-rule.',
  rationale:
    'Guests are unauthenticated. An agent created under a guest identity has no accountable owner and can be published without a reviewable author.',
  severity: 'error',
  remediation: 'Unpublish the agent and require the guest to authenticate before re-creating it, so the author is a verifiable Stellar key.',
  evaluate(dataset) {
    return evaluateAuthorizationEvents(dataset, (record, index) => {
      const action = readString(record, 'action');
      const role = readString(record, 'actorRole');
      if (role !== 'guest' || action === null) return null;
      if (!(GUEST_DENIED_ACTIONS as readonly string[]).includes(action)) return null;

      const id = readId(record, index);
      return violation('error', `Guest actor performed ${action}, which policy denies.`, [
        offending('AuthorizationEvent', id, `guest performed denied action '${action}'`, 'actorRole'),
      ]);
    });
  },
};

/** Transfers must stay under the configured ceiling, in stroops. */
const transfersWithinPolicyLimit: InvariantDefinition = {
  id: 'AUTH-004',
  domain: 'authorization',
  title: 'Fund transfers stay within the policy ceiling',
  description:
    'Every `transfer_funds` authorization record has an `amountStroops` no greater than `maxTransferAmount` in the business policy.',
  rationale:
    'The per-transaction ceiling is the last control before a payout reaches the chain. A recorded transfer above it means the limit was bypassed, not that policy was wrong.',
  severity: 'critical',
  remediation:
    'Pause the transfer pipeline and reconcile the specific transfer against the chain. Treat any amount already settled above the ceiling as a reportable incident.',
  evaluate(dataset) {
    const ceiling = parseStroops(defaultBusinessPolicy.maxTransferAmount);
    return evaluateAuthorizationEvents(dataset, (record, index) => {
      const action = readString(record, 'action');
      if (action !== 'transfer_funds') return null;
      const id = readId(record, index);
      const amount = parseStroops(record.amountStroops);
      if (amount === null) {
        return violation('error', `Transfer authorization ${id} has no parseable amountStroops.`, [
          offending('AuthorizationEvent', id, `amountStroops is ${display(record.amountStroops)}`, 'amountStroops'),
        ]);
      }
      if (ceiling === null || amount <= ceiling) return null;
      return violation(
        'critical',
        `Transfer authorization ${id} moved ${amount} stroops, above the ${ceiling} stroop ceiling.`,
        [offending('AuthorizationEvent', id, `amountStroops ${amount} exceeds ceiling ${ceiling}`, 'amountStroops')],
        { details: { amountStroops: amount.toString(), maxTransferAmount: defaultBusinessPolicy.maxTransferAmount } }
      );
    });
  },
};

/** Escalation must have been confirmed, mirroring `role_escalation_confirmation`. */
const roleEscalationConfirmed: InvariantDefinition = {
  id: 'AUTH-005',
  domain: 'authorization',
  title: 'Role escalations were explicitly confirmed',
  description:
    'Every `escalate_role` authorization record has `confirmed` set to true, mirroring the `role_escalation_confirmation` deny-rule.',
  rationale:
    'Confirmation is a deliberate human gate. An escalation recorded without it means the gate was skipped, so the elevation was never actually reviewed by anyone.',
  severity: 'error',
  remediation: 'Roll the escalation back to the prior role and re-request it through the UI so the confirmation is captured.',
  evaluate(dataset) {
    return evaluateAuthorizationEvents(dataset, (record, index) => {
      if (readString(record, 'action') !== 'escalate_role') return null;
      const id = readId(record, index);
      if (record.confirmed === true) return null;
      return violation('error', `Role escalation ${id} was recorded without confirmation.`, [
        offending('AuthorizationEvent', id, `confirmed is ${display(record.confirmed)}`, 'confirmed'),
      ]);
    });
  },
};

/** An admin has no reason to impersonate themselves. */
const noSelfImpersonation: InvariantDefinition = {
  id: 'AUTH-006',
  domain: 'authorization',
  title: 'Actors do not impersonate themselves',
  description: 'On every `impersonate_user` record, the actor is not also the resource owner.',
  rationale:
    'A self-impersonation bypasses session attribution entirely: subsequent actions are attributed to a different identity than the one actually connected, defeating the audit trail.',
  severity: 'error',
  remediation:
    'Re-establish the session under the original identity and discard the impersonated session so the audit trail is not left ambiguous.',
  evaluate(dataset) {
    return evaluateAuthorizationEvents(dataset, (record, index) => {
      if (readString(record, 'action') !== 'impersonate_user') return null;
      const actor = readString(record, 'actorId');
      const owner = readString(record, 'resourceOwner');
      if (actor === null || owner === null || actor !== owner) return null;
      const id = readId(record, index);
      return violation('error', `Impersonation ${id} has ${actor} impersonating itself.`, [
        offending('AuthorizationEvent', id, `actorId and resourceOwner are both ${actor}`, 'resourceOwner'),
      ]);
    });
  },
};

/** Privileged decisions must be traceable to a provenance record. */
const privilegedActionsAuditable: InvariantDefinition = {
  id: 'AUTH-007',
  domain: 'authorization',
  title: 'Privileged actions are traceable to a provenance record',
  description:
    'Every `impersonate_user` or `escalate_role` record either names an existing `provenanceId` or carries its own `at` timestamp, so the decision can be reconstructed.',
  rationale:
    'A privileged action with neither a provenance link nor a timestamp cannot be placed on a timeline, so it is impossible to prove when the escalation happened during an incident review.',
  severity: 'warning',
  remediation:
    'Recover the timestamp from the identity provider or session store and backfill the audit record through the normal logging path.',
  evaluate(dataset) {
    const knownProvenance = new Set(collectStrings(dataset.provenanceRecords, 'id'));
    return evaluateAuthorizationEvents(dataset, (record, index) => {
      const action = readString(record, 'action');
      if (action === null) return null;
      if (!(ADMIN_ONLY_ACTIONS as readonly string[]).includes(action)) return null;

      const id = readId(record, index);
      const provenanceId = readString(record, 'provenanceId');
      if (provenanceId !== null) {
        if (knownProvenance.has(provenanceId) || knownProvenance.size === 0) return null;
        return violation('warning', `Privileged action ${id} links to unknown provenance record '${provenanceId}'.`, [
          offending('AuthorizationEvent', id, `provenanceId '${provenanceId}' is not in the snapshot`, 'provenanceId'),
        ]);
      }
      if (readString(record, 'at') !== null) return null;
      return violation('warning', `Privileged action ${id} has neither a provenance link nor a timestamp.`, [
        offending('AuthorizationEvent', id, 'no provenanceId and no at timestamp', 'provenanceId'),
      ]);
    });
  },
};

export const AUTHORIZATION_INVARIANTS: readonly InvariantDefinition[] = Object.freeze([
  rolesAndActionsRecognized,
  privilegedActionsAdminOnly,
  guestsCannotCreateAgents,
  transfersWithinPolicyLimit,
  roleEscalationConfirmed,
  noSelfImpersonation,
  privilegedActionsAuditable,
]);

/** Vocabulary mirrors, exported so tests can prove they still match the engine. */
export const AUTHORIZATION_VOCABULARY = Object.freeze({
  roles: ALLOWED_ROLES,
  actions: ALLOWED_ACTIONS,
  adminOnlyActions: ADMIN_ONLY_ACTIONS,
  guestDeniedActions: GUEST_DENIED_ACTIONS,
});
