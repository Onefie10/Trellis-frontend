/**
 * Sandbox feature types
 *
 * UI-local shapes for the balance generator and the recorder. Domain types stay
 * in `lib/` and are re-exported here so components have a single import site.
 */

import type { MockWalletState } from "../../lib/sandbox-wallet";
import type { SandboxScenario, SandboxScenarioId } from "../../lib/sandbox-scenarios";
import type { ReplayStrategy } from "../../lib/sandbox-replay";

export type { MockWalletState, SandboxScenario, SandboxScenarioId, ReplayStrategy };

/** One editable row in the mock wallet balance generator. */
export interface BalanceDraftRow {
  id: string;
  /** `native`, `XLM`, `USDC` or `USDC:<issuer>`. */
  asset: string;
  issuer: string;
  balance: string;
  limit: string;
  authorized: boolean;
  sponsored: boolean;
}

/** The outcome of replaying a single recorded interaction. */
export interface ReplayRunResult {
  interactionId: string;
  seq: number;
  method: string;
  success: boolean;
  summary: string;
}

/** Category filter used by the scenario preset selector. */
export type ScenarioFilter = "all" | SandboxScenario["category"];

export interface SandboxPanelProps {
  className?: string;
  /** Start with these scenarios loaded into the recorder. */
  initialScenarioIds?: SandboxScenarioId[];
}
