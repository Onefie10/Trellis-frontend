import { TestCase, TestExecution } from "./types";
import { ProvenanceRecord } from "../provenance/types";

// Mock in-memory database
let testCases: TestCase[] = [];
let testExecutions: TestExecution[] = [];
let provenanceRecords: ProvenanceRecord[] = [
  {
    id: "pv-1",
    agentId: "ag-1",
    agentName: "Canopy Predictor",
    userId: "user-123",
    userName: "Alex Explorer",
    action: "input_received",
    timestamp: new Date(Date.now() - 3600000).toISOString(),
    status: "success",
    details: { input: "Predict market volatility for XLM/USDC" }
  },
  {
    id: "pv-2",
    agentId: "ag-1",
    agentName: "Canopy Predictor",
    userId: "user-123",
    userName: "Alex Explorer",
    action: "provider_call",
    timestamp: new Date(Date.now() - 3500000).toISOString(),
    status: "success",
    provider: "OpenAI",
    details: { payload: { model: "gpt-4", prompt: "..." } }
  },
  {
    id: "pv-3",
    agentId: "ag-1",
    agentName: "Canopy Predictor",
    userId: "user-123",
    userName: "Alex Explorer",
    action: "on_chain_submission",
    timestamp: new Date(Date.now() - 3400000).toISOString(),
    status: "success",
    txHash: "GCB...123",
    details: { 
      payload: { amount: "100", asset: "XLM" },
      proof: {
        leafHash: "d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592", // SHA256 of leaf
        siblingHashes: ["b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"], // SHA256 of sibling
        rootHash: "7b0b2ce28f804dcde9ef3ec04fb49dfc1eb603bc2e2a2221baeebeffb5d7d3d7"
      }
    }
  },
  {
    id: "pv-4",
    agentId: "ag-2",
    agentName: "Nebula Guard",
    userId: "user-456",
    userName: "Sam Security",
    action: "error_encountered",
    timestamp: new Date(Date.now() - 1800000).toISOString(),
    status: "failure",
    details: { error: "Contract not found on network" }
  }
];

export const db = {
  testCases: {
    findMany: async () => [...testCases],
    findUnique: async (id: string) => testCases.find((tc) => tc.id === id),
    create: async (data: Omit<TestCase, "id" | "createdAt" | "updatedAt">) => {
      const newTestCase: TestCase = {
        ...data,
        id: Math.random().toString(36).substring(2, 9),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      testCases.push(newTestCase);
      return newTestCase;
    },
  },
  testExecutions: {
    findMany: async (filter?: { testCaseId?: string }) => {
      if (filter?.testCaseId) {
        return testExecutions.filter(
          (te) => te.testCaseId === filter.testCaseId,
        );
      }
      return [...testExecutions];
    },
    create: async (data: Omit<TestExecution, "id" | "startTime">) => {
      const newExecution: TestExecution = {
        ...data,
        id: Math.random().toString(36).substring(2, 9),
        startTime: new Date().toISOString(),
      };
      testExecutions.push(newExecution);
      return newExecution;
    },
    update: async (id: string, data: Partial<TestExecution>) => {
      const index = testExecutions.findIndex((te) => te.id === id);
      if (index !== -1) {
        testExecutions[index] = { ...testExecutions[index], ...data };
        return testExecutions[index];
      }
      return null;
    },
  },
  provenance: {
    findMany: async () => [...provenanceRecords],
    create: async (data: ProvenanceRecord) => {
      provenanceRecords.push(data);
      return data;
    }
  }
};
