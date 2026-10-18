"use client";

import React, { useEffect, useMemo, useState } from "react";
import { ProvenanceRecord, ProvenanceFilter as FilterType } from "../../../lib/provenance/types";
import { provenanceService } from "../../../lib/provenance/service";
import { provenanceExport } from "../../../lib/provenance/export";
import ProvenanceFilter from "./ProvenanceFilter";
import ZkVerificationBadge from "./ZkVerificationBadge";
import ZkProofInspector from "./ZkProofInspector";
import MerkleProofInspector from "./MerkleProofInspector";
import { extractAttestation } from "../zk/attestation";
import type { AgentExecutionAttestation, ZkVerificationResult } from "../zk/types";

export default function ProvenanceExplorer() {
  const [records, setRecords] = useState<ProvenanceRecord[]>([]);
  const [agents, setAgents] = useState<{ id: string; name: string }[]>([]);
  const [users, setUsers] = useState<{ id: string; name: string }[]>([]);
  const [filter, setFilter] = useState<FilterType>({});
  const [loading, setLoading] = useState(true);
  const [zkResults, setZkResults] = useState<Record<string, ZkVerificationResult>>({});
  const [inspectedRecordId, setInspectedRecordId] = useState<string | null>(null);

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      const [fetchedRecords, fetchedAgents, fetchedUsers] = await Promise.all([
        provenanceService.getRecords(filter),
        provenanceService.getAgents(),
        provenanceService.getUsers(),
      ]);
      setRecords(fetchedRecords);
      setAgents(fetchedAgents);
      setUsers(fetchedUsers);
      setLoading(false);
    };

    fetchData();
  }, [filter]);

  /**
   * Attestations are derived once per record set so their object identity stays
   * stable — the verification badge keys its effect off that identity, and a new
   * object on every render would re-run verification in a loop.
   */
  const attestations = useMemo(() => {
    const map = new Map<string, AgentExecutionAttestation>();
    for (const record of records) {
      const attestation = extractAttestation(record.details.payload);
      if (attestation) map.set(record.id, attestation);
    }
    return map;
  }, [records]);

  const verifiedCount = useMemo(
    () => Object.values(zkResults).filter((entry) => entry.status === "verified").length,
    [zkResults],
  );

  const handleClearFilters = () => setFilter({});

  const handleExportJSON = () => {
    const jsonStr = provenanceExport.toJSON(records);
    provenanceExport.downloadFile(jsonStr, "provenance_records.json", "application/json");
  };

  const handleExportCSV = () => {
    const csvStr = provenanceExport.toCSV(records);
    provenanceExport.downloadFile(csvStr, "provenance_records.csv", "text/csv");
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case "success": return "text-emerald-400 bg-emerald-400/10 border-emerald-400/20";
      case "failure": return "text-rose-400 bg-rose-400/10 border-rose-400/20";
      case "pending": return "text-amber-400 bg-amber-400/10 border-amber-400/20";
      default: return "text-gray-400 bg-gray-400/10 border-gray-400/20";
    }
  };

  const getActionIcon = (action: string) => {
    switch (action) {
      case "input_received": return "📥";
      case "provider_call": return "📡";
      case "on_chain_submission": return "⛓️";
      case "output_generated": return "📤";
      case "error_encountered": return "⚠️";
      default: return "🔹";
    }
  };

  const inspectedAttestation = inspectedRecordId
    ? attestations.get(inspectedRecordId) ?? null
    : null;

  return (
    <div className="space-y-8 animate-fade-in">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold glow-text leading-tight mb-2">Provenance Explorer</h1>
          <p className="text-gray-400 text-sm">Visualize and audit every agent action in the Trellis universe.</p>
        </div>
        <div className="flex gap-6">
          <div className="text-right">
            <p className="text-xs text-gray-500 uppercase tracking-widest font-bold mb-1">Total Actions</p>
            <p className="text-2xl font-bold text-white">{records.length}</p>
          </div>
          <div className="text-right">
            <p className="text-xs text-gray-500 uppercase tracking-widest font-bold mb-1">ZK Attested</p>
            <p className="text-2xl font-bold text-trellis-vine">{attestations.size}</p>
          </div>
          <div className="text-right">
            <p className="text-xs text-gray-500 uppercase tracking-widest font-bold mb-1">ZK Verified</p>
            <p
              className="text-2xl font-bold text-emerald-400"
              data-testid="zk-verified-count"
              aria-label="Cryptographically verified proofs"
            >
              {verifiedCount}
            </p>
          </div>
        </div>
      </div>

      <ProvenanceFilter
        filter={filter}
        agents={agents}
        users={users}
        onFilterChange={setFilter}
        onClear={handleClearFilters}
        onExportJSON={handleExportJSON}
        onExportCSV={handleExportCSV}
      />

      {loading ? (
        <div className="flex justify-center items-center h-64">
          <div className="animate-spin text-4xl">✨</div>
        </div>
      ) : records.length === 0 ? (
        <div className="text-center p-12 rounded-xl border border-trellis-vine/20 nebula-bg">
          <p className="text-gray-500 italic">No provenance records found Matching filters.</p>
        </div>
      ) : (
        <div className="relative">
          {/* Vertical line for timeline */}
          <div className="absolute left-[2.25rem] md:left-1/2 top-4 bottom-4 w-px bg-gradient-to-b from-trellis-vine/50 via-trellis-vine/20 to-transparent hidden md:block" />

          <div className="space-y-8 relative">
            {records.map((record, index) => (
              <div
                key={record.id}
                className={`flex flex-col md:flex-row items-start md:items-center gap-6 group transition-smooth
                  ${index % 2 === 0 ? "md:flex-row" : "md:flex-row-reverse"}`}
              >
                {/* Visual Connector Dot */}
                <div className="absolute left-[2rem] md:left-1/2 -ml-[0.5rem] w-4 h-4 rounded-full bg-trellis-ground border-2 border-trellis-vine/50 z-10 group-hover:scale-125 transition-smooth" />

                <div className={`w-full md:w-[calc(50%-2rem)] p-6 rounded-xl border border-trellis-vine/20 nebula-bg hover:border-trellis-vine/40 transition-smooth
                  ${index % 2 === 0 ? "text-left" : "md:text-right"}`}
                >
                  <div className={`flex flex-wrap gap-2 mb-3 items-center ${index % 2 === 0 ? "" : "md:flex-row-reverse"}`}>
                    <span className="text-xl">{getActionIcon(record.action)}</span>
                    <span className="text-sm font-semibold text-trellis-vine uppercase tracking-tight">
                      {record.action.replace(/_/g, " ")}
                    </span>
                    <span className={`px-2 py-0.5 rounded-full text-[10px] border font-bold uppercase ${getStatusColor(record.status)}`}>
                      {record.status}
                    </span>
                  </div>

                  <h3 className="text-lg font-bold text-white mb-1">{record.agentName}</h3>
                  <p className="text-xs text-gray-500 mb-4 font-mono">
                    {new Date(record.timestamp).toLocaleString()}
                  </p>

                  {attestations.has(record.id) && (
                    <div className="mb-4">
                      <ZkVerificationBadge
                        attestation={attestations.get(record.id)!}
                        onVerified={(result) =>
                          setZkResults((previous) => ({ ...previous, [record.id]: result }))
                        }
                      />
                      <button
                        type="button"
                        onClick={() => setInspectedRecordId(record.id)}
                        className="mt-2 text-[10px] font-semibold uppercase tracking-widest text-gray-400 hover:text-trellis-vine"
                      >
                        Inspect ZK proof →
                      </button>
                    </div>
                  )}

                  <div className={`text-sm text-gray-300 space-y-2 mb-4 bg-trellis-ground/30 p-3 rounded-lg border border-trellis-vine/10 ${index % 2 === 0 ? "" : "md:text-left"}`}>
                    {record.details.input && (
                      <div>
                        <span className="text-[10px] text-gray-500 uppercase block mb-1">Input</span>
                        <p className="italic">&quot;{record.details.input}&quot;</p>
                      </div>
                    )}
                    {record.details.payload && (
                      <div>
                        <span className="text-[10px] text-gray-500 uppercase block mb-1">Payload</span>
                        <pre className="text-[11px] overflow-x-auto bg-black/20 p-2 rounded border border-white/5 scrollbar-thin">
                          {JSON.stringify(record.details.payload, null, 2)}
                        </pre>
                      </div>
                    )}
                    {record.details.error && (
                      <div className="text-rose-400">
                        <span className="text-[10px] text-rose-400/50 uppercase block mb-1">Error</span>
                        <p>{record.details.error}</p>
                      </div>
                    )}
                  </div>

                  <div className={`flex flex-wrap gap-4 text-[10px] text-gray-500 uppercase font-bold tracking-widest ${index % 2 === 0 ? "" : "md:flex-row-reverse"}`}>
                    <div className="flex items-center gap-1.5">
                      <span className="w-1.5 h-1.5 rounded-full bg-trellis-vine/40" />
                      <span>User: {record.userName}</span>
                    </div>
                    {record.provider && (
                      <div className="flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-trellis-vine/40" />
                        <span>Provider: {record.provider}</span>
                      </div>
                    )}
                    {record.txHash && (
                      <div className="flex items-center gap-1.5 truncate max-w-[150px]">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400/40" />
                        <span>TX: {record.txHash}</span>
                      </div>
                    )}
                  </div>

                  {record.details.proof && record.txHash && (
                    <MerkleProofInspector proof={record.details.proof} txHash={record.txHash} />
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {inspectedAttestation && inspectedRecordId && (
        <ZkProofInspector
          attestation={inspectedAttestation}
          result={zkResults[inspectedRecordId] ?? null}
          onClose={() => setInspectedRecordId(null)}
        />
      )}
    </div>
  );
}
