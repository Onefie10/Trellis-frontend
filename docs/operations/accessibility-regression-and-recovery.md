# Accessibility Regression Coverage & Operational Recovery Runbook

## Overview

This document outlines the accessibility architecture, operational edge cases, failure modes, and rollback/recovery procedures for dense forms, data tables, reduced-motion preferences, and error recovery flows across `Trellis-frontend`.

---

## 1. Core Workflows Covered

### Dense Forms
- **`BugReportForm` (`components/BugReportForm.tsx`)**:
  - Named `<form aria-label="Bug report submission form">` landmark.
  - Explicit `<label htmlFor>` and `aria-required="true"` on all required controls.
  - Deterministic field-to-DOM-ID mapping (`FIELD_ELEMENT_IDS`) ensuring validation failures move keyboard focus to the first invalid control (`bug-title`, `bug-description`, `bug-steps`, `bug-expected`, `bug-actual`, `bug-email`, `agreeToTerms`).
  - Consolidated polite live region (`data-testid="bug-form-error-summary"`, `role="status"`, `aria-live="polite"`) plus per-field `role="alert"` messages linked via `aria-describedby`.
- **`SorobanFunctionForm` (`components/soroban/SorobanFunctionForm.tsx`)**:
  - Dynamic ABI contract inputs with `aria-required="true"`, `aria-invalid`, and `aria-describedby="arg-<fn>-<input>-error"`.
  - Automatic focus recovery to the first invalid contract argument upon submission failure.
  - Assertive error banner (`role="alert"`, `aria-live="assertive"`) for RPC/host simulation failures.
- **`MultisigTransactionBuilder` (`features/governance/components/MultisigTransactionBuilder.tsx`)**:
  - Explicit label bindings (`multisig-dest`, `multisig-amount`, `multisig-memo`, `multisig-envelope-xdr`).
  - Reduced-motion safe signature threshold progress bar (`motion-reduce:transition-none`).
  - Assertive (`aria-live="assertive"`) error announcements for malformed XDR envelopes and polite (`aria-live="polite"`) status updates when quorum is reached.

### Dense Tables & Dashboards
- **`ReferralTable` (`features/affiliate-dashboard/components/ReferralTable.tsx`)**:
  - Named `<table aria-label="Referrals">` with `scope="col"` on all headers.
  - Dynamic `aria-sort` (`ascending` | `descending` | `none`) on sortable columns (`Date`, `Commission`, `Status`) synchronized with keyboard/select sorting controls.
  - Accessible loading state (`role="status"`, `aria-busy="true"`, `aria-label="Loading referrals"`, `motion-reduce:animate-none`) and polite empty state.
- **`SubmissionTable` (`features/submissions-dashboard/components/SubmissionTable.tsx`) & `MetricSeriesTable` (`components/metrics/MetricSeriesTable.tsx`)**:
  - Named `<table>` landmarks (`Submissions`, `Metric series`), `scope="col"` column headers, and native `<details>/<summary>` keyboard disclosure for license audits.
- **`VirtualizedTradingTable` (`components/trading/VirtualizedTradingTable.tsx`)**:
  - Explicit ARIA grid/table hierarchy (`role="table"`, `aria-label="Trading activity"`, `aria-rowcount`) for `react-window` virtualized rows.
  - Sticky header row (`role="row"`, `aria-rowindex={1}`, `role="columnheader"`) and virtualized data rows (`role="row"`, `aria-rowindex={index + 2}`, `role="cell"`).
- **`PartialFailureDashboard` (`features/partial-failure-dashboard/PartialFailureDashboard.tsx`)**:
  - Labelled filter controls (`Status`, `Severity`, `Operation Type`, `Age`, `Search`).
  - Sort buttons (`Created`, `Severity`) with `aria-sort`.
  - Expandable row inspection (`aria-expanded`, `aria-controls="failure-details-<id>"`) linked to a named `role="region"` details container.

### Error Recovery & Offline Continuity Flows
- **`RouteError` (`app/error.tsx`) & `GlobalError` (`app/global-error.tsx`)**:
  - Assertive live region (`role="alert"`, `aria-live="assertive"`, `aria-atomic="true"`).
  - Automatic focus transfer to the `Try again` recovery button on boundary mount so keyboard and screen-reader users can recover immediately without hunting for focus.
- **`SessionRecovery` (`features/wallet/components/SessionRecovery.tsx`)**:
  - `aria-busy={recovering}` during asynchronous encrypted vault restoration.
  - Polite status announcement (`role="status"`, `aria-live="polite"`) on success and assertive alert (`role="alert"`, `aria-live="assertive"`) on failure.
