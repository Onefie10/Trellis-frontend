/**
 * Draft wallet rows
 *
 * Pure helpers shared by the balance generator UI. Kept free of React so the
 * row → generator-input mapping can be unit tested directly.
 */

import {
  WALLET_PRESETS,
  type BuildMockWalletInput,
  type MockBalanceInput,
} from "../../lib/sandbox-wallet";
import type { BalanceDraftRow } from "./types";

let rowCounter = 0;

export function nextRowId(): string {
  rowCounter += 1;
  return `sandbox-row-${rowCounter}`;
}

/** Resets the row id counter — test-only helper. */
export function resetRowIds(): void {
  rowCounter = 0;
}

export function isNativeAsset(asset: string): boolean {
  return /^(native|xlm)$/i.test(asset.trim());
}

export function rowFromSpec(spec: MockBalanceInput): BalanceDraftRow {
  return {
    id: nextRowId(),
    asset: spec.asset,
    issuer: spec.issuer ?? "",
    balance: String(spec.balance ?? "0"),
    limit: spec.limit === undefined || spec.limit === null ? "" : String(spec.limit),
    authorized: spec.authorized !== false,
    sponsored: spec.sponsored === true,
  };
}

export function emptyRow(asset = ""): BalanceDraftRow {
  return {
    id: nextRowId(),
    asset,
    issuer: "",
    balance: "0",
    limit: "",
    authorized: true,
    sponsored: false,
  };
}

/** Rows for the default editable state — the healthy preset. */
export function defaultRows(): BalanceDraftRow[] {
  const preset = WALLET_PRESETS.find((p) => p.id === "healthy");
  const specs = preset?.input.balances ?? [{ asset: "native", balance: "25" }];
  return specs.map(rowFromSpec);
}

/**
 * Converts draft rows into generator input.
 *
 * Blank assets are skipped so an empty row the user just added does not make the
 * whole preview look broken, and a blank balance is treated as zero.
 */
export function rowsToSpecs(rows: BalanceDraftRow[]): MockBalanceInput[] {
  return rows
    .filter((row) => row.asset.trim().length > 0)
    .map((row) => ({
      asset: row.asset.trim(),
      balance: row.balance.trim().length > 0 ? row.balance.trim() : "0",
      issuer: row.issuer.trim().length > 0 ? row.issuer.trim() : undefined,
      limit: row.limit.trim().length > 0 ? row.limit.trim() : undefined,
      authorized: row.authorized,
      sponsored: row.sponsored,
    }));
}

/** Builds generator input from the draft, applying the UI label + network. */
export function draftToBuildInput(
  rows: BalanceDraftRow[],
  label: string,
): BuildMockWalletInput {
  return {
    label: label.trim() || "Sandbox wallet",
    seed: "ui-wallet",
    network: "testnet",
    balances: rowsToSpecs(rows),
  };
}
