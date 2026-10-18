"use client";

/**
 * Scenario preset selector
 *
 * Exposes the failure presets a developer actually needs — Out of Energy,
 * Invalid Sequence, Tx Expired and friends — so a UI branch can be exercised on
 * demand instead of by trying to reproduce the failure on testnet.
 */

import React, { useMemo, useState } from "react";
import { Card } from "../../../components/Card";
import { Button } from "../../../components/Button";
import { sandboxManager } from "../../../lib/sandbox";
import {
  SCENARIO_PRESETS,
  describeScenario,
  scenarioCategories,
  type SandboxScenario,
  type SandboxScenarioId,
} from "../../../lib/sandbox-scenarios";
import { useSandboxSnapshot } from "../hooks/useScenarioRecorder";
import type { ScenarioFilter } from "../types";

interface ScenarioPresetSelectorProps {
  className?: string;
  /** Called when the developer wants this scenario recorded into a tape. */
  onLoadIntoRecorder?: (id: SandboxScenarioId) => void;
}

const CATEGORY_LABELS: Record<string, string> = {
  all: "All",
  success: "Success",
  resource: "Resources",
  sequence: "Sequence",
  ledger: "Ledger",
  balance: "Balance",
  validation: "Validation",
  network: "Network",
};

function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category;
}

export function ScenarioPresetSelector({
  className = "",
  onLoadIntoRecorder,
}: ScenarioPresetSelectorProps) {
  const snapshot = useSandboxSnapshot();
  const [filter, setFilter] = useState<ScenarioFilter>("all");

  const categories = useMemo(() => ["all", ...scenarioCategories()], []);
  const visible = useMemo(
    () => (filter === "all" ? SCENARIO_PRESETS : SCENARIO_PRESETS.filter((s) => s.category === filter)),
    [filter],
  );
  const active: SandboxScenario | undefined = SCENARIO_PRESETS.find(
    (scenario) => scenario.id === snapshot.activeScenarioId,
  );

  const apply = (id: SandboxScenarioId) => {
    sandboxManager.setActiveScenario(id);
  };

  return (
    <Card className={className}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-white">Scenario presets</h2>
          <p className="mt-1 text-sm text-gray-400">
            Applying a preset makes the mock Stellar adapter fail every transaction with that
            result, so the error branch renders.
          </p>
        </div>
        <span
          data-testid="sandbox-active-scenario"
          className="rounded-full border border-trellis-vine/40 px-3 py-1 text-xs text-gray-300"
        >
          {snapshot.activeScenarioId ?? "none active"}
        </span>
      </div>

      <div className="mt-4 flex flex-wrap gap-2" data-testid="scenario-filters">
        {categories.map((category) => (
          <button
            key={category}
            type="button"
            data-testid={`scenario-filter-${category}`}
            aria-pressed={filter === category}
            onClick={() => setFilter(category as ScenarioFilter)}
            className={`rounded-full border px-3 py-1 text-xs transition-smooth ${
              filter === category
                ? "border-trellis-vine bg-trellis-vine/20 text-white"
                : "border-gray-700 text-gray-300 hover:border-trellis-vine/60"
            }`}
          >
            {categoryLabel(category)}
          </button>
        ))}
      </div>

      <ul className="mt-4 grid gap-2 sm:grid-cols-2" data-testid="scenario-list">
        {visible.map((scenario) => {
          const isActive = snapshot.activeScenarioId === scenario.id;
          return (
            <li key={scenario.id}>
              <button
                type="button"
                data-testid={`scenario-${scenario.id}`}
                aria-pressed={isActive}
                onClick={() => apply(scenario.id)}
                className={`w-full rounded-lg border p-3 text-left transition-smooth ${
                  isActive
                    ? "border-trellis-amber bg-trellis-amber/10"
                    : "border-gray-700 hover:border-trellis-vine/60 hover:bg-trellis-vine/5"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-white">{scenario.label}</span>
                  <span className="text-[0.65rem] uppercase tracking-wide text-gray-400">
                    {categoryLabel(scenario.category)}
                  </span>
                </div>
                <p className="mt-1 text-xs text-gray-400">{scenario.description}</p>
                <p className="mt-2 font-mono text-[0.7rem] text-trellis-amber">
                  {scenario.transactionCode ?? `HTTP ${scenario.httpStatus}`}
                  {scenario.operationCode ? ` · ${scenario.operationCode}` : ""}
                </p>
              </button>
            </li>
          );
        })}
      </ul>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="secondary"
          onClick={() => sandboxManager.clearActiveScenario()}
          data-testid="scenario-clear"
        >
          Clear preset
        </Button>
        {active && onLoadIntoRecorder ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => onLoadIntoRecorder(active.id)}
            data-testid="scenario-load-into-recorder"
          >
            Record into tape
          </Button>
        ) : null}
      </div>

      {active ? (
        <div
          className="mt-5 rounded-lg border border-gray-700 bg-gray-900/40 p-4"
          data-testid="scenario-detail"
        >
          <h3 className="text-sm font-semibold text-white">{active.label}</h3>
          <p className="mt-1 text-xs text-gray-400" data-testid="scenario-detail-summary">
            {describeScenario(active)}
          </p>

          <dl className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
            <div>
              <dt className="text-gray-500">HTTP</dt>
              <dd className="text-gray-200">{active.httpStatus}</dd>
            </div>
            <div>
              <dt className="text-gray-500">Retriable</dt>
              <dd className="text-gray-200">{active.retriable ? "yes" : "no"}</dd>
            </div>
            <div>
              <dt className="text-gray-500">Soroban</dt>
              <dd className="text-gray-200">{active.soroban?.message ?? "—"}</dd>
            </div>
          </dl>

          {active.diagnosticEvents.length > 0 && (
            <pre
              className="mt-3 overflow-x-auto rounded bg-black/40 p-3 font-mono text-[0.7rem] text-gray-300"
              data-testid="scenario-diagnostics"
            >
              {active.diagnosticEvents.join("\n")}
            </pre>
          )}

          <ul className="mt-3 space-y-1 text-xs text-trellis-amber" data-testid="scenario-hints">
            {active.hints.map((hint) => (
              <li key={hint}>• {hint}</li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="mt-4 text-xs text-gray-500" data-testid="scenario-detail-empty">
          No preset applied — mock adapters return their default success responses.
        </p>
      )}
    </Card>
  );
}

export default ScenarioPresetSelector;
