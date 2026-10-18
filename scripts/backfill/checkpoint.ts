import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface CheckpointRecord {
  id: string;
  status: 'pending' | 'success' | 'skipped' | 'failed';
  attempts: number;
  error?: string;
  updatedAt: string;
}

export interface CheckpointFile {
  version: 1;
  tool: 'trellis-backfill';
  createdAt: string;
  updatedAt: string;
  cursor: number;
  records: Record<string, CheckpointRecord>;
}

export interface CheckpointStore {
  read(): Promise<CheckpointFile | null>;
  write(file: CheckpointFile): Promise<void>;
}

export interface NodeError extends Error {
  code?: string;
}

export const createEmptyCheckpoint = (): CheckpointFile => {
  const now = new Date().toISOString();
  return {
    version: 1,
    tool: 'trellis-backfill',
    createdAt: now,
    updatedAt: now,
    cursor: 0,
    records: {},
  };
};

export const createFileCheckpointStore = (filePath: string): CheckpointStore => {
  const absolute = path.resolve(filePath);

  const read = async (): Promise<CheckpointFile | null> => {
    try {
      const raw = await fs.readFile(absolute, 'utf-8');
      const parsed = JSON.parse(raw) as CheckpointFile;
      if (parsed.version !== 1 || parsed.tool !== 'trellis-backfill') {
        throw new Error(`Unsupported checkpoint format at ${absolute}`);
      }
      return parsed;
    } catch (error) {
      if ((error as NodeError).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  };

  const write = async (file: CheckpointFile): Promise<void> => {
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    const tmp = `${absolute}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;
    file.updatedAt = new Date().toISOString();
    await fs.writeFile(tmp, JSON.stringify(file, null, 2), 'utf-8');
    await fs.rename(tmp, absolute);
  };

  return { read, write };
};
