export type SupportedEntityType = 'agents' | 'test-cases' | 'provenance' | 'submissions' | 'general';

export type ImportFormat = 'json' | 'csv';

export type ImportAction = 'create' | 'update' | 'skip' | 'error';

export interface FieldValidationRule {
  field: string;
  required?: boolean;
  type?: 'string' | 'number' | 'boolean' | 'object' | 'array';
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
  pattern?: RegExp;
  enum?: string[];
  customValidator?: (value: any, row: Record<string, any>) => string | null;
}

export interface EntitySchema {
  entityType: SupportedEntityType;
  idField: string; // e.g. 'id' or 'externalId'
  fields: FieldValidationRule[];
}

export interface RowValidationError {
  field: string;
  message: string;
  value?: any;
}

export interface RowValidationResult {
  rowNumber: number;
  externalId?: string;
  action: ImportAction;
  valid: boolean;
  errors: RowValidationError[];
  data: Record<string, any>;
  diff?: {
    before?: Record<string, any>;
    after?: Record<string, any>;
  };
}

export interface ImportOptions {
  entityType?: SupportedEntityType;
  dryRun?: boolean;
  idempotent?: boolean;
  allowUpdate?: boolean;
  stopOnError?: boolean;
  externalIdKey?: string;
}

export interface ImportProgress {
  processed: number;
  total: number;
  current_item?: string;
  errors: number;
}

export interface DryRunSummary {
  totalRows: number;
  validRows: number;
  invalidRows: number;
  createCount: number;
  updateCount: number;
  skipCount: number;
  errorCount: number;
  duplicateCount: number;
}

export interface RollbackCompensationStep {
  step: number;
  action: 'delete' | 'restore' | 'noop';
  targetId: string;
  description: string;
  payload?: Record<string, any>;
}

export interface RollbackGuidance {
  snapshotId: string;
  timestamp: string;
  rollbackSupported: boolean;
  totalAffectedRecords: number;
  affectedExternalIds: string[];
  remediationSteps: string[];
  compensationSteps: RollbackCompensationStep[];
  sqlRecoveryScript?: string;
  recoveryEndpoint?: string;
}

export interface ImportResult {
  success: boolean;
  dryRun: boolean;
  entityType: SupportedEntityType;
  summary: DryRunSummary;
  rows: RowValidationResult[];
  errors: string[];
  rollbackGuidance?: RollbackGuidance;
  appliedRecords?: Record<string, any>[];
}
