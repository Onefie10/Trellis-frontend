'use client';

import React, { useState, useEffect } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { type BugReport } from '../../types/bug-report';
import { detectRegression, getBuildVersions } from '../../lib/bug-reports-pagination';

const BugReportsPage = () => {
  const [filter, setFilter] = useState<'all' | 'submitted' | 'under_review' | 'in_progress' | 'resolved' | 'rejected'>('all');
  const [sortBy, setSortBy] = useState<'date' | 'priority' | 'reward'>('date');
  const [buildVersion, setBuildVersion] = useState<string>('all');

  const fetchBugReports = async ({ pageParam }: { pageParam?: unknown }) => {
    const cursor = typeof pageParam === 'string' ? `&cursor=${encodeURIComponent(pageParam)}` : '';
    const version = buildVersion !== 'all' ? `&buildVersion=${encodeURIComponent(buildVersion)}` : '';
    const response = await fetch(`/api/bug-reports?status=${filter}&limit=20${version}${cursor}`);
    if (!response.ok) {
      throw new Error('Failed to fetch bug reports');
    }
    return response.json();
  };

  const { data, isLoading, error, fetchNextPage, hasNextPage, isFetchingNextPage, refetch, isRefetching } = useInfiniteQuery({
    queryKey: ['bug-reports', filter, buildVersion],
    queryFn: fetchBugReports,
    getNextPageParam: (lastPage) => lastPage.nextCursor || undefined,
  });

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'submitted':
        return 'bg-blue-500/20 text-blue-400 border-blue-500/50';
      case 'under_review':
        return 'bg-yellow-500/20 text-yellow-400 border-yellow-500/50';
      case 'in_progress':
        return 'bg-purple-500/20 text-purple-400 border-purple-500/50';
      case 'resolved':
        return 'bg-green-500/20 text-green-400 border-green-500/50';
      case 'rejected':
        return 'bg-red-500/20 text-red-400 border-red-500/50';
      default:
        return 'bg-gray-500/20 text-gray-400 border-gray-500/50';
    }
  };

  const getPriorityColor = (priority: string) => {
    switch (priority) {
      case 'low':
        return 'bg-gray-500/20 text-gray-400';
      case 'medium':
        return 'bg-blue-500/20 text-blue-400';
      case 'high':
        return 'bg-orange-500/20 text-orange-400';
      case 'critical':
        return 'bg-red-500/20 text-red-400';
      default:
        return 'bg-gray-500/20 text-gray-400';
    }
  };

  const getRewardStatusColor = (status: string) => {
    switch (status) {
      case 'pending':
        return 'text-yellow-400';
      case 'approved':
        return 'text-green-400';
      case 'paid':
        return 'text-trellis-leaf';
      case 'rejected':
        return 'text-red-400';
      default:
        return 'text-gray-400';
    }
  };

  const reports: BugReport[] = data?.pages.flatMap((page) => page.bugReports) || [];
  const buildVersions = getBuildVersions(reports);
  const filteredReports =
    buildVersion === 'all'
      ? reports
      : reports.filter((report: BugReport) => report.buildVersion === buildVersion);
  const regression = detectRegression(filteredReports);

  const sortedReports = [...filteredReports].sort((a: BugReport, b: BugReport) => {
    switch (sortBy) {
      case 'date':
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      case 'priority':
        const priorityOrder = { critical: 4, high: 3, medium: 2, low: 1 };
        return priorityOrder[b.priority] - priorityOrder[a.priority];
      case 'reward':
        return b.rewardAmount - a.rewardAmount;
      default:
        return 0;
    }
  });

  if (isLoading) {
    return (
      <div className="min-h-screen py-12 px-4 sm:px-6 lg:px-8">
        <div className="max-w-7xl mx-auto">
          <div className="text-center">
            <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-trellis-leaf"></div>
            <p className="mt-2 text-gray-400">Loading bug reports...</p>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen py-12 px-4 sm:px-6 lg:px-8">
        <div className="max-w-7xl mx-auto">
          <div className="text-center">
            <div role="alert" className="bg-red-500/20 border border-red-500/50 rounded-lg p-8">
              <h2 className="text-xl font-semibold text-red-400 mb-2">Error Loading Reports</h2>
              <p className="text-gray-300">Failed to load bug reports. Please try again.</p>
              <button
                type="button"
                onClick={() => refetch()}
                disabled={isRefetching}
                className="mt-4 rounded-lg border border-red-400/60 px-4 py-2 text-sm font-semibold text-red-100 hover:bg-red-500/20 focus:outline-none focus:ring-2 focus:ring-red-300 disabled:opacity-50"
              >
                {isRefetching ? 'Retrying...' : 'Retry'}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-7xl mx-auto">
        <div className="mb-8">
          <h1 className="text-4xl font-bold text-white mb-4">
            Bug Reports Dashboard
          </h1>
          <p className="text-xl text-gray-300">
            Track and manage your bug reports
          </p>
        </div>

        {/* Stats Overview */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
          <div className="bg-trellis-vine/10 border border-trellis-vine/30 rounded-lg p-6 backdrop-blur-sm">
            <div className="text-3xl font-bold text-trellis-leaf mb-2">
              {data?.pages[0]?.total || 0}
            </div>
            <div className="text-sm text-gray-300">Total Reports</div>
          </div>
          
          <div className="bg-trellis-vine/10 border border-trellis-vine/30 rounded-lg p-6 backdrop-blur-sm">
            <div className="text-3xl font-bold text-green-400 mb-2">
              {reports.filter((r: BugReport) => r.status === 'resolved').length || 0}
            </div>
            <div className="text-sm text-gray-300">Resolved</div>
          </div>
          
          <div className="bg-trellis-vine/10 border border-trellis-vine/30 rounded-lg p-6 backdrop-blur-sm">
            <div className="text-3xl font-bold text-yellow-400 mb-2">
              {reports.filter((r: BugReport) => r.status === 'under_review' || r.status === 'in_progress').length || 0}
            </div>
            <div className="text-sm text-gray-300">In Review</div>
          </div>
          
          <div className="bg-trellis-vine/10 border border-trellis-vine/30 rounded-lg p-6 backdrop-blur-sm">
            <div className="text-3xl font-bold text-trellis-leaf mb-2">
              {reports.reduce((sum: number, r: BugReport) => sum + r.rewardAmount, 0) || 0} XLM
            </div>
            <div className="text-sm text-gray-300">Total Rewards</div>
          </div>
        </div>

        {/* Filters and Controls */}
        <div className="bg-trellis-vine/10 border border-trellis-vine/30 rounded-lg p-6 backdrop-blur-sm mb-8">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => setFilter('all')}
                aria-pressed={filter === 'all'}
                className={`px-4 py-2 rounded-lg transition-colors ${
                  filter === 'all'
                    ? 'bg-trellis-vine text-white'
                    : 'bg-trellis-vine/20 text-gray-300 hover:bg-trellis-vine/30'
                }`}
              >
                All
              </button>
              <button
                onClick={() => setFilter('submitted')}
                aria-pressed={filter === 'submitted'}
                className={`px-4 py-2 rounded-lg transition-colors ${
                  filter === 'submitted'
                    ? 'bg-trellis-vine text-white'
                    : 'bg-trellis-vine/20 text-gray-300 hover:bg-trellis-vine/30'
                }`}
              >
                Submitted
              </button>
              <button
                onClick={() => setFilter('under_review')}
                aria-pressed={filter === 'under_review'}
                className={`px-4 py-2 rounded-lg transition-colors ${
                  filter === 'under_review'
                    ? 'bg-trellis-vine text-white'
                    : 'bg-trellis-vine/20 text-gray-300 hover:bg-trellis-vine/30'
                }`}
              >
                Under Review
              </button>
              <button
                onClick={() => setFilter('in_progress')}
                aria-pressed={filter === 'in_progress'}
                className={`px-4 py-2 rounded-lg transition-colors ${
                  filter === 'in_progress'
                    ? 'bg-trellis-vine text-white'
                    : 'bg-trellis-vine/20 text-gray-300 hover:bg-trellis-vine/30'
                }`}
              >
                In Progress
              </button>
              <button
                onClick={() => setFilter('resolved')}
                aria-pressed={filter === 'resolved'}
                className={`px-4 py-2 rounded-lg transition-colors ${
                  filter === 'resolved'
                    ? 'bg-trellis-vine text-white'
                    : 'bg-trellis-vine/20 text-gray-300 hover:bg-trellis-vine/30'
                }`}
              >
                Resolved
              </button>
            </div>
            
            <div className="flex flex-wrap items-center gap-4">
              <div className="flex items-center gap-2">
                <label htmlFor="bug-report-build-version" className="text-sm text-gray-300">Build:</label>
                <select
                  id="bug-report-build-version"
                  value={buildVersion}
                  onChange={(e) => setBuildVersion(e.target.value)}
                  className="px-3 py-2 bg-trellis-vine/20 border border-trellis-vine/50 rounded-lg text-white focus:outline-none focus:border-trellis-leaf"
                >
                  <option value="all">All versions</option>
                  {buildVersions.map((version) => (
                    <option key={version} value={version}>
                      {version}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex items-center gap-2">
                <label htmlFor="bug-report-sort" className="text-sm text-gray-300">Sort by:</label>
                <select
                  id="bug-report-sort"
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as 'date' | 'priority' | 'reward')}
                  className="px-3 py-2 bg-trellis-vine/20 border border-trellis-vine/50 rounded-lg text-white focus:outline-none focus:border-trellis-leaf"
                >
                  <option value="date">Date</option>
                  <option value="priority">Priority</option>
                  <option value="reward">Reward</option>
                </select>
              </div>
            </div>
          </div>
        </div>

        {/* Regression Alert */}
        {regression && (
          <div
            role="alert"
            data-testid="regression-alert"
            className="mb-8 bg-red-500/10 border border-red-500/50 rounded-lg p-6 backdrop-blur-sm"
          >
            <div className="flex items-start gap-3">
              <svg
                className="w-6 h-6 text-red-400 shrink-0"
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
              <div>
                <h2 className="text-lg font-semibold text-red-400 mb-1">
                  Possible regression in {regression.buildVersion}
                </h2>
                <p className="text-sm text-gray-300">{regression.message}</p>
              </div>
            </div>
          </div>
        )}

        {/* Bug Reports List */}
        {sortedReports.length === 0 ? (
          <div className="bg-trellis-vine/10 border border-trellis-vine/30 rounded-lg p-12 backdrop-blur-sm text-center">
            <div className="w-16 h-16 bg-trellis-vine/20 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg
                className="w-8 h-8 text-trellis-leaf"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                />
              </svg>
            </div>
            <h3 className="text-xl font-semibold text-white mb-2">No Bug Reports Found</h3>
            <p className="text-gray-400 mb-6">
              {filter === 'all' 
                ? "You haven't submitted any bug reports yet." 
                : `No bug reports with status "${filter}" found.`}
              {buildVersion !== 'all' && (
                <> {`No reports filed against build ${buildVersion}.`}</>
              )}
            </p>
            <button
              onClick={() => window.location.href = '/bug-report'}
              className="px-6 py-3 bg-trellis-vine hover:bg-trellis-vine/80 text-white rounded-lg transition-colors"
            >
              Submit Your First Bug Report
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            {sortedReports.map((report: BugReport) => (
              <div
                key={report.id}
                className="bg-trellis-vine/10 border border-trellis-vine/30 rounded-lg p-6 backdrop-blur-sm hover:border-trellis-vine/50 transition-colors"
              >
                <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
                  <div className="flex-1">
                    <div className="flex items-center gap-3 mb-2">
                      <h3 className="text-lg font-semibold text-white">{report.title}</h3>
                      <span className={`px-2 py-1 text-xs font-medium rounded-full border ${getStatusColor(report.status)}`}>
                        {report.status.replace('_', ' ')}
                      </span>
                      <span className={`px-2 py-1 text-xs font-medium rounded-full ${getPriorityColor(report.priority)}`}>
                        {report.priority}
                      </span>
                      {report.buildVersion && (
                        <span
                          data-testid="build-version-badge"
                          className="px-2 py-1 text-xs font-medium rounded-full border border-trellis-leaf/50 bg-trellis-leaf/10 text-trellis-leaf"
                        >
                          {report.buildVersion}
                        </span>
                      )}
                    </div>
                    
                    <p className="text-gray-300 mb-3 line-clamp-2">
                      {report.description}
                    </p>
                    
                    <div className="flex flex-wrap items-center gap-4 text-sm text-gray-400">
                      <span>ID: {report.id}</span>
                      <span>Category: {report.category}</span>
                      <span>Submitted: {new Date(report.createdAt).toLocaleDateString()}</span>
                      {report.reporterEmail && (
                        <span>Email: {report.reporterEmail}</span>
                      )}
                    </div>
                  </div>
                  
                  <div className="flex flex-col items-end gap-2">
                    <div className="text-right">
                      <div className="text-2xl font-bold text-trellis-leaf">
                        {report.rewardAmount} XLM
                      </div>
                      <div className={`text-sm ${getRewardStatusColor(report.rewardStatus)}`}>
                        Reward: {report.rewardStatus.replace('_', ' ')}
                      </div>
                    </div>
                    
                    <button
                      className="px-4 py-2 bg-trellis-vine/30 hover:bg-trellis-vine/60 text-white rounded-lg transition-colors text-sm"
                    >
                      View Details
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {hasNextPage && (
          <div className="mt-8 flex justify-center">
            <button
              type="button"
              onClick={() => fetchNextPage()}
              disabled={isFetchingNextPage}
              className="rounded-lg bg-trellis-vine px-6 py-3 text-white transition-colors hover:bg-trellis-vine/80 disabled:cursor-wait disabled:opacity-60"
            >
              {isFetchingNextPage ? 'Loading more reports...' : 'Load more reports'}
            </button>
          </div>
        )}

        {/* Actions */}
        <div className="mt-8 flex justify-center">
          <button
            onClick={() => window.location.href = '/bug-report'}
            className="px-6 py-3 bg-gradient-to-r from-trellis-vine to-trellis-leaf hover:shadow-lg hover:shadow-trellis-vine/50 text-white rounded-lg transition-all"
          >
            Submit New Bug Report
          </button>
        </div>
      </div>
    </div>
  );
};

export default BugReportsPage;
