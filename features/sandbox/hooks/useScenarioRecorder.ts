"use client";

/**
 * Transaction scenario recorder + replay adapter state.
 *
 * Wraps `ScenarioRecorder` and `TransactionReplayAdapter` so the UI can:
 *   - record the mock adapter's responses for a scenario
 *   - load one of the preset tapes (Out of Energy → Invalid Sequence → Tx Expired)
 *   - export / import a tape as JSON
 *   - replay the tape and see exactly what the adapters would return
 *
 * The adapter is published to `sandboxManager`, so anything calling
 * `MockStellarAdapter` afterwards sees the replayed responses instead of the
 * default fixtures.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { sandboxManager, type SandboxStatusSnapshot } from "../../../lib/sandbox";
import {
  DEFAULT_REPLAY_POLICY,
  ScenarioRecorder,
  TAPE_PRESETS,
  TransactionReplayAdapter,
  buildTapeFromPreset,
  buildTapeFromScenarios,
  parseTape,
  scenarioRequest,
  scenarioToResponse,
  summariseTape,
  type RecordedInteraction,
  type ReplayPolicy,
  type ReplayTape,
  type SandboxResponse,
} from "../../../lib/sandbox-replay";
import { SCENARIO_PRESETS, getScenario, type SandboxScenarioId } from "../../../lib/sandbox-scenarios";
import type { ReplayRunResult } from "../types";

/** One-line summary of a replayed response, for the results list. */
export function summariseResponse(response: SandboxResponse<unknown>): string {
  if (response.success) {
    const data = response.data as Record<string, unknown> | undefined;
    const detail = data?.status ?? data?.hash ?? data?.balance ?? "ok";
    return `success · ${String(detail).slice(0, 24)}`;
  }
  const code = response.code ?? "FAILED";
  return `${code}${response.error ? ` · ${response.error.slice(0, 80)}` : ""}`;
}

export interface UseScenarioRecorderResult {
  tape: ReplayTape | null;
  tapeSummary: string;
  interactions: RecordedInteraction[];
  isRecording: boolean;
  isReplaying: boolean;
  replayed: ReplayRunResult[];
  policy: ReplayPolicy;
  setPolicy: (patch: Partial<ReplayPolicy>) => void;
  verify: { ok: boolean; issues: string[]; warnings: string[] } | null;
  error: string | null;
  /** Position of the active adapter within the tape. */
  position: number;
  start: () => void;
  stop: () => void;
  clear: () => void;
  recordScenario: (scenarioId: SandboxScenarioId) => void;
  loadPreset: (presetId: string) => void;
  loadScenarios: (scenarioIds: SandboxScenarioId[]) => void;
  importTape: (json: string) => boolean;
  exportTape: () => string | null;
  downloadTape: () => void;
  replayAll: () => Promise<ReplayRunResult[]>;
  replayOne: (interaction: RecordedInteraction) => Promise<ReplayRunResult>;
  adapter: TransactionReplayAdapter | null;
  scenarios: SandboxScenarioId[];
}

