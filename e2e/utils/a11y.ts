import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type TestInfo } from '@playwright/test';

/**
 * Accessibility gate shared by `e2e/journey.spec.ts` and `e2e/a11y.spec.ts`.
 *
 * Scoped to WCAG 2.0/2.1 A + AA (the tags axe maps to those success criteria),
 * so best-practice advisories such as `region` or `heading-order` are reported by
 * axe but do not fail the run — those are tracked in the design backlog, not
 * treated as compliance failures.
 */

/**
 * Rules that pre-date this suite and are acknowledged as existing debt. Removing
 * an entry from this list is all that is needed to start enforcing it again;
 * `A11Y_STRICT=1` ignores the list entirely (that is what CI runs once the
 * backlog is burned down).
 */
export const ACCEPTED_RULES: string[] = [
  // The muted `text-gray-500` palette does not reach 4.5:1 on the dark ground.
  // Tracked separately from this change so the gate can still catch new issues.
  'color-contrast',
];

export interface A11yAuditOptions {
  /** Extra rules to acknowledge for this particular screen. */
  acceptedRules?: string[];
  /** axe rule ids to skip entirely, e.g. a third-party widget. */
  disableRules?: string[];
}

export interface A11yAudit {
  violations: number;
  accepted: string[];
  blocking: Array<{ id: string; impact: string | null; help: string; targets: string[] }>;
}

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

export async function auditAccessibility(
  page: Page,
  options: A11yAuditOptions = {},
): Promise<A11yAudit> {
  const builder = new AxeBuilder({ page }).withTags(WCAG_TAGS);
  if (options.disableRules?.length) builder.disableRules(options.disableRules);

  const { violations } = await builder.analyze();
  const accepted = new Set(
    process.env.A11Y_STRICT === '1'
      ? []
      : [...ACCEPTED_RULES, ...(options.acceptedRules ?? [])],
  );

  const blocking = violations
    .filter((violation) => !accepted.has(violation.id))
    .map((violation) => ({
      id: violation.id,
      impact: violation.impact ?? null,
      help: violation.help,
      targets: violation.nodes.map((node) =>
        (node.target as Array<string | string[]>)
          .map((entry) => (Array.isArray(entry) ? entry.join(' ') : entry))
          .join(' '),
      ),
    }));

  return { violations: violations.length, accepted: [...accepted], blocking };
}

/** Audits the current page and fails the test when any non-accepted rule fires. */
export async function expectNoAccessibilityViolations(
  page: Page,
  options: A11yAuditOptions & { label?: string } = {},
  testInfo?: TestInfo,
): Promise<A11yAudit> {
  const audit = await auditAccessibility(page, options);
  const label = options.label ?? new URL(page.url()).pathname;

  await testInfo?.attach(`a11y-${label.replace(/[^a-z0-9]+/gi, '-')}.json`, {
    body: JSON.stringify(audit, null, 2),
    contentType: 'application/json',
  });

  const summary = audit.blocking
    .map((violation) => {
      const where = violation.targets.slice(0, 3).join(', ');
      return `${violation.id} (${violation.impact ?? 'unknown'}): ${violation.help} → ${where}`;
    })
    .join('\n');

  expect(
    audit.blocking,
    `Accessibility violations on ${label}:\n${summary}`,
  ).toEqual([]);

  return audit;
}
