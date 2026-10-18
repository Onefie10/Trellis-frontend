'use client';

import React, { useCallback, useMemo, useState } from 'react';
import { BUG_CATEGORIES, PRIORITY_LEVELS, type BugReport, type BugReportFormData, type RewardCalculation } from '../types/bug-report';
import { findSimilarReports } from '../lib/bug-reports-pagination';
import { dispatchInvariantAlert, type AlertSeverity } from '../lib/invariant-monitor/report';
import RewardCalculator from './RewardCalculator';
import ScreenshotUpload from './ScreenshotUpload';
import Button from './Button';

interface BugReportFormProps {
  onSubmit: (data: BugReportFormData) => void;
  isSubmitting?: boolean;
  /** Existing reports used to warn the reporter about probable duplicates. */
  existingReports?: BugReport[];
}

const FIELD_ELEMENT_IDS: Record<string, string> = {
  title: 'bug-title',
  description: 'bug-description',
  stepsToReproduce: 'bug-steps',
  expectedBehavior: 'bug-expected',
  actualBehavior: 'bug-actual',
  reporterEmail: 'bug-email',
  agreeToTerms: 'agreeToTerms',
};

const PRIORITY_TO_SEVERITY: Record<string, AlertSeverity> = {
  critical: 'critical',
  high: 'major',
  medium: 'minor',
  low: 'info',
};

const SEVERITY_THRESHOLD: AlertSeverity = 'major';

const SEVERITY_RANK: Record<AlertSeverity, number> = {
  critical: 4,
  major: 3,
  minor: 2,
  info: 1,
};

