import { NextRequest, NextResponse } from "next/server";
import { SorobanSecurityScanner } from "@/lib/security/scanner";
import { runComplianceChecks } from "@/lib/security/compliance";
import { calculateSecurityScore } from "@/lib/security/scoring";
import {
  generateSecurityReport,
  exportReportAsCsv,
  exportReportAsMarkdown,
} from "@/lib/security/report";
import { ScanRequest, AuditRecord } from "@/lib/security/types";
import { isFeatureEnabled } from "@/lib/feature-flags";
import { deniedResponse, requireActor } from "@/lib/auth";
import { checkPermission, type Action, type Scope } from "@/lib/permissions";
import {
  contractAuditStreamId,
  securityAuditLedger,
} from "@/lib/security/audit-ledger";

const auditStore: AuditRecord[] = [];

/**
 * Which matrix action guards each action on this endpoint, and at what scope.
 *
 * `scan` reads a contract the caller supplied, so it stays open to any signed-in
 * user. `export` and `audit-history` reveal one project's security output, so
 * they are checked at `project` scope — which is what lets a maintainer pass and
 * a contributor fail. `record-audit` appends to a per-contract hash chain,
 * which is checked at `global` and is admin-only.
 *
 * Before this change the endpoint had no authorization at all, so any caller
 * could append to the audit trail or export security output.
 */
const ACTION_PERMISSION: Record<string, { action: Action; scope: Scope } | null> = {
  scan: null,
  "audit-history": { action: "view_audit_logs", scope: "project" },
  "ledger-export": { action: "view_audit_logs", scope: "project" },
  export: { action: "export_data", scope: "project" },
  "record-audit": { action: "manage_security", scope: "global" },
};

export async function POST(request: NextRequest) {
  // Identity before parsing, so an anonymous caller cannot use the validation
  // path to probe the endpoint.
  const identity = await requireActor(request);
  if (!identity.ok) return identity.response;

  try {
    const body: ScanRequest & {
      action?: string;
      format?: string;
      confirm?: boolean;
      auditRecord?: AuditRecord;
      streamId?: string;
    } = await request.json();
    const { action } = body;

    const guarded = typeof action === "string" ? ACTION_PERMISSION[action] : undefined;
    if (guarded) {
      // `manage_security` carries a `requires_confirmation` condition, satisfied
      // by an explicit `confirm: true` sent alongside the record.
      const decision = checkPermission(guarded.action, {
        role: identity.actor.role,
        actorId: identity.actor.id,
        resourceScope: guarded.scope,
        context: { confirmed: body.confirm === true },
      });
      if (!decision.allowed) return deniedResponse(decision);
    }

    if (action === "scan") {
      const scanner = new SorobanSecurityScanner(body.network);
      const { context, vulnerabilities, optimizations } =
        await scanner.analyzeContract(body);
      const compliance =
        body.includeCompliance !== false ? runComplianceChecks(context) : [];
      const contractAudits = auditStore.filter(
        (a) => a.contractId === body.contractId,
      );
      const score = calculateSecurityScore(
        vulnerabilities,
        compliance,
        contractAudits,
      );

      const report = generateSecurityReport({
        contractId: body.contractId,
        network: body.network,
        score,
        vulnerabilities,
        compliance,
        optimizations,
        auditHistory: contractAudits,
      });

      return NextResponse.json({ success: true, report });
    }

    if (action === "export") {
      if (!isFeatureEnabled("securityReportExport")) {
        return NextResponse.json(
          { error: "Security report export is not enabled" },
          { status: 404 },
        );
      }

      const scanner = new SorobanSecurityScanner(body.network);
      const { context, vulnerabilities, optimizations } =
        await scanner.analyzeContract(body);
      const compliance = runComplianceChecks(context);
      const contractAudits = auditStore.filter(
        (a) => a.contractId === body.contractId,
      );
      const score = calculateSecurityScore(
        vulnerabilities,
        compliance,
        contractAudits,
      );

      const report = generateSecurityReport({
        contractId: body.contractId,
        network: body.network,
        score,
        vulnerabilities,
        compliance,
        optimizations,
        auditHistory: contractAudits,
      });

      if (body.format === "csv") {
        const csv = exportReportAsCsv(report);
        return new NextResponse(csv, {
          headers: {
            "Content-Type": "text/csv",
            "Content-Disposition": `attachment; filename=security-report-${body.contractId}.csv`,
          },
        });
      }

      if (body.format === "markdown") {
        const md = exportReportAsMarkdown(report);
        return new NextResponse(md, {
          headers: {
            "Content-Type": "text/markdown",
            "Content-Disposition": `attachment; filename=security-report-${body.contractId}.md`,
          },
        });
      }

      return NextResponse.json({ success: true, report });
    }

    if (action === "record-audit") {
      if (body.auditRecord) {
        const ledgerEntry = securityAuditLedger.append({
          streamId: contractAuditStreamId(body.auditRecord.contractId),
          category: "privileged",
          eventType: "security.audit.recorded",
          actorId: identity.actor.id,
          payload: body.auditRecord,
        });
        auditStore.push(body.auditRecord);
        return NextResponse.json({
          success: true,
          message: "Audit recorded",
          ledgerEntry: { sequence: ledgerEntry.sequence, hash: ledgerEntry.hash },
        });
      }
      return NextResponse.json(
        { error: "Missing auditRecord" },
        { status: 400 },
      );
    }

    if (action === "audit-history") {
      const audits = auditStore.filter((a) => a.contractId === body.contractId);
      return NextResponse.json({
        success: true,
        audits,
        ledger: securityAuditLedger.export(contractAuditStreamId(body.contractId ?? "")),
      });
    }

    if (action === "ledger-export") {
      if (typeof body.streamId !== "string" || body.streamId.trim().length === 0) {
        return NextResponse.json({ error: "A ledger streamId is required" }, { status: 400 });
      }
      return NextResponse.json({
        success: true,
        ledger: securityAuditLedger.export(body.streamId),
      });
    }

    return NextResponse.json(
      {
        error: "Invalid action. Use: scan, export, record-audit, audit-history, ledger-export",
      },
      { status: 400 },
    );
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 },
    );
  }
}

export async function GET() {
  return NextResponse.json({
    service: "Trellis Security Scanner",
    version: "1.0.0",
    actions: ["scan", "export", "record-audit", "audit-history", "ledger-export"],
    supported_networks: ["mainnet", "testnet", "futurenet"],
  });
}