- **`ConflictDialog` (`features/session-continuity/components/ConflictDialog.tsx`)**:
  - Modal alert dialog (`role="alertdialog"`, `aria-modal="true"`, `aria-labelledby="conflict-dialog-title"`, `aria-describedby="conflict-dialog-description"`).
  - Focuses the primary recovery action on mount and supports `Escape` key dismissal (`onResolve("discard")`).
- **`OfflineBanner` (`components/OfflineBanner.tsx`)**:
  - Polite status region (`role="status"`, `aria-live="polite"`) announcing offline fallback and queued mutation counts with a keyboard-accessible `Sync now` trigger.

### Reduced Motion
- **`useReducedMotion` (`hooks/useReducedMotion.ts`) & Global CSS (`app/globals.css`)**:
  - Subscribes to `(prefers-reduced-motion: reduce)` with fallback support for legacy `MediaQueryList.addListener`.
  - Global `@media (prefers-reduced-motion: reduce)` rule neutralizes CSS animations, smooth scrolling, and `.transition-smooth` transitions across all components.

---

## 2. Operational Edge Cases & Failure Modes

| Edge Case / Failure Mode | Impact on Assistive Tech / Keyboard Users | Mitigation Implemented |
| :--- | :--- | :--- |
| **Mismatched Form State Key vs. DOM Element ID** | `document.getElementById(key)?.focus()` silently returns `null`, leaving keyboard focus on the Submit button while validation errors render off-screen. | Explicit `FIELD_ELEMENT_IDS` dictionary in `BugReportForm` and deterministic `arg-${fn.name}-${input.name}` IDs in `SorobanFunctionForm`. |
| **Alert Storm on Multi-Field Validation Failure** | Rendering 5+ simultaneous `role="alert"` nodes can cause screen readers (NVDA/VoiceOver) to interrupt or drop individual field messages. | Added a single consolidated `role="status" aria-live="polite" aria-atomic="true"` summary banner (`bug-form-error-summary`) alongside `aria-describedby` field bindings so users hear the total error count and immediately land on the first invalid field. |
| **Virtualized Table Row Count Loss** | `react-window` only mounts visible DOM nodes; screen readers announce "row 1 of 5" instead of the true dataset size and lose column associations because `<div>` rows lack table semantics. | Added `role="table"`, `aria-rowcount={processedData.length + 1}`, `role="row"`, `aria-rowindex`, `role="columnheader"`, and `role="cell"` in `VirtualizedTradingTable`. |
| **Focus Loss After Route/Global Error Boundary Tripping** | When a subtree unmounts due to a runtime error, browser focus resets to `<body>`, leaving keyboard users disoriented. | `RouteError` and `GlobalError` focus the `Try again` button via `useRef` on mount inside an assertive alert region. |
| **Concurrent Edit Conflict Modal Trap** | If a conflict modal opens without shifting focus or handling `Escape`, keyboard users continue tabbing in background form controls. | `ConflictDialog` uses `role="alertdialog"`, `aria-modal="true"`, focuses the first recovery action button upon opening, and binds `Escape` to `onResolve("discard")`. |
| **Legacy Browser `matchMedia` Implementation** | Older WebViews or test environments lacking `MediaQueryList.addEventListener` throw a runtime `TypeError`. | `useReducedMotion` checks `typeof mediaQuery.addEventListener === 'function'` and falls back to `addListener`/`removeListener`. |

---

## 3. Verification Commands

Run the unit and integration accessibility regression suite:

```bash
npx jest tests/__tests__/accessibility-regression.test.tsx
```

Run related component test suites to verify backward compatibility:

```bash
npx jest features/partial-failure-dashboard/__tests__/PartialFailureDashboard.test.tsx features/governance/__tests__/MultisigTransactionBuilder.test.tsx features/affiliate-dashboard/tests/page.test.tsx
```

Run the Playwright E2E accessibility audit (axe-core WCAG 2.0/2.1 A & AA + keyboard + reduced-motion):

```bash
npm run test:e2e:a11y
```

---

## 4. Rollback & Recovery Steps

All accessibility improvements are strictly additive (ARIA attributes, label associations, focus management hooks, and CSS media queries) and preserve existing component props, public APIs, and state schemas.

1. **Targeted Component Rollback**:
   - If a specific focus hook or live region causes unexpected focus stealing in a custom integration, revert the individual component while retaining the regression test suite (updating the corresponding test expectation):
     ```bash
     git checkout main -- <path-to-component>
     ```
2. **Full Feature Rollback**:
   - Revert the accessibility commit cleanly without any database, storage, or API schema migration required:
     ```bash
     git revert <commit-sha>
     ```
3. **Post-Rollback Verification**:
   - Re-run `npm test` and `npm run typecheck` to confirm clean build state.
