import React from 'react';
import { toJsonString } from '../lib/api';
import { Section } from '../components/ui';

export function OverviewTab({
  readiness,
  stats,
  recentErrorLogs,
  openJobDetails,
  actionForm,
  setActionForm,
  isReadOnly,
  runJob,
  runStoreImport,
  runCleanupWithPreflight,
  actionStatus
}) {
  return (
    <div className="grid">
      <Section title="Readiness" subtitle="Поточні backend-гейти перед store import">
        <pre>{toJsonString(readiness || {})}</pre>
      </Section>

      <Section title="Stats" subtitle="Операційна статистика">
        <pre>{toJsonString(stats || {})}</pre>
      </Section>

      <Section title="Операційні сигнали" subtitle="Ключові KPI та останні error-логи">
        <div className="kpi-grid">
          <div className="kpi-card">
            <div className="kpi-label">Suppliers</div>
            <div className="kpi-value">{Number(stats?.suppliers || 0)}</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-label">Sources</div>
            <div className="kpi-value">{Number(stats?.sources || 0)}</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-label">Raw rows</div>
            <div className="kpi-value">{Number(stats?.products_raw || 0)}</div>
          </div>
          <div className="kpi-card">
            <div className="kpi-label">Final rows</div>
            <div className="kpi-value">{Number(stats?.products_final || 0)}</div>
          </div>
        </div>
        <div className="status-line">
          Running jobs: {(readiness?.jobs?.running_blocking_jobs || []).length}
        </div>
        <div className="status-line">Mirror fresh: {readiness?.mirror?.is_fresh ? 'yes' : 'no'}</div>
        <div className="status-line">Recent errors: {recentErrorLogs.length}</div>
        {recentErrorLogs.length > 0 ? (
          <div className="preview-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>time</th>
                  <th>job</th>
                  <th>message</th>
                  <th>action</th>
                </tr>
              </thead>
              <tbody>
                {recentErrorLogs.map((item) => (
                  <tr key={item.id}>
                    <td>{item.created_at || '-'}</td>
                    <td>{item.job_id || '-'}</td>
                    <td>{item.message || '-'}</td>
                    <td>
                      {item.job_id ? (
                        <button className="btn" onClick={() => openJobDetails(item.job_id)}>
                          Job details
                        </button>
                      ) : (
                        '-'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-preview">Error logs не знайдено за поточним фільтром</div>
        )}
      </Section>

      <Section title="Швидкі дії" subtitle="Запуск джоб без переходу по екранах">
        <div className="form-row">
          <div>
            <label>sourceId</label>
            <input
              value={actionForm.sourceId}
              onChange={(event) =>
                setActionForm((prev) => ({ ...prev, sourceId: event.target.value }))
              }
            />
          </div>
          <div>
            <label>supplierId</label>
            <input
              value={actionForm.supplierId}
              onChange={(event) =>
                setActionForm((prev) => ({ ...prev, supplierId: event.target.value }))
              }
            />
          </div>
          <div>
            <label>store supplier (optional)</label>
            <input
              value={actionForm.storeSupplier}
              onChange={(event) =>
                setActionForm((prev) => ({ ...prev, storeSupplier: event.target.value }))
              }
            />
          </div>
        </div>

        <div className="form-row">
          <div>
            <label>resumeFromJobId (optional)</label>
            <input
              value={actionForm.resumeFromJobId}
              onChange={(event) =>
                setActionForm((prev) => ({ ...prev, resumeFromJobId: event.target.value }))
              }
            />
          </div>
          <div>
            <label>retentionDays</label>
            <input
              value={actionForm.retentionDays}
              onChange={(event) =>
                setActionForm((prev) => ({ ...prev, retentionDays: event.target.value }))
              }
            />
          </div>
          <div>
            <label>update pipeline supplier (optional)</label>
            <input
              value={actionForm.updatePipelineSupplier}
              onChange={(event) =>
                setActionForm((prev) => ({
                  ...prev,
                  updatePipelineSupplier: event.target.value
                }))
              }
            />
          </div>
        </div>

        <div className="actions">
          <button className="btn" disabled={isReadOnly} onClick={() => runJob('import_all', '/jobs/import-all')}>
            import_all
          </button>
          <button
            className="btn"
            disabled={isReadOnly || !Number.isFinite(Number(actionForm.sourceId))}
            onClick={() =>
              runJob('import_source', '/jobs/import-source', {
                sourceId: Number(actionForm.sourceId)
              })
            }
          >
            import_source
          </button>
          <button
            className="btn"
            disabled={isReadOnly || !Number.isFinite(Number(actionForm.supplierId))}
            onClick={() =>
              runJob('import_supplier', '/jobs/import-supplier', {
                supplierId: Number(actionForm.supplierId)
              })
            }
          >
            import_supplier
          </button>
          <button className="btn" disabled={isReadOnly} onClick={() => runJob('finalize', '/jobs/finalize')}>
            finalize
          </button>
          <button
            className="btn"
            disabled={isReadOnly}
            onClick={() => runJob('store_mirror_sync', '/jobs/store-mirror-sync')}
          >
            mirror_sync
          </button>
          <button className="btn primary" disabled={isReadOnly} onClick={runStoreImport}>
            store_import
          </button>
          <button
            className="btn"
            disabled={isReadOnly}
            onClick={() =>
              runJob('update_pipeline', '/jobs/update-pipeline', {
                supplier: actionForm.updatePipelineSupplier.trim() || undefined
              })
            }
          >
            update_pipeline
          </button>
          <button
            className="btn"
            disabled={isReadOnly || !Number.isFinite(Number(actionForm.retentionDays))}
            onClick={runCleanupWithPreflight}
          >
            cleanup
          </button>
        </div>

        <div className="preflight-warning">
          Preflight: `cleanup` вимагає keyword-підтвердження перед запуском.
        </div>

        <label style={{ marginTop: 10 }}>
          <input
            type="checkbox"
            checked={actionForm.resumeLatest}
            onChange={(event) =>
              setActionForm((prev) => ({ ...prev, resumeLatest: event.target.checked }))
            }
            style={{ width: 'auto', marginRight: 8 }}
          />
          Resume latest failed/canceled store_import
        </label>

        <div className={`status-line ${actionStatus.includes('Error') ? 'error' : ''}`}>
          {actionStatus}
        </div>
      </Section>
    </div>
  );
}
