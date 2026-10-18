import { render, screen } from "@testing-library/react";
import { TimelineView } from "../components/TimelineView";
import { safeTimelineResourceHref } from "../components/TimelineEntry";
import { redactTimelineEvent } from "../redaction/redactor";
import { buildTimelineExport, downloadTimelineExport } from "../redaction/exporter";
import type { TimelineEvent } from "../types";
import { formatWebhookPayload } from "@/lib/webhooks";

const event: TimelineEvent = {
  id: "evt-1",
  userId: "user-1",
  type: "claim_settled",
  visibility: "public",
  timestamp: Date.parse("2026-10-01T12:00:00.000Z"),
  title: "Settlement",
  description: `Hello <img src=x onerror=alert(1)> alice@example.com`,
  resourceUrl: "https://trellis.example/claims/1",
};

describe("sensitive content boundaries", () => {
  it("renders attacker supplied markup as text and redacts private values before display", () => {
    render(<TimelineView events={[event]} forPublicView />);

    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText(/Hello <img src=x onerror=alert\(1\)>/)).toBeInTheDocument();
    expect(screen.getByTestId("redaction-badges")).toHaveTextContent("EMAIL");
    expect(screen.queryByText(/alice@example\.com/)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View Details →" })).toHaveAttribute(
      "href",
      "https://trellis.example/claims/1",
    );
  });

  it("does not create executable or protocol-relative resource links", () => {
    expect(safeTimelineResourceHref("javascript:alert(1)")).toBeNull();
    expect(safeTimelineResourceHref("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(safeTimelineResourceHref("//attacker.example/path")).toBeNull();
    expect(safeTimelineResourceHref("/claims/1")).toBe("/claims/1");
  });

  it("exports only redacted text and neutralizes spreadsheet formulas", () => {
    const redacted = redactTimelineEvent({
      ...event,
      description: `=HYPERLINK("https://attacker.example","open") alice@example.com`,
    }).value;
    const exported = buildTimelineExport([redacted], "csv");

    expect(exported.contents).toContain("'=HYPERLINK");
    expect(exported.contents).toContain("[REDACTED:EMAIL]");
    expect(exported.contents).not.toContain("alice@example.com");
  });

  it("downloads the sanitized export and revokes the temporary object URL", () => {
    const originalCreate = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    const originalRevoke = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
    const createObjectURL = jest.fn().mockReturnValue("blob:timeline-export");
    const revokeObjectURL = jest.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
    const click = jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const exported = buildTimelineExport([redactTimelineEvent(event).value], "json");

    try {
      downloadTimelineExport(exported);

      expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
      expect(click).toHaveBeenCalled();
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:timeline-export");
    } finally {
      click.mockRestore();
      if (originalCreate) Object.defineProperty(URL, "createObjectURL", originalCreate);
      else Reflect.deleteProperty(URL, "createObjectURL");
      if (originalRevoke) Object.defineProperty(URL, "revokeObjectURL", originalRevoke);
      else Reflect.deleteProperty(URL, "revokeObjectURL");
    }
  });

  it("removes blocked private fields from nested webhook payloads", () => {
    const payload = formatWebhookPayload("payout_executed", {
      payoutId: "payout-1",
      recipient: { displayName: "A user", email: "private@example.com" },
      apiKey: "secret-token",
      metadata: { nested: { private_key: "do-not-send", status: "settled" } },
    });

    expect(payload.data).toMatchObject({
      payoutId: "payout-1",
      recipient: { displayName: "A user" },
      metadata: { nested: { status: "settled" } },
    });
    expect(JSON.stringify(payload)).not.toContain("private@example.com");
    expect(JSON.stringify(payload)).not.toContain("secret-token");
    expect(JSON.stringify(payload)).not.toContain("do-not-send");
  });
});
