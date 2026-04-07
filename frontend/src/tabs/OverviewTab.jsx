import React, { useMemo } from 'react';
import { Section, Tag } from '../components/ui';

const GATE_LABELS = {
  ready_for_store_import: 'Готово до імпорту в магазин',
  ready_for_continuous_runs: 'Готово до безперервних запусків',
  no_running_blocking_jobs: 'Немає активних блокуючих джобів',
  mirror_is_fresh: 'Дзеркало актуальне',
  mirror_freshness: 'Свіжість дзеркала',
  cleanup_scheduled: 'Очищення заплановане',
  scheduler_active: 'Планувальник активний',
  has_suppliers: 'Є постачальники',
  has_sources: 'Є джерела',
  has_final_products: 'Є фінальні товари'
};

const JOB_TYPE_LABELS = {
  import_all: 'Імпорт усіх',
  finalize: 'Фіналізація',
  store_import: 'Відправка в магазин',
  update_pipeline: 'Повне оновлення',
  store_mirror_sync: 'Знімок магазину'
};

const PIPELINE_TYPES = new Set(Object.keys(JOB_TYPE_LABELS));

function formatDuration(startedAt, finishedAt) {
  if (!startedAt) return '—';
  const start = new Date(startedAt).getTime();
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  const totalSecs = Math.max(0, Math.round((end - start) / 1000));
  if (totalSecs < 60) return `${totalSecs} с`;
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  return secs > 0 ? `${mins} хв ${secs} с` : `${mins} хв`;
}

function formatTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) return d.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function statusTone(status) {
  if (status === 'success') return 'ok';
  if (status === 'failed' || status === 'canceled') return 'error';
  return 'warn';
}

function statusLabel(status) {
  if (status === 'success') return 'ok';
  if (status === 'failed') return 'помилка';
  if (status === 'canceled') return 'скасовано';
  if (status === 'running') return 'виконується';
  return status;
}

