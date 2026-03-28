import React, { useMemo, useState } from 'react';
import { toJsonString } from '../lib/api';
import { Tag } from '../components/ui';

const JOB_STATUS_LABELS = {
  completed: 'Виконано',
  failed: 'Помилка',
  running: 'Виконується',
  queued: 'В черзі',
  cancelled: 'Скасовано'
};

const JOB_TYPE_LABELS = {
  import_all: 'Імпорт усіх',
  import_source: 'Імпорт джерела',
  import_supplier: 'Імпорт постачальника',
  finalize: 'Фіналізація',
  store_import: 'Відправка в магазин',
  update_pipeline: 'Повне оновлення',
  store_mirror_sync: 'Знімок магазину',
  cleanup: 'Очищення'
};

function formatDateTime(value) {
  if (!value) return '-';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  const now = new Date();
  const isToday = parsed.toDateString() === now.toDateString();
  if (isToday) return parsed.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return parsed.toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function jobStatusTone(status) {
  if (status === 'completed') return 'ok';
  if (status === 'failed') return 'error';
  return 'warn';
}

function logLevelTone(level) {
  if (level === 'error') return 'error';
  if (level === 'warn' || level === 'warning') return 'warn';
  return 'ok';
}

// ── Shared modal shell ────────────────────────────────────────
function Modal({ title, subtitle, onClose, children, wide }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-card"
        style={{ maxWidth: wide ? 900 : 620, width: '100%' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="section-head" style={{ marginBottom: 12 }}>
          <div>
            <h3 style={{ margin: 0 }}>{title}</h3>
            {subtitle ? <p className="muted" style={{ margin: '2px 0 0' }}>{subtitle}</p> : null}
          </div>
          <button className="btn" onClick={onClose}>Закрити</button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ── Job detail modal ──────────────────────────────────────────
function JobModal({ jobDetails, onClose, openJobDetails, isReadOnly, cancelJob }) {
  const job = jobDetails?.payload?.job || null;
  const children = jobDetails?.payload?.children || [];
  const logs = (jobDetails?.payload?.logs || []).slice(0, 80);

  return (
    <Modal
      title={`Job #${jobDetails.jobId}${job ? ` — ${JOB_TYPE_LABELS[job.type] || job.type}` : ''}`}
      subtitle={job ? `${formatDateTime(job.created_at)}${job.finished_at ? ' → ' + formatDateTime(job.finished_at) : ''}` : null}
      onClose={onClose}
      wide
    >
      <div className="actions" style={{ marginBottom: 12 }}>
        <button className="btn" onClick={() => openJobDetails(jobDetails.jobId)}>Оновити</button>
        {job && (job.status === 'running' || job.status === 'queued') ? (
          <button className="btn danger" disabled={isReadOnly} onClick={() => cancelJob(job.id)}>
            Скасувати
          </button>
        ) : null}
      </div>

      {jobDetails.loading ? <div className="status-line">Завантаження...</div> : null}
      {jobDetails.error ? <div className="status-line error">{jobDetails.error}</div> : null}

      {job ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <Tag tone={jobStatusTone(job.status)}>{JOB_STATUS_LABELS[job.status] || job.status}</Tag>
          {job.error_message ? <span style={{ color: '#c22727', fontSize: 13 }}>{job.error_message}</span> : null}
        </div>
      ) : null}

      {children.length > 0 ? (
        <div style={{ marginBottom: 16 }}>
          <div className="block-title" style={{ marginBottom: 6 }}>Кроки виконання</div>
          <div className="monitor-children">
            {children.map((child) => (
              <div key={child.id} className="monitor-child-row">
                <span style={{ color: '#8aa0bc', fontSize: 12, minWidth: 32 }}>#{child.id}</span>
                <span style={{ flex: 1 }}>{JOB_TYPE_LABELS[child.type] || child.type}</span>
                <Tag tone={jobStatusTone(child.status)}>{JOB_STATUS_LABELS[child.status] || child.status}</Tag>
                <span style={{ color: '#5c7294', fontSize: 12, whiteSpace: 'nowrap' }}>
                  {formatDateTime(child.created_at)}
                </span>
                {child.error_message ? (
                  <span style={{ color: '#c22727', fontSize: 12, flex: 1 }}>{child.error_message}</span>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {logs.length > 0 ? (
        <div>
          <div className="block-title" style={{ marginBottom: 6 }}>Логи</div>
          <div className="monitor-detail-logs">
            {logs.map((entry, i) => (
              <div key={entry.id || i} className={`monitor-log-entry monitor-log-${entry.level || 'info'}`}>
                <span className="monitor-log-time">{formatDateTime(entry.created_at)}</span>
                <Tag tone={logLevelTone(entry.level)}>{entry.level || 'info'}</Tag>
                <span className="monitor-log-msg">{entry.message || '-'}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </Modal>
  );
}

// ── Logs modal ────────────────────────────────────────────────
function LogsModal({ logs, logsLevel, setLogsLevel, logsJobId, setLogsJobId, onRefresh, onClose }) {
  return (
    <Modal title="Всі логи" onClose={onClose} wide>
      <div className="form-row" style={{ marginBottom: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div style={{ width: 'auto' }}>
          <label>Рівень</label>
          <select style={{ width: 'auto' }} value={logsLevel} onChange={(e) => setLogsLevel(e.target.value)}>
            <option value="">Всі</option>
            <option value="error">Помилки</option>
            <option value="warning">Попередження</option>
            <option value="info">Інфо</option>
          </select>
        </div>
        <div style={{ width: 'auto' }}>
          <label>Job ID</label>
          <input value={logsJobId} onChange={(e) => setLogsJobId(e.target.value)} placeholder="наприклад, 59" style={{ width: 110 }} />
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={onRefresh}>Оновити</button>
          <button className="btn" onClick={() => { setLogsLevel(''); setLogsJobId(''); onRefresh(); }}>Скинути</button>
        </div>
      </div>

      {logs.length === 0 ? (
        <div className="empty-preview">Логи за поточним фільтром відсутні</div>
      ) : (
        <div className="monitor-detail-logs" style={{ maxHeight: 480 }}>
          {logs.slice(0, 200).map((item, i) => (
            <div key={item.id || `${item.created_at}_${i}`} className={`monitor-log-entry monitor-log-${item.level || 'info'}`}>
              <span className="monitor-log-time">{formatDateTime(item.created_at)}</span>
              <Tag tone={logLevelTone(item.level)}>{item.level || '-'}</Tag>
              {item.job_id ? <span style={{ color: '#8aa0bc', fontSize: 12, whiteSpace: 'nowrap' }}>job #{item.job_id}</span> : null}
              <span className="monitor-log-msg">{item.message || '-'}</span>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

// ── Error detail modal ────────────────────────────────────────
function ErrorModal({ item, onClose, openJobDetails }) {
  return (
    <Modal
      title="Деталі помилки"
      subtitle={`${formatDateTime(item.created_at)}${item.job_id ? ` · job #${item.job_id}` : ''}`}
      onClose={onClose}
    >
      <div className="monitor-error-msg" style={{ fontSize: 14, marginBottom: 12 }}>
        {item.message || '-'}
      </div>
      <details className="details-block">
        <summary style={{ fontSize: 12 }}>Повний запис</summary>
        <pre style={{ marginTop: 8, fontSize: 11 }}>{toJsonString(item)}</pre>
      </details>
      {item.job_id ? (
        <div className="actions" style={{ marginTop: 12 }}>
          <button className="btn" onClick={() => { openJobDetails(item.job_id); onClose(); }}>
            Відкрити job #{item.job_id}
          </button>
        </div>
      ) : null}
    </Modal>
  );
}

// ── Main component ────────────────────────────────────────────
export function JobsTab({
  refreshCore,
  jobsStatus,
  jobs,
  openJobDetails,
  isReadOnly,
  cancelJob,
  logsLevel,
  setLogsLevel,
  logsJobId,
  setLogsJobId,
  logs,
  latestErrorLogs,
  jobDetails,
  closeJobDetails,
  readiness,
  stats
}) {
  const [modal, setModal] = useState(null);
  // modal: 'job' | 'logs' | 'error'
  const [selectedError, setSelectedError] = useState(null);

  const topErrorLogs = useMemo(() => (Array.isArray(latestErrorLogs) ? latestErrorLogs : []).slice(0, 5), [latestErrorLogs]);
  const recentJobs = jobs.slice(0, 5);
  const recentLogs = logs.slice(0, 5);

  const handleOpenJob = (jobId) => {
    openJobDetails(jobId);
    setModal('job');
  };

  const handleCloseJob = () => {
    closeJobDetails();
    setModal(null);
  };

  const handleOpenError = (item) => {
    setSelectedError(item);
    setModal('error');
  };

  const handleOpenErrorJob = (jobId) => {
    openJobDetails(jobId);
    setModal('job');
    setSelectedError(null);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* ── 3 компактні блоки ──────────────────────────────── */}
      <div className="monitor-cards-grid">

        {/* Джоби */}
        <div className="panel">
          <div className="section-head" style={{ marginBottom: 8 }}>
            <div>
              <h3 style={{ margin: 0 }}>Джоби</h3>
              <p className="muted" style={{ margin: '2px 0 0' }}>{jobsStatus || 'Останні запуски'}</p>
            </div>
            <button className="btn" onClick={refreshCore}>Оновити</button>
          </div>

          {recentJobs.length === 0 ? (
            <div className="empty-preview">Джоби не знайдено</div>
          ) : (
            <div className="monitor-compact-list">
              {recentJobs.map((job) => (
                <div key={job.id} className="monitor-compact-row">
                  <span style={{ color: '#8aa0bc', fontSize: 11, minWidth: 24 }}>#{job.id}</span>
                  <span style={{ flex: 1, fontSize: 13 }}>{JOB_TYPE_LABELS[job.type] || job.type}</span>
                  <Tag tone={jobStatusTone(job.status)}>{JOB_STATUS_LABELS[job.status] || job.status}</Tag>
                  <span style={{ color: '#8aa0bc', fontSize: 11, whiteSpace: 'nowrap' }}>{formatDateTime(job.created_at)}</span>
                  <button className="btn" style={{ padding: '2px 8px', fontSize: 12 }} onClick={() => handleOpenJob(job.id)}>
                    Деталі
                  </button>
                </div>
              ))}
            </div>
          )}

          {jobs.length > 5 ? (
            <button className="btn" style={{ marginTop: 8, width: '100%' }} onClick={() => setModal('all-jobs')}>
              Всі джоби ({jobs.length})
            </button>
          ) : null}
        </div>

        {/* Помилки */}
        <div className="panel">
          <div className="section-head" style={{ marginBottom: 8 }}>
            <div>
              <h3 style={{ margin: 0 }}>Останні помилки</h3>
              <p className="muted" style={{ margin: '2px 0 0' }}>5 останніх error-подій</p>
            </div>
          </div>

          {topErrorLogs.length === 0 ? (
            <div className="empty-preview" style={{ color: '#0f8a4b' }}>Помилок не виявлено</div>
          ) : (
            <div className="monitor-compact-list">
              {topErrorLogs.map((item) => (
                <div
                  key={item.id || `${item.created_at}_${item.message}`}
                  className="monitor-compact-row monitor-compact-error"
                >
                  <span style={{ color: '#8aa0bc', fontSize: 11, whiteSpace: 'nowrap', flexShrink: 0 }}>
                    {formatDateTime(item.created_at)}
                    {item.job_id ? ` · #${item.job_id}` : ''}
                  </span>
                  <span className="truncate-cell" title={item.message || '-'} style={{ flex: 1, fontSize: 13, color: '#3a1c1c' }}>
                    {item.message || '-'}
                  </span>
                  <button className="btn" style={{ padding: '2px 8px', fontSize: 12, flexShrink: 0 }} onClick={() => handleOpenError(item)}>
                    Детальніше
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Логи */}
        <div className="panel">
          <div className="section-head" style={{ marginBottom: 8 }}>
            <div>
              <h3 style={{ margin: 0 }}>Логи</h3>
              <p className="muted" style={{ margin: '2px 0 0' }}>Останні записи</p>
            </div>
            <button className="btn" onClick={() => setModal('logs')}>Всі логи</button>
          </div>

          {recentLogs.length === 0 ? (
            <div className="empty-preview">Логи відсутні</div>
          ) : (
            <div className="monitor-compact-list">
              {recentLogs.map((item, i) => (
                <div key={item.id || `${item.created_at}_${i}`} className="monitor-compact-row">
                  <Tag tone={logLevelTone(item.level)}>{item.level || '-'}</Tag>
                  <span style={{ color: '#8aa0bc', fontSize: 11, whiteSpace: 'nowrap' }}>{formatDateTime(item.created_at)}</span>
                  <span className="truncate-cell" title={item.message || '-'} style={{ flex: 1, fontSize: 12 }}>
                    {item.message || '-'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Технічний знімок ────────────────────────────────── */}
      <details className="details-block">
        <summary style={{ fontSize: 12, color: '#5f6f86' }}>Технічний знімок (для розробника)</summary>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12, marginTop: 10 }}>
          <div><h4 className="block-title">Readiness</h4><pre>{toJsonString(readiness || {})}</pre></div>
          <div><h4 className="block-title">Stats</h4><pre>{toJsonString(stats || {})}</pre></div>
        </div>
      </details>

      {/* ── Модалки ─────────────────────────────────────────── */}

      {modal === 'job' ? (
        <JobModal
          jobDetails={jobDetails}
          onClose={handleCloseJob}
          openJobDetails={openJobDetails}
          isReadOnly={isReadOnly}
          cancelJob={cancelJob}
        />
      ) : null}

      {modal === 'logs' ? (
        <LogsModal
          logs={logs}
          logsLevel={logsLevel}
          setLogsLevel={setLogsLevel}
          logsJobId={logsJobId}
          setLogsJobId={setLogsJobId}
          onRefresh={refreshCore}
          onClose={() => setModal(null)}
        />
      ) : null}

      {modal === 'error' && selectedError ? (
        <ErrorModal
          item={selectedError}
          onClose={() => { setModal(null); setSelectedError(null); }}
          openJobDetails={handleOpenErrorJob}
        />
      ) : null}

      {modal === 'all-jobs' ? (
        <Modal title="Всі джоби" onClose={() => setModal(null)} wide>
          <div className="preview-table-wrap" style={{ maxHeight: 520 }}>
            <table className="data-table">
              <thead>
                <tr>
                  {['#', 'Тип', 'Стан', 'Час', ''].map((h) => (
                    <th key={h} style={{ position: 'sticky', top: 0, background: '#f4f8ff', zIndex: 1 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr key={job.id}>
                    <td style={{ color: '#8aa0bc', fontSize: 12 }}>{job.id}</td>
                    <td>{JOB_TYPE_LABELS[job.type] || job.type}</td>
                    <td><Tag tone={jobStatusTone(job.status)}>{JOB_STATUS_LABELS[job.status] || job.status}</Tag></td>
                    <td style={{ whiteSpace: 'nowrap', color: '#5c7294', fontSize: 13 }}>{formatDateTime(job.created_at)}</td>
                    <td>
                      <div className="actions">
                        <button className="btn" onClick={() => handleOpenJob(job.id)}>Деталі</button>
                        {(job.status === 'running' || job.status === 'queued') ? (
                          <button className="btn danger" disabled={isReadOnly} onClick={() => cancelJob(job.id)}>Скасувати</button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
