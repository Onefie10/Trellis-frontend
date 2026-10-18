import { ImportOptions, ImportProgress, ImportResult } from './types';
import { runImportPipeline } from './pipeline';

export async function runImportPipelineWithProgress(
  input: string | Record<string, any>[],
  options: ImportOptions,
  onProgress: (progress: ImportProgress) => void,
  signal?: AbortSignal,
): Promise<ImportResult | { cancelled: true }> {
  const total = typeof input === 'string'
    ? Math.max(0, input.trim().split(/\r?\n/).length - 1)
    : input.length;

  for (let processed = 0; processed < total; processed += 1) {
    if (signal?.aborted) return { cancelled: true };
    onProgress({ processed, total, current_item: `row-${processed + 1}`, errors: 0 });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  if (signal?.aborted) return { cancelled: true };
  const result = runImportPipeline(input, options);
  onProgress({ processed: total, total, errors: result.summary.errorCount });
  return result;
}
