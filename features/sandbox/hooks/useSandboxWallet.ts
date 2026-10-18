"use client";

/**
 * Mock wallet balance generator state.
 *
 * Owns the editable rows, validates them on every keystroke (so the preview and
 * the error never disagree), and injects the built wallet into `sandboxManager`
 * where the mock adapters pick it up.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { sandboxManager } from "../../../lib/sandbox";
import {
  SandboxWalletError,
  WALLET_PRESETS,
  buildMockWallet,
  formatBalance,
  summariseWallet,
  trimBalance,
  validateDraft,
  type BuildMockWalletInput,
  type MockWalletState,
  type WalletPreset,
} from "../../../lib/sandbox-wallet";
import {
  defaultRows,
  draftToBuildInput,
  emptyRow,
  rowFromSpec,
  rowsToSpecs,
} from "../draft-wallet";
import type { BalanceDraftRow } from "../types";

export interface UseSandboxWalletResult {
  label: string;
  setLabel: (value: string) => void;
  rows: BalanceDraftRow[];
  presets: WalletPreset[];
  updateRow: (id: string, patch: Partial<Omit<BalanceDraftRow, "id">>) => void;
  addRow: (asset?: string) => void;
  removeRow: (id: string) => void;
  applyPreset: (presetId: string) => MockWalletState | null;
  generate: () => MockWalletState | null;
  clear: () => void;
  /** Live validation of the current rows — never injected. */
  preview: MockWalletState | null;
  validationError: string | null;
  /** Field flagged by the last validation failure, when known. */
  errorField: string | null;
  /** Set when an attempt to inject a wallet failed. */
  error: string | null;
  /** The wallet currently injected into the sandbox, if any. */
  injected: MockWalletState | null;
  warnings: string[];
  summary: string | null;
  spendable: string | null;
}

export function useSandboxWallet(): UseSandboxWalletResult {
  const [label, setLabel] = useState("Sandbox wallet");
  const [rows, setRows] = useState<BalanceDraftRow[]>(defaultRows);
  const [error, setError] = useState<string | null>(null);
  const [errorField, setErrorField] = useState<string | null>(null);
  const injected = useSandboxWalletState();

  const specs = useMemo(() => rowsToSpecs(rows), [rows]);

  const validation = useMemo(() => validateDraft(specs), [specs]);

  const preview = validation.ok && validation.state ? validation.state : null;
  const validationError = validation.ok
    ? null
    : validation.error?.message ?? "Wallet definition is invalid";

  const updateRow = useCallback(
    (id: string, patch: Partial<Omit<BalanceDraftRow, "id">>) => {
      setRows((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)));
    },
    [],
  );

  const addRow = useCallback((asset = "") => {
    setRows((current) => [...current, emptyRow(asset)]);
  }, []);

  const removeRow = useCallback((id: string) => {
    setRows((current) => current.filter((row) => row.id !== id));
  }, []);

  /** Builds and injects, returning the wallet (or `null` on validation failure). */
  const inject = useCallback((input: BuildMockWalletInput): MockWalletState | null => {
    try {
      const built = buildMockWallet(input);
      sandboxManager.setWalletState(built);
      setError(null);
      setErrorField(null);
      return built;
    } catch (failure) {
      if (failure instanceof SandboxWalletError) {
        setError(failure.message);
        setErrorField(failure.field ?? null);
        sandboxManager.clearWalletState();
        return null;
      }
      throw failure;
    }
  }, []);

  const generate = useCallback((): MockWalletState | null => {
    return inject(draftToBuildInput(rows, label));
  }, [inject, label, rows]);

  const applyPreset = useCallback(
    (presetId: string): MockWalletState | null => {
      const preset = WALLET_PRESETS.find((p) => p.id === presetId);
      if (!preset) {
        setError(`Unknown wallet preset "${presetId}"`);
        setErrorField("preset");
        return null;
      }
      setLabel(preset.input.label ?? preset.label);
      setRows(preset.input.balances.map(rowFromSpec));
      return inject(preset.input);
    },
    [inject],
  );

  const clear = useCallback(() => {
    sandboxManager.clearWalletState();
    setRows(defaultRows());
    setLabel("Sandbox wallet");
    setError(null);
    setErrorField(null);
  }, []);

  return {
    label,
    setLabel,
    rows,
    presets: WALLET_PRESETS,
    updateRow,
    addRow,
    removeRow,
    applyPreset,
    generate,
    clear,
    preview,
    validationError,
    errorField,
    error,
    injected,
    warnings: preview?.warnings ?? [],
    summary: preview ? summariseWallet(preview) : null,
    spendable: preview ? trimBalance(preview.reserve.spendable) : null,
  };
}

/**
 * Reads the wallet currently injected into the sandbox.
 *
 * Subscribes to `sandboxManager` so any component re-renders when the balance
 * generator (or a test) swaps the injected state.
 */
export function useSandboxWalletState(): MockWalletState | null {
  const [state, setState] = useState<MockWalletState | null>(() =>
    sandboxManager.getWalletState(),
  );

  useEffect(() => {
    setState(sandboxManager.getWalletState());
    return sandboxManager.subscribe(() => {
      setState(sandboxManager.getWalletState());
    });
  }, []);

  return state;
}

/** One-line description of the injected state, for the panel header. */
export function describeInjectedWallet(state: MockWalletState | null): string {
  if (!state) return "No mock wallet injected — adapters return their default fixtures.";
  const native = state.balances.find((b) => b.isNative);
  return `${state.label} · ${state.balances.length} balance(s) · ${formatBalance(
    native?.balanceStroops ?? 0n,
  )} XLM · spendable ${trimBalance(state.reserve.spendable)} XLM`;
}

export { rowsToSpecs };
