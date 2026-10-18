"use client";

/**
 * Sandbox panel
 *
 * Composes the three sandbox tools into one workbench:
 *   1. mode/config controls
 *   2. the mock wallet balance generator
 *   3. the scenario preset selector
 *   4. the transaction scenario recorder + replay adapter
 *   5. the Soroban storage state stubber
 *
 * The recorder state lives here so the scenario selector can push a preset
 * straight into the tape.
 */

import React, { useState } from "react";
import { Card } from "../../../components/Card";
import { Button } from "../../../components/Button";
import { sandboxManager, type SandboxMode } from "../../../lib/sandbox";
import { useSandboxSnapshot, useScenarioRecorder } from "../hooks/useScenarioRecorder";
import { WalletBalanceGenerator } from "./WalletBalanceGenerator";
import { ScenarioPresetSelector } from "./ScenarioPresetSelector";
import { TransactionScenarioRecorder } from "./TransactionScenarioRecorder";
import { StorageStubEditor } from "./StorageStubEditor";
import type { SandboxPanelProps } from "../types";

const MODES: SandboxMode[] = ["disabled", "enabled", "mock_only"];

const MODE_HELP: Record<SandboxMode, string> = {
  disabled: "Production behaviour — real services, real data.",
  enabled: "Mock external services and use fake data.",
  mock_only: "Mock external services but keep real data logic.",
};

export function SandboxPanel({ className = "" }: SandboxPanelProps) {
  const snapshot = useSandboxSnapshot();
  const recorder = useScenarioRecorder();
  const [mode, setMode] = useState<SandboxMode>(snapshot.mode);

  const applyMode = (next: SandboxMode) => {
    setMode(next);
    sandboxManager.initialize({
      mode: next,
      enabled: next !== "disabled",
      mockExternalServices: next !== "disabled",
      useFakeData: next !== "disabled",
    });
  };

  return (
    <div className={`space-y-6 ${className}`}>
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold glow-text text-white">Integration sandbox</h1>
            <p className="mt-2 max-w-3xl text-sm text-gray-400">
              Generate arbitrary mock wallet states, apply on-chain failure presets, and record or
              replay transaction responses — all locally, with no testnet XLM and no production
              credentials.
            </p>
          </div>
          <span
            data-testid="sandbox-enabled"
            className={`rounded-full border px-3 py-1 text-xs ${
              snapshot.enabled
                ? "border-emerald-400/50 text-emerald-300"
                : "border-gray-600 text-gray-300"
            }`}
          >
            {snapshot.enabled ? `sandbox ${snapshot.mode}` : "production mode"}
          </span>
        </div>

        <div className="mt-5 flex flex-wrap items-end gap-3">
          <label className="text-xs uppercase tracking-wide text-gray-400" htmlFor="sandbox-mode">
            Mode
            <select
              id="sandbox-mode"
              data-testid="sandbox-mode"
              value={mode}
              onChange={(event) => applyMode(event.target.value as SandboxMode)}
              className="mt-1 block rounded border border-gray-700 bg-gray-900/60 px-2 py-1 text-sm text-white outline-none focus:border-trellis-vine"
            >
              {MODES.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>

          <p className="pb-1 text-xs text-gray-500" data-testid="sandbox-mode-help">
            {MODE_HELP[mode]}
          </p>

          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              sandboxManager.reset();
              setMode("disabled");
              recorder.clear();
            }}
            data-testid="sandbox-reset"
          >
            Reset sandbox
          </Button>
        </div>

        <dl className="mt-5 grid grid-cols-2 gap-3 text-xs sm:grid-cols-5" data-testid="sandbox-snapshot">
          <div>
            <dt className="uppercase tracking-wide text-gray-500">Mock wallet</dt>
            <dd className="text-gray-200">
              {snapshot.wallet ? `${snapshot.wallet.balanceCount} balance(s)` : "none"}
            </dd>
          </div>
          <div>
            <dt className="uppercase tracking-wide text-gray-500">Active preset</dt>
            <dd className="text-gray-200">{snapshot.activeScenarioId ?? "none"}</dd>
          </div>
          <div>
            <dt className="uppercase tracking-wide text-gray-500">Tape</dt>
            <dd className="text-gray-200">
              {snapshot.replay ? `${snapshot.replay.size} interaction(s)` : "none"}
            </dd>
          </div>
          <div>
            <dt className="uppercase tracking-wide text-gray-500">Recorder</dt>
            <dd className="text-gray-200">
              {snapshot.recorder
                ? `${snapshot.recorder.size} recorded${snapshot.recorder.recording ? " · live" : ""}`
                : "none"}
            </dd>
          </div>
          <div>
            <dt className="uppercase tracking-wide text-gray-500">Storage stubs</dt>
            <dd className="text-gray-200">
              {snapshot.storage
                ? `${snapshot.storage.byType.instance}i · ${snapshot.storage.byType.persistent}p · ${snapshot.storage.byType.temporary}t`
                : "none"}
            </dd>
          </div>
        </dl>
      </Card>

      <WalletBalanceGenerator />

      <ScenarioPresetSelector onLoadIntoRecorder={(id) => recorder.recordScenario(id)} />

      <TransactionScenarioRecorder recorder={recorder} />

      <StorageStubEditor />
    </div>
  );
}

export default SandboxPanel;
