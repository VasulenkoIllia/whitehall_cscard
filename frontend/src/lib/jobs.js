// Single source of truth for job type / status labels and pipeline-job allowlist.
// Tabs imported their own copies — that drifted (OverviewTab had 5 keys, JobsTab had 8).
// Now they all read from here. UX behavior is unchanged: PIPELINE_JOB_TYPES preserves
// the original Overview filter (only "user-facing" pipelines, not helper imports/cleanup).

export const JOB_TYPE_LABELS = {
  import_all: 'Імпорт усіх',
  import_source: 'Імпорт джерела',
  import_supplier: 'Імпорт постачальника',
  finalize: 'Фіналізація',
  store_import: 'Відправка в магазин',
  update_pipeline: 'Повне оновлення',
  store_mirror_sync: 'Знімок магазину',
  cleanup: 'Очищення'
};

export const JOB_STATUS_LABELS = {
  completed: 'Виконано',
  failed: 'Помилка',
  running: 'Виконується',
  queued: 'В черзі',
  cancelled: 'Скасовано'
};

// Subset shown in OverviewTab "Recent pipelines" — keeps that view focused on top-level
// pipelines, not their per-source helper jobs. Do NOT widen without UX review.
export const PIPELINE_JOB_TYPES = new Set([
  'import_all',
  'finalize',
  'store_import',
  'update_pipeline',
  'store_mirror_sync'
]);

export function jobStatusTone(status) {
  if (status === 'completed') return 'ok';
  if (status === 'failed') return 'error';
  return 'warn';
}

export function logLevelTone(level) {
  if (level === 'error') return 'error';
  if (level === 'warn' || level === 'warning') return 'warn';
  return 'ok';
}
