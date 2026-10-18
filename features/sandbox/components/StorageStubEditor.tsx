"use client";

/**
 * Soroban storage state editor
 *
 * Define Instance, Persistent and Temporary contract storage entries, inject
 * them into the sandbox (the mock RPC then serves them from
 * `getLedgerEntries`), save recurring states as presets, and move them between
 * machines as JSON fixtures.
 */

import React, { useEffect, useMemo, useState } from "react";
import { Button } from "../../../components/Button";
import { Card } from "../../../components/Card";
import { sandboxManager } from "../../../lib/sandbox";
import {
  BUILT_IN_STORAGE_PRESETS,
  SOROBAN_STORAGE_TYPES,
  STORAGE_SCVAL_TYPES,
  STUB_CONTRACT_ID,
  createStubId,
  deleteStoragePreset,
  exportStorageFixture,
  importStorageFixture,
  instantiatePreset,
  loadSavedStoragePresets,
  saveStoragePreset,
  serializeStorageStubs,
  validateStorageStub,
  type SorobanStorageType,
  type StorageScValType,
  type StorageStubEntry,
  type StorageStubPreset,
} from "../../../lib/sandbox-storage";

const STORAGE_LABELS: Record<SorobanStorageType, string> = {
  instance: "Instance",
  persistent: "Persistent",
  temporary: "Temporary",
};

const STORAGE_HELP: Record<SorobanStorageType, string> = {
  instance: "Lives with the contract instance and shares its TTL — config such as Admin or Paused.",
  persistent: "Long-lived per-key entries such as balances; archived (not deleted) when the TTL lapses.",
  temporary: "Cheap short-lived entries such as nonces; deleted for good when the TTL lapses.",
};

const inputClass =
  "rounded border border-gray-700 bg-gray-900/60 px-2 py-1 text-white outline-none focus:border-trellis-vine";

function blankEntry(storage: SorobanStorageType, contractId: string): StorageStubEntry {
  return {
    id: createStubId(),
    contractId,
    storage,
    key: "",
    keyType: "symbol",
    value: "",
    valueType: storage === "instance" ? "bool" : "i128",
  };
}

interface StorageStubEditorProps {
  className?: string;
}

