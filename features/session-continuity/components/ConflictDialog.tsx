"use client";

import { useEffect, useRef } from "react";
import { ConflictInfo, getRecoveryActions } from "../../../lib/concurrency";
import { Button } from "../../../components/Button";

interface ConflictDialogProps {
  conflict: ConflictInfo;
  onResolve: (action: "retry" | "refresh" | "merge" | "discard") => void;
  isOpen: boolean;
}

/**
 * Dialog for resolving concurrent edit conflicts
 */
export function ConflictDialog({ conflict, onResolve, isOpen }: ConflictDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen || !conflict) return;

    const firstButton = dialogRef.current?.querySelector<HTMLButtonElement>("button");
    firstButton?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onResolve("discard");
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, conflict, onResolve]);

  if (!isOpen || !conflict) {
    return null;
  }

  const actions = getRecoveryActions(conflict);

  const getMessage = () => {
    switch (conflict.conflictType) {
      case "stale_write":
        return "This record has been updated since you started editing. Your changes cannot be applied directly.";
      case "concurrent_edit":
        return "This record was modified by another device. Please review the latest version.";
      case "deleted":
        return "This record has been deleted. You cannot apply your changes.";
      default:
        return "A conflict was detected while saving your changes.";
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="conflict-dialog-title"
        aria-describedby="conflict-dialog-description"
        className="w-96 rounded-lg bg-white p-6 shadow-xl"
      >
        <h2 id="conflict-dialog-title" className="text-lg font-bold text-amber-900">
          Editing Conflict
        </h2>
        <p id="conflict-dialog-description" className="mt-4 text-gray-700">
          {getMessage()}
        </p>

        <div className="mt-6 space-y-3">
          {actions.map((action) => (
            <Button
              key={action.type}
              onClick={() => onResolve(action.type as "retry" | "refresh" | "merge" | "discard")}
              className="w-full"
              variant="secondary"
            >
              {action.description}
            </Button>
          ))}
        </div>

        <div className="mt-4 rounded bg-gray-50 p-3 text-xs text-gray-500">
          <p>Version mismatch: attempted {conflict.attemptedVersion}, current {conflict.currentVersion}</p>
        </div>
      </div>
    </div>
  );
}
