"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { BugReport } from "@/types/bug-report";
import type { BugReportStatus, FilterState } from "@/lib/bug-reports-pagination";
import {
  filterStateToURLParams,
  urlParamsToFilterParams,
  applyOptimisticUpdate,
} from "@/lib/bug-reports-pagination";

export function useFilterPersistence(): {
  filters: FilterState;
  setFilters: (filters: FilterState) => void;
  clearFilters: () => void;
} {
  const searchParams = useSearchParams();
  const [filters, setFilters] = useState<FilterState>(() => {
    if (typeof window === "undefined") return { status: "all", severity: "all", author: "", tag: "all" };
    const params = Object.fromEntries(searchParams.entries());
    return {
      status: (params.status as BugReportStatus) || "all",
      severity: params.severity || "all",
      author: params.author || "",
      tag: params.tag || "all",
    };
  });

  const setFiltersWithURL = useCallback((newFilters: FilterState) => {
    setFilters(newFilters);
    const params = filterStateToURLParams(newFilters);
    const queryString = new URLSearchParams(params as Record<string, string>).toString();
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.search = queryString;
      window.history.replaceState({}, "", url.toString());
    }
  }, [searchParams]);

  const clearFilters = useCallback(() => {
    setFilters({ status: "all", severity: "all", author: "", tag: "all" });
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.search = "";
      window.history.replaceState({}, "", url.toString());
    }
  }, []);

  useEffect(() => {
    const params = Object.fromEntries(searchParams.entries());
    setFilters({
      status: (params.status as BugReportStatus) || "all",
      severity: params.severity || "all",
      author: params.author || "",
      tag: params.tag || "all",
    });
  }, [searchParams]);

  return { filters, setFilters: setFiltersWithURL, clearFilters };
}

export function useOptimisticReportUpdate() {
  const [pendingUpdates, setPendingUpdates] = useState<Map<string, Partial<BugReport>>>(new Map());

  const addOptimisticUpdate = useCallback((reportId: string, updates: Partial<BugReport>) => {
    setPendingUpdates((prev) => {
      const next = new Map(prev);
      next.set(reportId, updates);
      return next;
    });
  }, []);

  const confirmUpdate = useCallback((reportId: string) => {
    setPendingUpdates((prev) => {
      const next = new Map(prev);
      next.delete(reportId);
      return next;
    });
  }, []);

  const rollbackUpdate = useCallback((reportId: string) => {
    setPendingUpdates((prev) => {
      const next = new Map(prev);
      next.delete(reportId);
      return next;
    });
  }, []);

  const getOptimisticReport = useCallback((report: BugReport): BugReport => {
    const updates = pendingUpdates.get(report.id);
    return updates ? { ...report, ...updates } : report;
  }, [pendingUpdates]);

  return {
    addOptimisticUpdate,
    confirmUpdate,
    rollbackUpdate,
    getOptimisticReport,
    pendingUpdates: Array.from(pendingUpdates.values()),
  };
}
