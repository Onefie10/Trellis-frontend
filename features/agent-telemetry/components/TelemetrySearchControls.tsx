'use client';

interface Props {
  query: string;
  onQueryChange: (query: string) => void;
  regex: boolean;
  onRegexChange: (enabled: boolean) => void;
  matchCount: number;
  activeMatch: number;
  onPrevious: () => void;
  onNext: () => void;
  error: string | null;
}

export function TelemetrySearchControls({
  query,
  onQueryChange,
  regex,
  onRegexChange,
  matchCount,
  activeMatch,
  onPrevious,
  onNext,
  error,
}: Props) {
  return (
    <section aria-label="Log search" className="mb-4 space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[12rem] flex-1">
          <label htmlFor="telemetry-search" className="block text-sm text-gray-400 mb-1">
            Search logs
          </label>
          <input
            id="telemetry-search"
            type="search"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={regex ? 'Regex pattern' : 'Search text'}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? 'telemetry-search-error' : 'telemetry-search-count'}
            className="w-full rounded-md bg-trellis-ground border border-trellis-vine/30 px-3 py-2 text-sm text-white"
          />
        </div>
        <label className="inline-flex items-center gap-2 text-sm text-gray-300 px-2 py-2">
          <input type="checkbox" checked={regex} onChange={(event) => onRegexChange(event.target.checked)} />
          Regex
        </label>
        <div className="flex items-center gap-1" aria-label="Search result navigation">
          <button
            type="button"
            onClick={onPrevious}
            disabled={matchCount === 0}
            className="rounded border border-trellis-vine/30 px-2 py-2 text-sm text-gray-200 disabled:opacity-40"
            aria-label="Previous match"
          >
            Previous
          </button>
          <button
            type="button"
            onClick={onNext}
            disabled={matchCount === 0}
            className="rounded border border-trellis-vine/30 px-2 py-2 text-sm text-gray-200 disabled:opacity-40"
            aria-label="Next match"
          >
            Next
          </button>
        </div>
      </div>
      {error ? (
        <p id="telemetry-search-error" role="alert" className="text-xs text-red-300">
          Invalid regular expression: {error}
        </p>
      ) : (
        <p id="telemetry-search-count" aria-live="polite" className="text-xs text-gray-500">
          {matchCount === 0
            ? query
              ? 'No matching log entries'
              : 'Enter text or a pattern to search the stream'
            : `Match ${activeMatch + 1} of ${matchCount}`}
        </p>
      )}
    </section>
  );
}
