import React from 'react';
import { toJsonString } from '../lib/api';
import { Section, Tag } from '../components/ui';

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
  jobDetails,
  closeJobDetails
}) {
  return (
    <div className="grid">
      <Section title="Джоби" subtitle="Останні запуски пайплайна" extra={<button className="btn" onClick={refreshCore}>Оновити</button>}>
        <div className="status-line">{jobsStatus}</div>
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Тип</th>
              <th>Стан</th>
              <th>Створено</th>
              <th>Дія</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <tr key={job.id}>
                <td>{job.id}</td>
                <td>{job.type}</td>
                <td>
                  <Tag tone={job.status === 'completed' ? 'ok' : job.status === 'failed' ? 'error' : 'warn'}>
                    {job.status}
                  </Tag>
                </td>
                <td>{job.created_at || '-'}</td>
                <td>
                  <div className="actions">
                    <button className="btn" onClick={() => openJobDetails(job.id)}>
                      Деталі
                    </button>
                    {job.status === 'running' || job.status === 'queued' ? (
                      <button className="btn danger" disabled={isReadOnly} onClick={() => cancelJob(job.id)}>
                        Скасувати
                      </button>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section
        title="Логи"
        subtitle="Фільтрація помилок і попереджень"
        extra={
          <div className="actions">
            <select value={logsLevel} onChange={(event) => setLogsLevel(event.target.value)}>
              <option value="">всі рівні</option>
              <option value="error">error</option>
              <option value="warning">warning</option>
              <option value="info">info</option>
            </select>
            <input
              value={logsJobId}
              onChange={(event) => setLogsJobId(event.target.value)}
              placeholder="jobId"
              style={{ width: 110 }}
            />
            <button className="btn" onClick={refreshCore}>Оновити</button>
            <button
              className="btn"
              onClick={() => {
                setLogsLevel('');
                setLogsJobId('');
                void refreshCore();
              }}
            >
              Скинути
            </button>
          </div>
        }
      >
        {logs.length === 0 ? (
          <div className="empty-preview">Логи за поточним фільтром відсутні</div>
        ) : (
          <div className="preview-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Час</th>
                  <th>Рівень</th>
                  <th>Job</th>
                  <th>Повідомлення</th>
                </tr>
              </thead>
              <tbody>
                {logs.slice(0, 120).map((item) => (
                  <tr key={item.id || `${item.created_at}_${item.message}`}>
                    <td>{item.created_at || '-'}</td>
                    <td>
                      <Tag tone={item.level === 'error' ? 'error' : item.level === 'warning' ? 'warn' : 'ok'}>
                        {item.level || '-'}
                      </Tag>
                    </td>
                    <td>{item.job_id || '-'}</td>
                    <td className="truncate-cell" title={item.message || '-'}>
                      {item.message || '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {jobDetails.jobId ? (
        <Section
          title={`Деталі job #${jobDetails.jobId}`}
          extra={
            <div className="actions">
              <button
                className="btn"
                onClick={() => {
                  if (jobDetails.jobId) {
                    void openJobDetails(jobDetails.jobId);
                  }
                }}
              >
                Оновити деталі
              </button>
              <button className="btn" onClick={closeJobDetails}>Закрити</button>
            </div>
          }
        >
          {jobDetails.loading ? <div className="status-line">Завантаження...</div> : null}
          {jobDetails.error ? <div className="status-line error">{jobDetails.error}</div> : null}
          {jobDetails.payload ? (
            <div className="grid">
              <div>
                <h4 className="block-title">Job</h4>
                <pre>{toJsonString(jobDetails.payload.job || {})}</pre>
              </div>
              <div>
                <h4 className="block-title">Children</h4>
                <pre>{toJsonString(jobDetails.payload.children || [])}</pre>
              </div>
              <div>
                <h4 className="block-title">Logs (latest)</h4>
                <pre>{toJsonString((jobDetails.payload.logs || []).slice(0, 120))}</pre>
              </div>
            </div>
          ) : null}
        </Section>
      ) : null}
    </div>
  );
}
