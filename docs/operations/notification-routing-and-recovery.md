# Notification Routing and Recovery Operations Guide

## Overview

The Trellis Frontend notification system enforces a **durable preference and mandatory-alert routing model** (Issue #278).
It decouples optional notifications (simulations, trade results, routine mints) from mandatory alerts (recovery actions, security audit flags, multi-sig approvals, critical failures).

---

## 1. Routing Model Architecture

```
Incoming Event (LifecycleNotification)
                 │
                 ▼
       isMandatoryAlert(event)?
        ├── YES ──► Mandatory Pathway
        │            │
        │            ├─► In-App Inbox (Guaranteed Delivery)
        │            ├─► Audio Chime (Plays unless muteCritical is enabled)
        │            ├─► Webhook Dispatch (If configured)
        │            └─► Audit Record ("mandatory_delivered")
        │
        └── NO ───► Optional Pathway
                     │
                     ▼
           User Preferences Check
           ├── enabled == false? ───► Suppressed ("notifications_disabled")
           ├── category muted? ─────► Suppressed ("category_muted")
           ├── quiet hours? ────────► Suppressed ("quiet_hours")
           └── all clear? ──────────► Delivered to configured channels ("delivered")
                                      └─► Audit Record
```

### Mandatory Alert Definition

An alert is classified as **mandatory** if any of the following conditions are met:
1. `notification.isMandatory === true`
2. `notification.severity === 'critical'`
3. Event type is in `MANDATORY_EVENT_TYPES`:
   - `recovery_action_required`: Immediate node, validator, or wallet recovery required.
   - `security_audit_alert`: High-risk security vulnerabilities or exploit alerts.
   - `approval_required`: Multi-signature or administrative sign-off required.

---

## 2. Durable Preferences Schema & Durability

### Storage Key
- Primary: `Trellis-durable-alert-preferences-v1`
- Legacy backward-compatible mirror: `Trellis-alert-preferences`

### Schema Version 1
```ts
interface DurableNotificationPreferences {
  version: 1;
  enabled: boolean;
  audioEnabled: boolean;
  volume: number; // 0.0 - 1.0
  mutedCategories: {
    trading: boolean;
    governance: boolean;
    security: boolean;
    system: boolean;
  };
  quietHours: {
    enabled: boolean;
    start: string; // HH:MM
    end: string;   // HH:MM
    days: number[]; // 0 = Sunday
    muteCritical: boolean;
  };
  channels: {
    inApp: boolean;
    audio: boolean;
    webhook: boolean;
  };
  readonly mandatoryDeliveryEnforced: true;
}
```

### Automatic Migration
When a client loads preferences:
1. It queries `Trellis-durable-alert-preferences-v1`.
2. If missing, it falls back to `Trellis-alert-preferences` (legacy AlertPreferences).
3. Legacy values are normalized into Schema Version 1 defaults and saved forward.

---

## 3. Operational Edge Cases & Failure Modes

| Edge Case / Failure Mode | Symptom | System Behavior & Mitigation |
| :--- | :--- | :--- |
| **LocalStorage Quota Exceeded** | `QuotaExceededError` thrown upon preference save | In-memory fallback takes over seamlessly. Notification routing continues using active session memory. |
| **Private Browsing / Blocked Storage** | Storage API throws SecurityError | `resolveStorage()` catches the exception and falls back to ephemeral memory store without crashing. |
| **Corrupted Storage Payload** | Invalid JSON or malformed schema in storage | `normaliseDurablePreferences()` validates and clamps fields, repairing corrupt values with safe defaults. |
| **Cross-Tab Concurrency** | User changes preferences in Tab A while Tab B is open | `StorageEvent` and custom event bus propagate changes across tabs in real-time. |
| **Rapid Duplicate Dispatches** | Network retry emits identical transaction alert | `dedupKey` hash table suppresses duplicate notifications, preventing inbox flooding. |
| **Quiet Hours Crossing Midnight** | `start > end` (e.g. 22:00 -> 08:00) | `isWithinQuietHours()` calculates day-offset modulo arithmetic to correctly attribute early morning hours to the previous evening. |

---

## 4. Auditable Delivery Log

Every notification evaluation generates an immutable `NotificationAuditRecord` containing:
- `notificationId`
- `dedupKey`
- `eventType`
- `severity`
- `isMandatory`
- `routingDecision` (`delivered` | `suppressed` | `mandatory_delivered`)
- `suppressionReasons`
- `channelsDelivered`
- `timestamp`

### Inspection & Export
```ts
import { lifecycleNotifications } from '@/lib/notifications/lifecycle-manager';

// Get recent audit log entries
const auditLog = lifecycleNotifications.getAuditLog({ limit: 50 });

// Filter mandatory alerts only
const mandatoryAudit = lifecycleNotifications.getAuditLog({ mandatoryOnly: true });

// Export JSON for compliance/debugging
const auditJson = lifecycleNotifications.exportAuditLogJson();
```

---

## 5. Rollback and Recovery Steps

If a configuration error or regression occurs:

1. **Reset Preferences to Safe Defaults**:
   ```ts
   import { saveDurablePreferences, DEFAULT_DURABLE_PREFERENCES } from '@/lib/notifications/durable-preferences';
   saveDurablePreferences(DEFAULT_DURABLE_PREFERENCES);
   ```
2. **Clear Corrupted Local Storage**:
   ```js
   localStorage.removeItem('Trellis-durable-alert-preferences-v1');
   localStorage.removeItem('Trellis-alert-preferences');
   ```
3. **Emergency Bypass**:
   In mission-critical scenarios where preference evaluation must be bypassed entirely:
   ```ts
   lifecycleNotifications.dispatch(event, { bypassPreferences: true });
   ```
4. **Verify Mandatory Alerts**:
   Confirm that `lifecycleNotifications.getAuditLog({ mandatoryOnly: true })` shows `mandatory_delivered` outcomes.