export const BugReportForm: React.FC<BugReportFormProps> = ({
  onSubmit,
  isSubmitting = false,
  existingReports = []
}) => {
  const [formData, setFormData] = useState<BugReportFormData>({
    title: '',
    description: '',
    stepsToReproduce: '',
    expectedBehavior: '',
    actualBehavior: '',
    priority: 'medium',
    category: 'functionality',
    reporterEmail: '',
    screenshots: [],
    agreeToTerms: false,
    buildVersion: ''
  });

  const [reward, setReward] = useState<RewardCalculation | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const similarReports = useMemo(() => {
    if (formData.title.trim().length < 10) return [];
    return findSimilarReports(
      { title: formData.title, description: formData.description },
      existingReports,
    );
  }, [formData.title, formData.description, existingReports]);

  const activeErrorEntries = useMemo(
    () => Object.entries(errors).filter(([, message]) => Boolean(message)),
    [errors]
  );

  const dispatchViolationAlert = useCallback(
    (data: BugReportFormData, duplicateMatches: typeof similarReports) => {
      const severity = PRIORITY_TO_SEVERITY[data.priority] ?? 'minor';
      const meetsThreshold = SEVERITY_RANK[severity] >= SEVERITY_RANK[SEVERITY_THRESHOLD];

      const affectedRecordIds = duplicateMatches.map((match) => match.report.id);
      const diffContext = [
        `title: ${data.title}`,
        `category: ${data.category}`,
        `priority: ${data.priority}`,
        `buildVersion: ${data.buildVersion || 'unknown'}`,
        `duplicateMatches: ${duplicateMatches.length}`,
      ].join('\n');

      void dispatchInvariantAlert({
        severity,
        immediate: meetsThreshold,
        title: `Bug report invariant violation: ${data.title}`,
        message: data.description,
        diffContext,
        affectedRecordIds,
        metadata: {
          category: data.category,
          priority: data.priority,
          reporterEmail: data.reporterEmail || null,
        },
      }).catch(() => {
        // Alert dispatch must never block bug report submission.
      });
    },
    [],
  );

  const focusField = (fieldKey: string) => {
    const fieldId = FIELD_ELEMENT_IDS[fieldKey] ?? `bug-${fieldKey}`;
    document.getElementById(fieldId)?.focus();
  };

  const validateForm = (): boolean => {
    const newErrors: Record<string, string> = {};

    if (!formData.title.trim()) {
      newErrors.title = 'Title is required';
    } else if (formData.title.length < 10) {
      newErrors.title = 'Title must be at least 10 characters';
    }

    if (!formData.description.trim()) {
      newErrors.description = 'Description is required';
    } else if (formData.description.length < 50) {
      newErrors.description = 'Description must be at least 50 characters';
    }

    if (!formData.stepsToReproduce.trim()) {
      newErrors.stepsToReproduce = 'Steps to reproduce are required';
    }

    if (!formData.expectedBehavior.trim()) {
      newErrors.expectedBehavior = 'Expected behavior is required';
    }

    if (!formData.actualBehavior.trim()) {
      newErrors.actualBehavior = 'Actual behavior is required';
    }

    if (formData.reporterEmail && !formData.reporterEmail.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) {
      newErrors.reporterEmail = 'Please enter a valid email address';
    }

    if (!formData.agreeToTerms) {
      newErrors.agreeToTerms = 'You must agree to the terms and conditions';
    }

    setErrors(newErrors);
    const firstError = Object.keys(newErrors)[0];
    if (firstError) {
      focusField(firstError);
      window.setTimeout(() => {
        focusField(firstError);
      }, 0);
    }
    return Object.keys(newErrors).length === 0;
  };

  const handleInputChange = (field: keyof BugReportFormData, value: string | boolean) => {
    setFormData(prev => ({ ...prev, [field]: value }));
    if (errors[field]) {
      setErrors(prev => ({ ...prev, [field]: '' }));
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!validateForm()) {
      return;
    }

    dispatchViolationAlert(formData, similarReports);
    onSubmit(formData);
  };

  const handleScreenshotsChange = (screenshots: File[]) => {
    setFormData(prev => ({ ...prev, screenshots }));
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6" noValidate aria-label="Bug report submission form">
      {activeErrorEntries.length > 0 && (
        <div
          data-testid="bug-form-error-summary"
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="bg-red-500/10 border border-red-500/50 rounded-lg p-4 text-sm text-red-200"
        >
          <p className="font-semibold">
            Please resolve {activeErrorEntries.length} validation {activeErrorEntries.length === 1 ? 'error' : 'errors'} before submitting.
          </p>
        </div>
      )}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          {/* Basic Information */}
          <div className="bg-trellis-vine/10 border border-trellis-vine/30 rounded-lg p-6 backdrop-blur-sm">
            <h3 className="text-lg font-semibold mb-4 text-trellis-leaf">Basic Information</h3>
            
            <div className="space-y-4">
              <div>
                <label htmlFor="bug-title" className="block text-sm font-medium text-gray-300 mb-2">
                  Bug Title *
                </label>
                <input
                  id="bug-title"
                  name="title"
                  type="text"
                  value={formData.title}
                  onChange={(e) => handleInputChange('title', e.target.value)}
                  className="w-full px-3 py-2 bg-trellis-vine/20 border border-trellis-vine/50 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:border-trellis-leaf focus:ring-1 focus:ring-trellis-leaf"
                  placeholder="Brief summary of the issue"
                  aria-required="true"
                  aria-invalid={Boolean(errors.title)}
                  aria-describedby={errors.title ? 'bug-title-error' : undefined}
                />
                {errors.title && (
                  <p id="bug-title-error" role="alert" className="mt-1 text-sm text-red-400">{errors.title}</p>
                )}
              </div>

              <div>
                <label htmlFor="bug-description" className="block text-sm font-medium text-gray-300 mb-2">
                  Description *
                </label>
                <textarea
                  id="bug-description"
                  name="description"
                  value={formData.description}
                  onChange={(e) => handleInputChange('description', e.target.value)}
                  rows={4}
                  className="w-full px-3 py-2 bg-trellis-vine/20 border border-trellis-vine/50 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:border-trellis-leaf focus:ring-1 focus:ring-trellis-leaf"
                  placeholder="Detailed description of the issue"
                  aria-required="true"
                  aria-invalid={Boolean(errors.description)}
                  aria-describedby={errors.description ? 'bug-description-error' : undefined}
                />
                {errors.description && (
                  <p id="bug-description-error" role="alert" className="mt-1 text-sm text-red-400">{errors.description}</p>
                )}
              </div>
            </div>
          </div>

          {/* Bug Details */}
          <div className="bg-trellis-vine/10 border border-trellis-vine/30 rounded-lg p-6 backdrop-blur-sm">
            <h3 className="text-lg font-semibold mb-4 text-trellis-leaf">Bug Details</h3>
            
            <div className="space-y-4">
              <div>
                <label htmlFor="bug-steps" className="block text-sm font-medium text-gray-300 mb-2">
                  Steps to Reproduce *
                </label>
                <textarea
                  id="bug-steps"
                  name="stepsToReproduce"
                  value={formData.stepsToReproduce}
                  onChange={(e) => handleInputChange('stepsToReproduce', e.target.value)}
                  rows={4}
                  className="w-full px-3 py-2 bg-trellis-vine/20 border border-trellis-vine/50 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:border-trellis-leaf focus:ring-1 focus:ring-trellis-leaf"
                  placeholder="1. Step one&#10;2. Step two&#10;3. Step three"
                  aria-required="true"
                  aria-invalid={Boolean(errors.stepsToReproduce)}
                  aria-describedby={errors.stepsToReproduce ? 'bug-steps-error' : undefined}
                />
                {errors.stepsToReproduce && (
                  <p id="bug-steps-error" role="alert" className="mt-1 text-sm text-red-400">{errors.stepsToReproduce}</p>
                )}
              </div>

              <div>
                <label htmlFor="bug-expected" className="block text-sm font-medium text-gray-300 mb-2">
                  Expected Behavior *
                </label>
                <textarea
                  id="bug-expected"
                  name="expectedBehavior"
                  value={formData.expectedBehavior}
                  onChange={(e) => handleInputChange('expectedBehavior', e.target.value)}
                  rows={3}
                  className="w-full px-3 py-2 bg-trellis-vine/20 border border-trellis-vine/50 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:border-trellis-leaf focus:ring-1 focus:ring-trellis-leaf"
                  placeholder="What should have happened"
                  aria-required="true"
                  aria-invalid={Boolean(errors.expectedBehavior)}
                  aria-describedby={errors.expectedBehavior ? 'bug-expected-error' : undefined}
                />
                {errors.expectedBehavior && (
                  <p id="bug-expected-error" role="alert" className="mt-1 text-sm text-red-400">{errors.expectedBehavior}</p>
                )}
              </div>

              <div>
                <label htmlFor="bug-actual" className="block text-sm font-medium text-gray-300 mb-2">
                  Actual Behavior *
                </label>
                <textarea
                  id="bug-actual"
                  name="actualBehavior"
                  value={formData.actualBehavior}
                  onChange={(e) => handleInputChange('actualBehavior', e.target.value)}
                  rows={3}
                  className="w-full px-3 py-2 bg-trellis-vine/20 border border-trellis-vine/50 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:border-trellis-leaf focus:ring-1 focus:ring-trellis-leaf"
                  placeholder="What actually happened"
                  aria-required="true"
                  aria-invalid={Boolean(errors.actualBehavior)}
                  aria-describedby={errors.actualBehavior ? 'bug-actual-error' : undefined}
                />
                {errors.actualBehavior && (
                  <p id="bug-actual-error" role="alert" className="mt-1 text-sm text-red-400">{errors.actualBehavior}</p>
                )}
              </div>
            </div>
          </div>

          {/* Priority and Category */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="bg-trellis-vine/10 border border-trellis-vine/30 rounded-lg p-6 backdrop-blur-sm">
              <label htmlFor="bug-priority" className="block text-sm font-medium text-gray-300 mb-2">
                Priority Level *
              </label>
              <select
                id="bug-priority"
                name="priority"
                value={formData.priority}
                onChange={(e) => handleInputChange('priority', e.target.value)}
                aria-required="true"
                className="w-full px-3 py-2 bg-trellis-vine/20 border border-trellis-vine/50 rounded-lg text-white focus:outline-none focus:border-trellis-leaf focus:ring-1 focus:ring-trellis-leaf"
              >
                {PRIORITY_LEVELS.map(priority => (
                  <option key={priority.value} value={priority.value}>
                    {priority.label} - {priority.description}
                  </option>
                ))}
              </select>
            </div>

            <div className="bg-trellis-vine/10 border border-trellis-vine/30 rounded-lg p-6 backdrop-blur-sm">
              <label htmlFor="bug-category" className="block text-sm font-medium text-gray-300 mb-2">
                Category *
              </label>
              <select
                id="bug-category"
                name="category"
                value={formData.category}
                onChange={(e) => handleInputChange('category', e.target.value)}
                aria-required="true"
                className="w-full px-3 py-2 bg-trellis-vine/20 border border-trellis-vine/50 rounded-lg text-white focus:outline-none focus:border-trellis-leaf focus:ring-1 focus:ring-trellis-leaf"
              >
                {BUG_CATEGORIES.map(category => (
                  <option key={category.value} value={category.value}>
                    {category.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Screenshots */}
          <div className="bg-trellis-vine/10 border border-trellis-vine/30 rounded-lg p-6 backdrop-blur-sm">
            <h3 className="text-lg font-semibold mb-4 text-trellis-leaf">Screenshots</h3>
            <ScreenshotUpload
              onScreenshotsChange={handleScreenshotsChange}
              maxFiles={5}
              maxSize={10}
            />
          </div>

          {/* Contact Information */}
          <div className="bg-trellis-vine/10 border border-trellis-vine/30 rounded-lg p-6 backdrop-blur-sm">
            <h3 className="text-lg font-semibold mb-4 text-trellis-leaf">Contact Information</h3>              <div>
                <label htmlFor="bug-build-version" className="block text-sm font-medium text-gray-300 mb-2">
                  Application Build Version (Optional)
                </label>
                <input
                  id="bug-build-version"
                  name="buildVersion"
                  type="text"
                  value={formData.buildVersion || ''}
                  onChange={(e) => handleInputChange('buildVersion', e.target.value)}
                  placeholder="e.g. v0.1.0"
                  aria-describedby="bug-build-version-help"
                  className="w-full px-3 py-2 bg-trellis-vine/20 border border-trellis-vine/50 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:border-trellis-leaf focus:ring-1 focus:ring-trellis-leaf"
                />
                <p id="bug-build-version-help" className="mt-2 text-sm text-gray-400">
                  Tagging the build helps maintainers spot regressions caused by a release.
                </p>
              </div>

              <div>
                <label htmlFor="bug-email" className="block text-sm font-medium text-gray-300 mb-2">
                  Email Address (Optional)
                </label>
              <input
                id="bug-email"
                name="reporterEmail"
                type="email"
                value={formData.reporterEmail}
                onChange={(e) => handleInputChange('reporterEmail', e.target.value)}
                className="w-full px-3 py-2 bg-trellis-vine/20 border border-trellis-vine/50 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:border-trellis-leaf focus:ring-1 focus:ring-trellis-leaf"
                placeholder="your.email@example.com"
                aria-invalid={Boolean(errors.reporterEmail)}
                aria-describedby={errors.reporterEmail ? 'bug-email-error bug-email-help' : 'bug-email-help'}
              />
              {errors.reporterEmail && (
                <p id="bug-email-error" role="alert" className="mt-1 text-sm text-red-400">{errors.reporterEmail}</p>
              )}
              <p id="bug-email-help" className="mt-2 text-sm text-gray-400">
                Provide your email if you&apos;d like updates about your bug report
              </p>
            </div>
          </div>

          {/* Terms and Conditions */}
          <div className="bg-trellis-vine/10 border border-trellis-vine/30 rounded-lg p-6 backdrop-blur-sm">
            <div className="flex items-start space-x-3">
              <input
                type="checkbox"
                id="agreeToTerms"
                checked={formData.agreeToTerms}
                aria-required="true"
                aria-invalid={Boolean(errors.agreeToTerms)}
                aria-describedby={errors.agreeToTerms ? 'terms-error' : undefined}
                onChange={(e) => handleInputChange('agreeToTerms', e.target.checked)}
                className="mt-1 w-4 h-4 bg-trellis-vine/20 border-trellis-vine/50 rounded focus:ring-trellis-leaf focus:ring-1"
              />
              <div className="flex-1">
                <label htmlFor="agreeToTerms" className="text-sm text-gray-300">
                  I agree to the terms and conditions for bug reporting. I understand that:
                  <ul className="mt-2 ml-4 list-disc text-sm text-gray-400">
                    <li>The report will be reviewed by the development team</li>
                    <li>Rewards are subject to approval and may vary</li>
                    <li>False or duplicate reports may be rejected</li>
                    <li>My report may be shared with relevant team members</li>
                  </ul>
                </label>
                {errors.agreeToTerms && (
                   <p id="terms-error" role="alert" className="mt-2 text-sm text-red-400">{errors.agreeToTerms}</p>
                )}
              </div>
            </div>
          </div>

          {/* Duplicate Warning */}
          {similarReports.length > 0 && (
            <div
              role="alert"
              data-testid="duplicate-warning"
              className="bg-yellow-500/10 border border-yellow-500/50 rounded-lg p-6 backdrop-blur-sm"
            >
              <div className="flex items-start space-x-3">
                <svg
                  className="w-6 h-6 text-yellow-400 shrink-0"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
                  />
                </svg>
                <div className="flex-1">
                  <h3 className="text-base font-semibold text-yellow-400 mb-1">
                    Possible duplicate report
                  </h3>
                  <p className="text-sm text-gray-300 mb-2">
                    Similar reports already exist. Add detail that distinguishes yours, or comment on
                    an existing report instead of filing a new one.
                  </p>
                  <ul className="space-y-1 text-sm text-gray-300">
                    {similarReports.map((match) => (
                      <li key={match.report.id} className="flex items-center justify-between gap-4">
                        <span className="truncate">{match.report.title}</span>
                        <span className="text-xs text-gray-400 shrink-0">
                          {Math.round(match.score * 100)}% match
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          )}

          {/* Submit Button */}
          <div className="flex justify-end">
            <Button
              type="submit"
              variant="primary"
              size="lg"
              disabled={isSubmitting}
              className="min-w-[200px]"
            >
              {isSubmitting ? 'Submitting...' : 'Submit Bug Report'}
            </Button>
          </div>
        </div>

        {/* Reward Calculator Sidebar */}
        <div className="lg:col-span-1">
          <div className="sticky top-6 space-y-6">
            <RewardCalculator
              priority={formData.priority}
              category={formData.category}
              onRewardChange={setReward}
            />

            {reward && (
              <div className="bg-gradient-to-r from-trellis-vine to-trellis-leaf p-1 rounded-lg">
                <div className="bg-[rgb(var(--page-background))] rounded-lg p-4">
                  <h4 className="text-sm font-medium text-gray-300 mb-2">Potential Reward</h4>
                  <div className="text-3xl font-bold text-trellis-leaf mb-2">
                    {reward.totalReward} XLM
                  </div>
                  <p className="text-xs text-gray-400">
                    Estimated payout: {new Date(reward.estimatedPayoutDate).toLocaleDateString()}
                  </p>
                </div>
              </div>
            )}

            <div className="bg-trellis-vine/10 border border-trellis-vine/30 rounded-lg p-4 backdrop-blur-sm">
              <h4 className="text-sm font-medium text-trellis-leaf mb-3">Reporting Guidelines</h4>
              <ul className="space-y-2 text-xs text-gray-300">
                <li className="flex items-start space-x-2">
                  <span className="text-trellis-leaf mt-1">•</span>
                  <span>Be as detailed as possible in your description</span>
                </li>
                <li className="flex items-start space-x-2">
                  <span className="text-trellis-leaf mt-1">•</span>
                  <span>Include clear steps to reproduce the issue</span>
                </li>
                <li className="flex items-start space-x-2">
                  <span className="text-trellis-leaf mt-1">•</span>
                  <span>Add screenshots when possible</span>
                </li>
                <li className="flex items-start space-x-2">
                  <span className="text-trellis-leaf mt-1">•</span>
                  <span>Check for existing reports before submitting</span>
                </li>
                <li className="flex items-start space-x-2">
                  <span className="text-trellis-leaf mt-1">•</span>
                  <span>Security issues should be reported privately</span>
                </li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </form>
  );
};

export default BugReportForm;
