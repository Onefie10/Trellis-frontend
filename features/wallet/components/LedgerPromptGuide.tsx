"use client";

import React from "react";
import {
  LEDGER_GUIDE_STEPS,
  guideStepForError,
  type LedgerErrorCode,
} from "@/features/wallet/ledger";

export interface LedgerPromptGuideProps {
  /** 0-based index of the step to highlight. */
  activeStep?: number;
  /** Error code from the last attempt, used to flag the step that needs attention. */
  errorCode?: LedgerErrorCode | null;
  className?: string;
}

/**
 * Step-by-step device prompt guide rendered next to the Ledger connect flow. The
 * failing step is derived from the error code the device/transport returned, so
 * users are told exactly which button to press next.
 */
export default function LedgerPromptGuide({
  activeStep = 0,
  errorCode = null,
  className = "",
}: LedgerPromptGuideProps) {
  const failedStep = guideStepForError(errorCode);
  const currentStep =
    activeStep >= 0 ? Math.min(activeStep, LEDGER_GUIDE_STEPS.length - 1) : 0;

  return (
    <ol className={`space-y-3 ${className}`} data-testid="ledger-prompt-guide">
      {LEDGER_GUIDE_STEPS.map((step, index) => {
        const isFailed = index === failedStep;
        const isActive = index === currentStep && !isFailed;
        const isComplete = index < currentStep && !isFailed;

        return (
          <li
            key={step.title}
            aria-current={isActive ? "step" : undefined}
            data-step-state={isFailed ? "failed" : isActive ? "active" : isComplete ? "done" : "todo"}
            className={`flex gap-3 rounded-lg border p-3 transition-smooth ${
              isFailed
                ? "border-rose-500/40 bg-rose-500/10"
                : isActive
                  ? "border-trellis-vine/50 bg-trellis-vine/10"
                  : "border-trellis-vine/10 bg-trellis-ground/30"
            }`}
          >
            <span
              className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                isFailed
                  ? "bg-rose-500/20 text-rose-300"
                  : isActive
                    ? "bg-trellis-vine text-white"
                    : "bg-trellis-ground text-gray-400"
              }`}
            >
              {isFailed ? "!" : isComplete ? "✓" : index + 1}
            </span>
            <div className="space-y-1">
              <p className={`text-sm font-semibold ${isFailed ? "text-rose-200" : "text-white"}`}>
                {step.title}
              </p>
              <p className="text-xs leading-relaxed text-gray-400">{step.detail}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
