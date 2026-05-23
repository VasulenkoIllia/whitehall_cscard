/**
 * Загальні типи для AI-mapping модуля.
 */

export interface MasterFieldMeta {
  id: number;
  key: string;
  labelUk: string;
  dataType: string;
  isRequired: boolean;
  sortOrder: number;
  hintKeys: string[];
  /** AI-friendly довгий опис (з міграції 051). */
  descriptionAi: string | null;
  exampleValues: string[];
  appliesTo: string[];
  cardinality: 'per_master' | 'per_variant' | 'per_master_multi' | string;
  antiExamples: Array<{ value: string; reason: string }>;
  formatHint: string | null;
}

export interface TabAnalysisResult {
  tabs: Array<{
    name: string;
    is_catalog: boolean;
    product_type: string | null;
    confidence: number;
    reasoning: string;
  }>;
}

export type MappingTargetSingle = {
  type: 'column';
  col_index: number;
  col_letter?: string;
  header?: string;
  confidence: number;
  reasoning?: string;
  sample_values?: string[];
};

export type MappingTargetMulti = {
  type: 'columns';
  col_indexes: number[];
  col_letters?: string[];
  headers?: string[];
  confidence: number;
  reasoning?: string;
};

export type MappingTargetStatic = {
  type: 'static';
  value: string;
  confidence: number;
  reasoning?: string;
};

export type MappingTarget = MappingTargetSingle | MappingTargetMulti | MappingTargetStatic;

export interface MappingSuggestionResult {
  header_row: number | null;
  first_data_row: number | null;
  header_row_confidence: number;
  header_row_reasoning: string;
  mapping: Record<string, MappingTarget>;
  warnings: Array<{
    type: string;
    field?: string;
    fields?: string[];
    col_index?: number;
    message: string;
  }>;
  unmapped_cols: Array<{
    col_index: number;
    col_letter?: string;
    header?: string;
    reasoning?: string;
  }>;
}
