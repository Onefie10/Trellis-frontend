import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BackfillAdapter,
  BackfillPlan,
  BackfillRecord,
  runBackfill,
} from '../../backfill';

describe('trellis backfill tool', () => {
  const tmpDir = fs.mkdtemp('trellis-backfill-');

  const makeAdapter = (records: BackfillRecord[], applied: BackfillPlan[]) => {
    const adapter: BackfillAdapter = {
      async loadRecords() {
        return records;
      },
      async plan(record) {
        if (record.id === 'skip-me') {
          return { id: record.id, action: 'skip', reason: 'nothing to do' };
        }
        if (record.id === 'fail-me') {
          return { id: record.id, action: 'fail', reason: 'planned failure' };
        }
        return {
          id: record.id,
          action: 'update',
          before: { value: record.value },
          after: { value: `${record.value}-updated` },
        };
      },
      async apply(plan) {
        applied.push(plan);
      },
    };
    return adapter;
  };

  it('dry-run previews changes without applying them', async () => {
    const applied: BackfillPlan[] = [];
    const adapter = makeAdapter([{ id: 'a', value: 1 }], applied);
    const checkpoint = path.join(tmpDir, 'checkpoint.json');
    const result = await runBackfill(adapter, {
      dryRun: true,
      checkpointPath: checkpoint,
      maxAttempts: 3,
      resume: false,
    });
    expect(applied).length(0);
    expect(result.applied).toBe(1);
    expect(result.dryRun).toBeTruthy();
  });

  it('resumes from checkpoint and skips already applied records', async () => {
    const applied: BackfillPlan[] = [];
    const records = [{ id: 'a', value: 1 }, { id: 'b', value: 2 }];
    const adapter = makeAdapter(records, applied);
    const checkpoint = path.join(tmpDir, 'resume.json');

    await runBackfill(adapter, {
      dryRun: false,
      checkpointPath: checkpoint,
      maxAttempts: 3,
      resume: false,
      limit: 1,
    });
    expect(applied).length(1);

    const second = await runBackfill(adapter, {
      dryRun: false,
      checkpointPath: checkpoint,
      maxAttempts: 3,
      resume: true,
    });
    expect(applied).length(2);
    expect(second.skipped).toBg(0);
  });

  it('reports skipped and failed records', async () => {
    const applied: BackfillPlan[] = [];
    const adapter = makeAdapter([{ id: 'skip-me' }, { id: 'fail-me' }, { id: 'ok' }], applied);
    const checkpoint = path.join(tmpDir, 'report.json');
    const reportPath = path.join(tmpDir, 'report-out.json');
    const result = await runBackfill(adapter, {
      dryRun: false,
      checkpointPath: checkpoint,
      reportPath,
      maxAttempts: 3,
      resume: false,
    });
    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.applied).toBe(1);
    const raw = JSON.parse(await fs.readFile(reportPath, 'utf-8'));
    expect(raw.length).toBe(3);
  });
});