export function OverviewTab({ readiness, stats, jobs = [], importProgress }) {
  const gateEntries = useMemo(() => {
    const gates = readiness?.gates && typeof readiness.gates === 'object' ? readiness.gates : {};
    return Object.entries(gates).map(([key, value]) => ({
      key,
      value,
      isOk: value === true
    }));
  }, [readiness]);

  // Running jobs — all types
  const runningJobs = useMemo(
    () => (Array.isArray(jobs) ? jobs.filter((j) => j.status === 'running') : []),
    [jobs]
  );

  // Recent finished pipeline jobs (last 7, major types only)
  const recentPipelines = useMemo(
    () =>
      (Array.isArray(jobs) ? jobs : [])
        .filter((j) => PIPELINE_TYPES.has(j.type) && j.status !== 'running' && j.status !== 'queued')
        .slice(0, 7),
    [jobs]
  );

  const metricCards = [
    { label: 'Постачальники', value: Number(stats?.suppliers || 0) },
    { label: 'Джерела', value: Number(stats?.sources || 0) },
    { label: 'Сирі рядки', value: Number(stats?.products_raw || 0) },
    { label: 'Фінальні товари', value: Number(stats?.products_final || 0) },
    { label: 'Активні джоби', value: runningJobs.length }
  ];

  return (
    <div className="grid">
      <Section title="Стан системи" subtitle="Ключові показники та готовність до імпорту в магазин">
        <div className="kpi-grid">
          {metricCards.map((card) => (
            <div className="kpi-card" key={card.label}>
              <div className="kpi-label">{card.label}</div>
              <div className="kpi-value">{card.value}</div>
            </div>
          ))}
        </div>

        <div className="actions" style={{ marginBottom: 8 }}>
          <Tag tone={readiness?.gates?.ready_for_store_import === true ? 'ok' : 'warn'}>
            Імпорт у магазин: {readiness?.gates?.ready_for_store_import === true ? 'дозволено' : 'перевірити гейти'}
          </Tag>
          <Tag tone={readiness?.mirror?.is_fresh ? 'ok' : 'warn'}>
            Дзеркало: {readiness?.mirror?.is_fresh ? 'актуальне' : 'застаріле'}
          </Tag>
        </div>

        {gateEntries.length > 0 ? (
          <div className="preview-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Гейт</th>
                  <th>Стан</th>
                </tr>
              </thead>
              <tbody>
                {gateEntries.map((gate) => (
                  <tr key={gate.key}>
                    <td>{GATE_LABELS[gate.key] || gate.key}</td>
                    <td>
                      <Tag tone={gate.isOk ? 'ok' : 'warn'}>
                        {gate.isOk ? 'ok' : String(gate.value)}
                      </Tag>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-preview">Гейти readiness поки не отримані</div>
        )}
      </Section>

      {/* ── Активні джоби ── */}
      {runningJobs.length > 0 ? (
        <Section title="Активні джоби" subtitle="Зараз виконуються">
          <div className="pipeline-running-list">
            {runningJobs.map((job) => {
              // Live progress: prefer importProgress if jobId matches, else job.meta.progress
              const liveProgress =
                importProgress && importProgress.jobId === job.id ? importProgress : null;
              const metaProgress = job.meta?.progress;
              const completed = liveProgress?.completed ?? metaProgress?.completed ?? null;
              const total = liveProgress?.total ?? metaProgress?.total ?? null;
              const pct = total > 0 && completed !== null ? Math.min(100, Math.round((completed / total) * 100)) : null;

              // store_import specific progress from meta.storeImportProgress
              const storeProgress = job.type === 'store_import' ? job.meta?.storeImportProgress : null;
              const siTotal = storeProgress ? Number(storeProgress.total || 0) : null;
              const siProcessed = storeProgress ? Number(storeProgress.processed || 0) : null;
              const siImported = storeProgress ? Number(storeProgress.imported || 0) : null;
              const siSkipped = storeProgress ? Number(storeProgress.skipped || 0) : null;
              const siEta = storeProgress ? storeProgress.etaSeconds : null;
              const siRate = storeProgress ? storeProgress.ratePerSecond : null;
              const siPct = siTotal > 0 && siProcessed !== null ? Math.min(100, Math.round((siProcessed / siTotal) * 100)) : null;

              return (
                <div key={job.id} className="pipeline-running-item">
                  <div className="pipeline-running-header">
                    <span className="pipeline-running-type">
                      {JOB_TYPE_LABELS[job.type] || job.type}
                      <span className="pipeline-running-id"> #{job.id}</span>
                    </span>
                    <span className="pipeline-running-meta">
                      розпочато {formatTime(job.startedAt)} · {formatDuration(job.startedAt, null)}
                    </span>
                  </div>
                  {storeProgress && siTotal !== null ? (
                    <div style={{ marginTop: 6 }}>
                      <div className="import-progress-wrap">
                        <div className="import-progress-track">
                          <div className="import-progress-fill" style={{ width: `${siPct ?? 0}%` }} />
                        </div>
                        <span className="import-progress-label">
                          {siProcessed} / {siTotal} ({siPct ?? 0}%)
                        </span>
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                        <span>✅ оновлено: <strong style={{ color: '#0f8a4b' }}>{siImported}</strong></span>
                        <span>⏭ без змін: <strong>{siSkipped}</strong></span>
                        {siRate !== null && <span>⚡ {Number(siRate).toFixed(1)} / сек</span>}
                        {siEta !== null && siEta > 0 && (
                          <span>⏱ залишилось ≈ {siEta >= 60 ? `${Math.floor(siEta / 60)} хв ${Math.floor(siEta % 60)} с` : `${Math.round(siEta)} с`}</span>
                        )}
                      </div>
                    </div>
                  ) : pct !== null ? (
                    <div className="import-progress-wrap" style={{ marginTop: 6 }}>
                      <div className="import-progress-track">
                        <div className="import-progress-fill" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="import-progress-label">
                        {completed} / {total} джерел ({pct}%)
                      </span>
                    </div>
                  ) : (
                    <div className="pipeline-running-spinner">виконується...</div>
                  )}
                </div>
              );
            })}
          </div>
        </Section>
      ) : null}

      {/* ── Останні пайплайни ── */}
      {recentPipelines.length > 0 ? (
        <Section title="Останні пайплайни" subtitle="Результати нещодавніх запусків">
          <div className="preview-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Тип</th>
                  <th>Статус</th>
                  <th>Тривалість</th>
                  <th>Завершено</th>
                </tr>
              </thead>
              <tbody>
                {recentPipelines.map((job) => (
                  <tr key={job.id}>
                    <td>
                      <span style={{ fontSize: 13 }}>{JOB_TYPE_LABELS[job.type] || job.type}</span>
                      <span className="pipeline-job-id"> #{job.id}</span>
                    </td>
                    <td>
                      <Tag tone={statusTone(job.status)}>{statusLabel(job.status)}</Tag>
                    </td>
                    <td style={{ fontVariantNumeric: 'tabular-nums', fontSize: 13 }}>
                      {formatDuration(job.startedAt, job.finishedAt)}
                    </td>
                    <td style={{ fontSize: 12, color: 'var(--muted)' }}>
                      {formatTime(job.finishedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      ) : null}
    </div>
  );
}