export function StorageStubEditor({ className = "" }: StorageStubEditorProps) {
  const [activeType, setActiveType] = useState<SorobanStorageType>("instance");
  const [entries, setEntries] = useState<StorageStubEntry[]>(() => sandboxManager.getStorageStubs());
  const [savedPresets, setSavedPresets] = useState<StorageStubPreset[]>([]);
  const [presetName, setPresetName] = useState("");
  const [fixtureText, setFixtureText] = useState("");
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [injectedCount, setInjectedCount] = useState(() => sandboxManager.getStorageStubs().length);

  useEffect(() => {
    setSavedPresets(loadSavedStoragePresets());
    return sandboxManager.subscribe(() => setInjectedCount(sandboxManager.getStorageStubs().length));
  }, []);

  const visible = entries.filter((entry) => entry.storage === activeType);
  const errorsById = useMemo(() => {
    const map = new Map<string, string>();
    for (const entry of entries) {
      const [error] = validateStorageStub(entry);
      if (error) map.set(entry.id, `${error.field ?? "entry"}: ${error.message}`);
    }
    return map;
  }, [entries]);

  const update = (id: string, patch: Partial<StorageStubEntry>) =>
    setEntries((current) => current.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)));

  const addEntry = () => {
    const contractId = entries[entries.length - 1]?.contractId ?? STUB_CONTRACT_ID;
    setEntries((current) => [...current, blankEntry(activeType, contractId)]);
  };

  const inject = () => {
    try {
      const response = serializeStorageStubs(entries);
      sandboxManager.setStorageStubs(entries);
      setMessage({
        tone: "ok",
        text: `Injected ${entries.length} stub(s) as ${response.entries.length} ledger entr${
          response.entries.length === 1 ? "y" : "ies"
        }.`,
      });
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    }
  };

  const applyPreset = (preset: StorageStubPreset) => {
    setEntries(instantiatePreset(preset));
    setMessage({ tone: "ok", text: `Loaded preset "${preset.name}". Inject it to apply.` });
  };

  const savePreset = () => {
    try {
      setSavedPresets(saveStoragePreset(presetName, entries));
      setMessage({ tone: "ok", text: `Saved preset "${presetName.trim()}".` });
      setPresetName("");
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    }
  };

  const exportFixture = () => {
    const json = exportStorageFixture(presetName.trim() || "Sandbox storage stubs", entries);
    setFixtureText(json);
    if (typeof window !== "undefined" && typeof URL.createObjectURL === "function") {
      const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = "soroban-storage-stubs.json";
      link.click();
      URL.revokeObjectURL(url);
    }
    setMessage({ tone: "ok", text: "Fixture exported." });
  };

  const importFixture = (json: string) => {
    try {
      const fixture = importStorageFixture(json);
      setEntries(fixture.entries);
      setMessage({ tone: "ok", text: `Imported "${fixture.name}" (${fixture.entries.length} stub(s)).` });
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    }
  };

  return (
    <Card className={className}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-white">Soroban storage stubs</h2>
          <p className="mt-1 text-sm text-gray-400">
            Stub contract storage keys so sandbox runs see a specific on-chain state. Injected stubs are served
            by the mock RPC&apos;s <code>getLedgerEntries</code>.
          </p>
        </div>
        <span
          data-testid="storage-stubs-injected"
          className="rounded-full border border-trellis-vine/40 px-3 py-1 text-xs text-gray-300"
        >
          {injectedCount ? `${injectedCount} injected` : "not injected"}
        </span>
      </div>

      <div className="mt-5 flex flex-wrap gap-2" data-testid="storage-presets">
        {[...BUILT_IN_STORAGE_PRESETS, ...savedPresets].map((preset) => (
          <span key={preset.id} className="inline-flex items-center">
            <button
              type="button"
              data-testid={`storage-preset-${preset.id}`}
              title={preset.description}
              onClick={() => applyPreset(preset)}
              className="rounded-full border border-trellis-vine/40 px-3 py-1 text-xs text-gray-200 transition-smooth hover:border-trellis-vine hover:bg-trellis-vine/10"
            >
              {preset.name}
            </button>
            {!preset.builtIn && (
              <button
                type="button"
                aria-label={`Delete preset ${preset.name}`}
                onClick={() => setSavedPresets(deleteStoragePreset(preset.id))}
                className="ml-1 px-1 text-xs text-red-300 hover:text-red-200"
              >
                ✕
              </button>
            )}
          </span>
        ))}
      </div>

      <div role="tablist" aria-label="Storage type" className="mt-5 flex gap-1 border-b border-gray-800">
        {SOROBAN_STORAGE_TYPES.map((type) => {
          const count = entries.filter((entry) => entry.storage === type).length;
          return (
            <button
              key={type}
              type="button"
              role="tab"
              aria-selected={activeType === type}
              data-testid={`storage-tab-${type}`}
              onClick={() => setActiveType(type)}
              className={`-mb-px border-b-2 px-3 py-2 text-sm ${
                activeType === type ? "border-trellis-vine text-white" : "border-transparent text-gray-400 hover:text-gray-200"
              }`}
            >
              {STORAGE_LABELS[type]} ({count})
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-xs text-gray-500">{STORAGE_HELP[activeType]}</p>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[56rem] border-collapse text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-gray-400">
              <th className="pb-2 pr-2">Contract</th>
              <th className="pb-2 pr-2">Key</th>
              <th className="pb-2 pr-2">Key type</th>
              <th className="pb-2 pr-2">Value</th>
              <th className="pb-2 pr-2">Value type</th>
              {activeType !== "instance" && <th className="pb-2 pr-2">Live until ledger</th>}
              <th className="pb-2" />
            </tr>
          </thead>
          <tbody data-testid="storage-stub-rows">
            {visible.length === 0 && (
              <tr>
                <td colSpan={7} className="py-4 text-center text-xs text-gray-500">
                  No {STORAGE_LABELS[activeType].toLowerCase()} entries yet.
                </td>
              </tr>
            )}
            {visible.map((entry, index) => {
              const error = errorsById.get(entry.id);
              return (
                <React.Fragment key={entry.id}>
                  <tr className="border-t border-gray-800">
                    <td className="py-2 pr-2">
                      <input
                        aria-label={`Contract id, row ${index + 1}`}
                        value={entry.contractId}
                        onChange={(event) => update(entry.id, { contractId: event.target.value })}
                        className={`${inputClass} w-56 font-mono text-xs`}
                      />
                    </td>
                    <td className="py-2 pr-2">
                      <input
                        aria-label={`Key, row ${index + 1}`}
                        data-testid={`storage-row-${index}-key`}
                        value={entry.key}
                        placeholder="Admin"
                        onChange={(event) => update(entry.id, { key: event.target.value })}
                        className={`${inputClass} w-32`}
                      />
                    </td>
                    <td className="py-2 pr-2">
                      <select
                        aria-label={`Key type, row ${index + 1}`}
                        value={entry.keyType}
                        onChange={(event) => update(entry.id, { keyType: event.target.value as StorageScValType })}
                        className={inputClass}
                      >
                        {STORAGE_SCVAL_TYPES.map((type) => (
                          <option key={type} value={type}>
                            {type}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="py-2 pr-2">
                      <input
                        aria-label={`Value, row ${index + 1}`}
                        data-testid={`storage-row-${index}-value`}
                        value={entry.value}
                        onChange={(event) => update(entry.id, { value: event.target.value })}
                        className={`${inputClass} w-48 font-mono text-xs`}
                      />
                    </td>
                    <td className="py-2 pr-2">
                      <select
                        aria-label={`Value type, row ${index + 1}`}
                        data-testid={`storage-row-${index}-value-type`}
                        value={entry.valueType}
                        onChange={(event) => update(entry.id, { valueType: event.target.value as StorageScValType })}
                        className={inputClass}
                      >
                        {STORAGE_SCVAL_TYPES.map((type) => (
                          <option key={type} value={type}>
                            {type}
                          </option>
                        ))}
                      </select>
                    </td>
                    {activeType !== "instance" && (
                      <td className="py-2 pr-2">
                        <input
                          aria-label={`Live until ledger, row ${index + 1}`}
                          type="number"
                          min={1}
                          value={entry.liveUntilLedger ?? ""}
                          placeholder="default"
                          onChange={(event) =>
                            update(entry.id, {
                              liveUntilLedger: event.target.value === "" ? undefined : Number(event.target.value),
                            })
                          }
                          className={`${inputClass} w-28`}
                        />
                      </td>
                    )}
                    <td className="py-2 text-right">
                      <button
                        type="button"
                        aria-label={`Remove storage row ${index + 1}`}
                        onClick={() => setEntries((current) => current.filter((item) => item.id !== entry.id))}
                        className="rounded px-2 py-1 text-xs text-red-300 transition-smooth hover:bg-red-500/10"
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                  {error && (
                    <tr>
                      <td colSpan={7} className="pb-2 text-xs text-red-300" data-testid={`storage-row-${index}-error`}>
                        {error}
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={addEntry} data-testid="storage-add-row">
          Add {STORAGE_LABELS[activeType].toLowerCase()} key
        </Button>
        <Button size="sm" onClick={inject} disabled={errorsById.size > 0} data-testid="storage-inject">
          Inject into sandbox
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            sandboxManager.clearStorageStubs();
            setMessage({ tone: "ok", text: "Cleared injected storage stubs." });
          }}
          data-testid="storage-clear"
        >
          Clear injected stubs
        </Button>
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <div>
          <label htmlFor="storage-preset-name" className="block text-xs uppercase tracking-wide text-gray-400">
            Preset name
          </label>
          <div className="mt-1 flex gap-2">
            <input
              id="storage-preset-name"
              data-testid="storage-preset-name"
              value={presetName}
              placeholder="Paused with custom admin"
              onChange={(event) => setPresetName(event.target.value)}
              className={`${inputClass} flex-1 py-2`}
            />
            <Button size="sm" variant="outline" onClick={savePreset} data-testid="storage-save-preset">
              Save preset
            </Button>
            <Button size="sm" variant="outline" onClick={exportFixture} data-testid="storage-export">
              Export JSON
            </Button>
          </div>
        </div>
        <div>
          <label htmlFor="storage-fixture" className="block text-xs uppercase tracking-wide text-gray-400">
            JSON fixture
          </label>
          <textarea
            id="storage-fixture"
            data-testid="storage-fixture"
            rows={4}
            value={fixtureText}
            onChange={(event) => setFixtureText(event.target.value)}
            placeholder='{"kind":"trellis.soroban-storage-stubs","version":1,...}'
            className={`${inputClass} mt-1 w-full font-mono text-xs`}
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => importFixture(fixtureText)} data-testid="storage-import">
              Import JSON
            </Button>
            <label className="cursor-pointer text-xs text-trellis-leaf underline">
              or choose a file
              <input
                type="file"
                accept="application/json,.json"
                className="sr-only"
                onChange={async (event) => {
                  const file = event.target.files?.[0];
                  if (file) importFixture(await file.text());
                  event.target.value = "";
                }}
              />
            </label>
          </div>
        </div>
      </div>

      {message && (
        <p
          role={message.tone === "error" ? "alert" : "status"}
          data-testid="storage-message"
          className={`mt-4 rounded-lg border p-3 text-sm ${
            message.tone === "error"
              ? "border-red-500/30 bg-red-500/10 text-red-300"
              : "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
          }`}
        >
          {message.text}
        </p>
      )}
    </Card>
  );
}

export default StorageStubEditor;
