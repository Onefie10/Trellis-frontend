"use client";

import { Fragment } from "react";
import { REDACTION_TOKEN_RE } from "../redaction/patterns";

interface RedactedTextProps {
  /** Already-redacted text; any `[REDACTED:<LABEL>]` tokens become badges. */
  text: string;
  className?: string;
}

/**
 * Render redacted text with each redaction token shown as a badge.
 *
 * This keeps the redaction visible rather than silently blanking content — a
 * reader can tell that a value was withheld, and an auditor reading a screenshot
 * knows the UI was not simply missing data.
 */
export function RedactedText({ text, className = "" }: RedactedTextProps) {
  if (!text) return null;

  const parts = text.split(new RegExp(REDACTION_TOKEN_RE.source, "g"));
  const labels: string[] = [];
  const tokenRe = new RegExp(REDACTION_TOKEN_RE.source, "g");
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(text)) !== null) {
    labels.push(match[0].slice("[REDACTED:".length, -1));
  }

  return (
    <span className={className} data-testid="redacted-text">
      {parts.map((part, index) => (
        <Fragment key={`${index}-${part.slice(0, 8)}`}>
          {part}
          {index < labels.length && (
            <span
              className="mx-0.5 inline-flex items-center rounded border border-amber-300 bg-amber-50 px-1 py-px align-baseline text-[10px] font-semibold uppercase tracking-wide text-amber-800"
              data-redacted-label={labels[index]}
              title={`${labels[index].replace(/_/g, " ").toLowerCase()} was removed before display`}
            >
              {labels[index].replace(/_/g, " ")}
            </span>
          )}
        </Fragment>
      ))}
    </span>
  );
}

export default RedactedText;
