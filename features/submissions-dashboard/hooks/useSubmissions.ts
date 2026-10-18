"use client";

import { useState, useEffect } from "react";
import { Submission } from "../types";

interface UseSubmissionsResult {
  data: Submission[];
  loading: boolean;
}

import { scanSubmissionContent } from "../utils/scanner";
import { DependencyLicense, scanDependencyLicenses } from "../utils/licenseScanner";

function getDependencies(item: Record<string, unknown>): DependencyLicense[] {
  const manifest = item.packageJson ?? item.packageJSON;
  let manifestDependencies: unknown;
  if (typeof manifest === "string") {
    try {
      const parsed = JSON.parse(manifest) as Record<string, unknown>;
      manifestDependencies = parsed.dependencies;
    } catch {
      manifestDependencies = undefined;
    }
  } else if (typeof manifest === "object" && manifest !== null) {
    manifestDependencies = (manifest as Record<string, unknown>).dependencies;
  }

  const rawDependencies = item.dependencies ?? item.packages ?? manifestDependencies;
  if (Array.isArray(rawDependencies)) {
    return rawDependencies.flatMap((dependency, index) => {
      if (typeof dependency === "string") return [{ name: dependency }];
      if (typeof dependency !== "object" || dependency === null) return [];
      const value = dependency as Record<string, unknown>;
      const name = String(value.name ?? value.package ?? value.id ?? `Dependency ${index + 1}`);
      const license = value.license ?? value.licenseExpression ?? value.spdx;
      return [{ name, license: typeof license === "string" ? license : undefined }];
    });
  }

  if (typeof rawDependencies === "object" && rawDependencies !== null) {
    return Object.entries(rawDependencies as Record<string, unknown>).map(([name, value]) => {
      if (typeof value === "string") return { name };
      if (typeof value !== "object" || value === null) return { name };
      const metadata = value as Record<string, unknown>;
      const license = metadata.license ?? metadata.licenseExpression ?? metadata.spdx;
      return { name, license: typeof license === "string" ? license : undefined };
    });
  }

  return [];
}

const normalizeSubmission = (input: unknown): Submission | null => {
  if (typeof input !== "object" || input === null) {
    return null;
  }

  const item = input as Record<string, unknown>;

  const id = String(item.id ?? item._id ?? "");
  const txHash = String(item.txHash ?? item.hash ?? "");
  const status = String(item.status ?? item.state ?? "pending");
  const rawTimestamp = item.timestamp ?? item.createdAt ?? item.time ?? "";
  const timestamp: string | number =
    typeof rawTimestamp === "number" ? rawTimestamp : String(rawTimestamp);
  const error = item.error ? String(item.error) : undefined;
  
  // Extract content, default to empty string if missing
  const content = String(item.content ?? item.code ?? item.description ?? "");
  const securityScan = scanSubmissionContent(content);
  const licenseAudit = scanDependencyLicenses(getDependencies(item));

  if (!id || !txHash) {
    return null;
  }

  const submission: Submission = {
    id,
    txHash,
    status,
    timestamp,
    content,
    securityScan,
    licenseAudit,
  };

  if (error) {
    submission.error = error;
  }

  return submission;
};

export function useSubmissions(): UseSubmissionsResult {
  const [data, setData] = useState<Submission[]>([]);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    let cancelled = false;

    const fetchSubmissions = async () => {
      setLoading(true);

      try {
        const res = await fetch("/api/submissions");
        const responseBody = await res.json();

        console.debug("Submissions response:", responseBody);

        if (cancelled) {
          return;
        }

        if (!Array.isArray(responseBody)) {
          setData([]);
          setLoading(false);
          return;
        }

        const normalized = responseBody
          .map(normalizeSubmission)
          .filter((entry): entry is Submission => entry !== null);

        setData(normalized);
      } catch (error) {
        console.error("Failed to load submissions", error);
        setData([]);
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    fetchSubmissions();

    return () => {
      cancelled = true;
    };
  }, []);

  return { data, loading };
}