export function useScenarioRecorder(): UseScenarioRecorderResult {
  const [recorder] = useState(() => new ScenarioRecorder({ name: "UI sandbox tape" }));
  const [tape, setTape] = useState<ReplayTape | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [isReplaying, setIsReplaying] = useState(false);
  const [policy, setPolicyState] = useState<ReplayPolicy>(DEFAULT_REPLAY_POLICY);
  const [replayed, setReplayed] = useState<ReplayRunResult[]>([]);
  const [error, setError] = useState<string | null>(null);

  const adapter = useMemo(
    () => (tape ? new TransactionReplayAdapter(tape, policy) : null),
    [tape, policy],
  );

  useEffect(() => {
    sandboxManager.setReplayAdapter(adapter);
    return () => {
      sandboxManager.setReplayAdapter(null);
    };
  }, [adapter]);

  const syncTape = useCallback(
    (next: ReplayTape | null) => {
      setTape(next);
      setReplayed([]);
    },
    [],
  );

  const start = useCallback(() => {
    recorder.start();
    sandboxManager.setRecorder(recorder);
    setIsRecording(true);
    setError(null);
  }, [recorder]);

  const stop = useCallback(() => {
    recorder.stop();
    setIsRecording(false);
    syncTape(recorder.toTape());
  }, [recorder, syncTape]);

  const clear = useCallback(() => {
    recorder.stop();
    recorder.clear();
    setIsRecording(false);
    syncTape(null);
    setError(null);
  }, [recorder, syncTape]);

  /** Records the mock adapter's responses for one scenario into the tape. */
  const recordScenario = useCallback(
    (scenarioId: SandboxScenarioId) => {
      try {
        const scenario = getScenario(scenarioId);
        const request = scenarioRequest(scenarioId, recorder.size);
        const response = scenarioToResponse(scenarioId);
        const hash = (response.data as { hash?: string } | undefined)?.hash;

        recorder.record("submitTransaction", request, response, {
          force: true,
          label: scenario.label,
          scenarioId,
          durationMs: 18,
        });

        if (hash) {
          recorder.record(
            "getTransactionStatus",
            { hash },
            {
              ...response,
              data: { status: response.success ? "confirmed" : "failed", hash },
            },
            {
              force: true,
              label: `${scenario.label} (confirmation)`,
              scenarioId,
              durationMs: 9,
            },
          );
        }

        syncTape(recorder.toTape());
        setError(null);
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure));
      }
    },
    [recorder, syncTape],
  );

  const loadPreset = useCallback(
    (presetId: string) => {
      try {
        const built = buildTapeFromPreset(presetId);
        recorder.clear();
        recorder.load(built);
        syncTape(recorder.toTape());
        setError(null);
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure));
      }
    },
    [recorder, syncTape],
  );

  const loadScenarios = useCallback(
    (scenarioIds: SandboxScenarioId[]) => {
      try {
        const built = buildTapeFromScenarios(scenarioIds, { name: "Selected scenarios" });
        recorder.clear();
        recorder.load(built);
        syncTape(recorder.toTape());
        setError(null);
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure));
      }
    },
    [recorder, syncTape],
  );

  const importTape = useCallback(
    (json: string): boolean => {
      try {
        const parsed = parseTape(json);
        recorder.clear();
        recorder.load(parsed);
        syncTape(recorder.toTape());
        setError(null);
        return true;
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure));
        return false;
      }
    },
    [recorder, syncTape],
  );

  const exportTape = useCallback((): string | null => {
    if (!tape) {
      setError("Nothing to export — record or load a tape first.");
      return null;
    }
    return JSON.stringify(tape, null, 2);
  }, [tape]);

  const downloadTape = useCallback(() => {
    const json = exportTape();
    if (!json || typeof document === "undefined") return;
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${tape?.id ?? "sandbox-tape"}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }, [exportTape, tape]);

  const replayOne = useCallback(
    async (interaction: RecordedInteraction): Promise<ReplayRunResult> => {
      if (!adapter) {
        const message = "No tape loaded — record or load one before replaying.";
        setError(message);
        return {
          interactionId: interaction.id,
          seq: interaction.seq,
          method: interaction.method,
          success: false,
          summary: message,
        };
      }

      try {
        const response = await adapter.replay(interaction.method, interaction.request);
        return {
          interactionId: interaction.id,
          seq: interaction.seq,
          method: interaction.method,
          success: response.success,
          summary: summariseResponse(response),
        };
      } catch (failure) {
        return {
          interactionId: interaction.id,
          seq: interaction.seq,
          method: interaction.method,
          success: false,
          summary: failure instanceof Error ? failure.message : String(failure),
        };
      }
    },
    [adapter],
  );

  const replayAll = useCallback(async (): Promise<ReplayRunResult[]> => {
    if (!adapter) {
      setError("No tape loaded — record or load one before replaying.");
      return [];
    }

    setIsReplaying(true);
    adapter.reset();
    const results: ReplayRunResult[] = [];

    // Replayed in recorded order so the `sequence` strategy stays meaningful.
    for (const interaction of adapter.getTape().interactions) {
      results.push(await replayOne(interaction));
    }

    setReplayed(results);
    setIsReplaying(false);
    setError(null);
    return results;
  }, [adapter, replayOne]);

  const setPolicy = useCallback((patch: Partial<ReplayPolicy>) => {
    setPolicyState((current) => ({ ...current, ...patch }));
  }, []);

  const interactions = tape?.interactions ?? [];
  const verify = useMemo(() => (adapter ? adapter.verify() : null), [adapter]);

  return {
    tape,
    tapeSummary: tape ? summariseTape(tape) : "No tape loaded",
    interactions,
    isRecording,
    isReplaying,
    replayed,
    policy,
    setPolicy,
    verify,
    error,
    position: adapter?.position ?? 0,
    start,
    stop,
    clear,
    recordScenario,
    loadPreset,
    loadScenarios,
    importTape,
    exportTape,
    downloadTape,
    replayAll,
    replayOne,
    adapter,
    scenarios: SCENARIO_PRESETS.map((scenario) => scenario.id),
  };
}

/** Tape presets, re-exported so the selector does not import `lib/` directly. */
export { TAPE_PRESETS };

/** Snapshot of the whole sandbox, re-read on every manager change. */
export function useSandboxSnapshot(): SandboxStatusSnapshot {
  const [snapshot, setSnapshot] = useState<SandboxStatusSnapshot>(() =>
    sandboxManager.getSnapshot(),
  );

  useEffect(() => {
    setSnapshot(sandboxManager.getSnapshot());
    return sandboxManager.subscribe(() => {
      setSnapshot(sandboxManager.getSnapshot());
    });
  }, []);

  return snapshot;
}
