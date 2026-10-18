/**
 * Device prompt walkthrough copy.
 *
 * Kept separate from the React component so the step order and the
 * error -> step mapping can be unit tested (and reused by docs/telemetry).
 */

import type { LedgerErrorCode } from "./errors";

export interface LedgerGuideStep {
  /** Short instruction shown as the step title. */
  title: string;
  /** What the user should do / check on the device. */
  detail: string;
  /** Error codes that mean the user is stuck on this step. */
  codes: LedgerErrorCode[];
}

export const LEDGER_GUIDE_STEPS: LedgerGuideStep[] = [
  {
    title: "Connect your Ledger",
    detail:
      "Plug the device in with its USB cable and keep Ledger Live closed, so the browser can claim the device.",
    codes: ["no-device", "unsupported", "unavailable", "transport", "invalid-response"],
  },
  {
    title: "Unlock the device",
    detail: "Enter your PIN on the Ledger until the device shows the dashboard.",
    codes: ["locked"],
  },
  {
    title: "Open the Stellar app",
    detail:
      "Select the Stellar app on the device and leave it on screen. Only the Stellar app can sign this transaction.",
    codes: ["app-not-open", "wrong-app"],
  },
  {
    title: "Verify the address on screen",
    detail:
      "Your Ledger displays the derived G... address. Check it matches the address shown here, then approve with both buttons.",
    codes: ["user-rejected"],
  },
  {
    title: "Confirm the transaction details",
    detail:
      "For every signature, read the operation details on the device screen and approve with both buttons. Nothing is signed without your confirmation.",
    codes: [
      "user-rejected",
      "hash-signing-disabled",
      "data-too-large",
      "invalid-data",
      "invalid-path",
      "invalid-signature",
    ],
  },
];

/**
 * Index of the step an error code belongs to, or `-1` when the code is not
 * actionable on the device (for example a generic transport failure).
 */
export function guideStepForError(code: LedgerErrorCode | null | undefined): number {
  if (!code) return -1;
  return LEDGER_GUIDE_STEPS.findIndex((step) => step.codes.includes(code));
}

/** Index of the step where the user approves the derived address. */
export const LEDGER_ADDRESS_STEP = LEDGER_GUIDE_STEPS.findIndex((step) =>
  step.title.startsWith("Verify the address"),
);
