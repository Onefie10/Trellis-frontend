"use client";

/**
 * Transaction scenario recorder + replay controls
 *
 * Records the mock adapter's responses (or loads a preset tape built from the
 * scenario library), then replays them so a UI flow can be driven through
 * deterministic success and failure paths.
 */

import React, { useState } from "react";
import { Button } from "../../../components/Button";
import { Card } from "../../../components/Card";
import { getScenario, type SandboxScenarioId } from "../../../lib/sandbox-scenarios";
import type { ReplayStrategy } from "../../../lib/sandbox-replay";
import { TAPE_PRESETS, summariseResponse } from "../hooks/useScenarioRecorder";
import type { UseScenarioRecorderResult } from "../hooks/useScenarioRecorder";

interface TransactionScenarioRecorderProps {
  className?: string;
  /**
   * Recorder state, owned by the parent.
   *
   * The panel owns the hook so the scenario selector can feed the same tape.
   */
  recorder: UseScenarioRecorderResult;
}

const STRATEGIES: ReplayStrategy[] = ["first-match", "sequence", "last-match", "round-robin"];

export function TransactionScenarioRecorder({
  className = "",
  recorder,
}: TransactionScenarioRecorderProps) {
  const [importText, setImportText] = useState("");
  const [selectedScenario, setSelectedScenario] = useState<SandboxScenarioId>("out_of_energy");

  const handleExport = () => {
    const json = recorder.exportTape();
    if (json) setImportText(json);
  };

  return (
    <Card className={className}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-white">Transaction scenario recorder</h2>
          <p className="mt-1 text-sm text-gray-400">
            Record the mock adapter&apos;s responses once, then replay them deterministically. The
            replay adapter is published to the sandbox, so later adapter calls return the tape.
          </p>
        </div>
        <span
          data-testid="recorder-status"
          className={`rounded-full border px-3 py-1 text-xs ${
            recorder.isRecording
              ? "border-red-400/60 text-red-300"
              : "border-trellis-vine/40 text-gray-300"
          }`}
        >
          {recorder.isRecording ? "recording" : "idle"}
        </span>
      </div>

      {/* Record controls */}
      <div className="mt-5 flex flex-wrap items-end gap-2">
        <Button size="sm" onClick={recorder.start} disabled={recorder.isRecording} data-testid="recorder-start">
          Start recording
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={recorder.stop}
          disabled={!recorder.isRecording}
          data-testid="recorder-stop"
        >
          Stop
        </Button>
        <Button size="sm" variant="outline" onClick={recorder.clear} data-testid="recorder-clear">
          Clear tape
        </Button>

        <div className="flex items-end gap-2">
          <label className="text-xs uppercase tracking-wide text-gray-400" htmlFor="recorder-scenario">
            Scenario
            <select
              id="recorder-scenario"
              data-testid="recorder-scenario"
              value={selectedScenario}
              onChange={(event) => setSelectedScenario(event.target.value as SandboxScenarioId)}
              className="mt-1 block rounded border border-gray-700 bg-gray-900/60 px-2 py-1 text-sm text-white outline-none focus:border-trellis-vine"
            >
              {recorder.scenarios.map((id) => (
                <option key={id} value={id}>
                  {getScenario(id).label}
                </option>
              ))}
            </select>
          </label>
          <Button
            size="sm"
            variant="outline"
            onClick={() => recorder.recordScenario(selectedScenario)}
            data-testid="recorder-record-scenario"
          >
            Record scenario
          </Button>
        </div>
      </div>

      {/* Preset tapes */}
      <div className="mt-5">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400">Preset tapes</h3>
        <div className="mt-2 flex flex-wrap gap-2" data-testid="recorder-presets">
          {TAPE_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              title={preset.description}
              data-testid={`recorder-preset-${preset.id}`}
              onClick={() => recorder.loadPreset(preset.id)}
              className="rounded-full border border-trellis-vine/40 px-3 py-1 text-xs text-gray-200 transition-smooth hover:border-trellis-vine hover:bg-trellis-vine/10"
            >
              {preset.name} ({preset.scenarioIds.length})
            </button>
          ))}
        </div>
      </div>

      {/* Replay policy */}
      <div className="mt-5 flex flex-wrap items-end gap-4">
        <label className="text-xs uppercase tracking-wide text-gray-400" htmlFor="recorder-strategy">
          Strategy
          <select
            id="recorder-strategy"
            data-testid="recorder-strategy"
            value={recorder.policy.strategy}
            onChange={(event) =>
              recorder.setPolicy({ strategy: event.target.value as ReplayStrategy })
            }
            className="mt-1 block rounded border border-gray-700 bg-gray-900/60 px-2 py-1 text-sm text-white outline-none focus:border-trellis-vine"
          >
            {STRATEGIES.map((strategy) => (
              <option key={strategy} value={strategy}>
                {strategy}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-2 text-xs text-gray-300">
          <input
            type="checkbox"
            data-testid="recorder-match-request"
            checked={recorder.policy.matchRequest}
            onChange={(event) => recorder.setPolicy({ matchRequest: event.target.checked })}
          />
          Match request body
        </label>

        <label className="text-xs uppercase tracking-wide text-gray-400" htmlFor="recorder-latency">
          Latency (ms)
          <input
            id="recorder-latency"
            type="number"
            min={0}
            data-testid="recorder-latency"
            value={recorder.policy.latencyMs}
            onChange={(event) =>
              recorder.setPolicy({ latencyMs: Number(event.target.value) || 0 })
            }
            className="mt-1 block w-24 rounded border border-gray-700 bg-gray-900/60 px-2 py-1 text-sm text-white outline-none focus:border-trellis-vine"
          />
        </label>

        <label className="text-xs uppercase tracking-wide text-gray-400" htmlFor="recorder-exhausted">
          On exhausted
          <select
            id="recorder-exhausted"
            data-testid="recorder-exhausted"
            value={recorder.policy.onExhausted}
            onChange={(event) =>
              recorder.setPolicy({ onExhausted: event.target.value as "error" | "last" })
            }
            className="mt-1 block rounded border border-gray-700 bg-gray-900/60 px-2 py-1 text-sm text-white outline-none focus:border-trellis-vine"
          >
            <option value="error">throw</option>
            <option value="last">reuse last</option>
          </select>
        </label>
      </div>

      {/* Tape contents */}
      <div className="mt-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400">Tape</h3>
          <p className="text-xs text-gray-400" data-testid="recorder-tape-summary">
            {recorder.tapeSummary}
          </p>
        </div>

        {recorder.interactions.length === 0 ? (
          <p className="mt-2 text-xs text-gray-500" data-testid="recorder-tape-empty">
            No interactions recorded yet. Start recording, record a scenario, or load a preset tape.
          </p>
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[34rem] border-collapse text-xs" data-testid="recorder-tape">
              <thead>
                <tr className="text-left uppercase tracking-wide text-gray-400">
                  <th className="pb-2 pr-2">#</th>
                  <th className="pb-2 pr-2">Method</th>
                  <th className="pb-2 pr-2">Scenario</th>
                  <th className="pb-2 pr-2">Result</th>
                  <th className="pb-2 pr-2">Duration</th>
                  <th className="pb-2 pr-2">Request key</th>
                  <th className="pb-2" />
                </tr>
              </thead>
              <tbody>
                {recorder.interactions.map((interaction, index) => (
                  <tr key={interaction.id} className="border-t border-gray-800">
                    <td className="py-2 pr-2 text-gray-400">{interaction.seq}</td>
                    <td className="py-2 pr-2 font-mono text-gray-200">{interaction.method}</td>
                    <td className="py-2 pr-2 text-gray-300">{interaction.scenarioId ?? "—"}</td>
                    <td
                      className={`py-2 pr-2 ${interaction.response.success ? "text-emerald-300" : "text-red-300"}`}
                    >
                      {summariseResponse(interaction.response)}
                    </td>
                    <td className="py-2 pr-2 text-gray-400">{interaction.durationMs}ms</td>
                    <td className="py-2 pr-2 font-mono text-gray-500">{interaction.requestKey}</td>
                    <td className="py-2 text-right">
                      <button
                        type="button"
                        data-testid={`recorder-replay-${index}`}
                        onClick={() => void recorder.replayOne(interaction)}
                        className="rounded px-2 py-1 text-[0.7rem] text-trellis-amber transition-smooth hover:bg-trellis-amber/10"
                      >
                        Replay
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          size="sm"
          onClick={() => void recorder.replayAll()}
          disabled={recorder.interactions.length === 0 || recorder.isReplaying}
          data-testid="recorder-replay-all"
        >
          {recorder.isReplaying ? "Replaying…" : "Replay tape"}
        </Button>
        <Button size="sm" variant="outline" onClick={handleExport} data-testid="recorder-export">
          Export JSON
        </Button>
        <Button size="sm" variant="secondary" onClick={recorder.downloadTape} data-testid="recorder-download">
          Download tape
        </Button>
      </div>

      {recorder.replayed.length > 0 && (
        <ul className="mt-4 space-y-1 text-xs" data-testid="recorder-replay-results">
          {recorder.replayed.map((result) => (
            <li key={result.interactionId} className="text-gray-300">
              <span className="font-mono text-gray-500">#{result.seq}</span>{" "}
              <span className="font-mono">{result.method}</span>{" "}
              <span className={result.success ? "text-emerald-300" : "text-red-300"}>
                {result.summary}
              </span>
            </li>
          ))}
        </ul>
      )}

      {recorder.verify && (recorder.verify.issues.length > 0 || recorder.verify.warnings.length > 0) && (
        <div className="mt-4 space-y-1 text-xs" data-testid="recorder-verify">
          {recorder.verify.issues.map((issue) => (
            <p key={issue} className="text-red-300">
              ✕ {issue}
            </p>
          ))}
          {recorder.verify.warnings.map((warning) => (
            <p key={warning} className="text-trellis-amber">
              ⚠ {warning}
            </p>
          ))}
        </div>
      )}

      <div className="mt-5">
        <label className="text-xs uppercase tracking-wide text-gray-400" htmlFor="recorder-import">
          Tape JSON (import / export)
        </label>
        <textarea
          id="recorder-import"
          data-testid="recorder-import"
          value={importText}
          onChange={(event) => setImportText(event.target.value)}
          rows={4}
          placeholder='{"name":"my tape","interactions":[…] }'
          className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-900/60 px-3 py-2 font-mono text-xs text-white outline-none focus:border-trellis-vine"
        />
        <div className="mt-2 flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => recorder.importTape(importText)}
            data-testid="recorder-import-apply"
          >
            Load JSON into tape
          </Button>
        </div>
      </div>

      {recorder.error && (
        <div
          data-testid="recorder-error"
          className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300"
        >
          {recorder.error}
        </div>
      )}

      <p className="mt-4 text-xs text-gray-500" data-testid="recorder-position">
        Adapter position {recorder.position} · strategy {recorder.policy.strategy} ·{" "}
        {recorder.policy.matchRequest ? "request matching on" : "method matching only"}
      </p>
    </Card>
  );
}

export default TransactionScenarioRecorder;
