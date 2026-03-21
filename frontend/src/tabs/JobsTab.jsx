import React from 'react';
import { toJsonString } from '../lib/api';
import { Section } from '../components/ui';

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
      <Section title="Jobs" extra={<button className="btn" onClick={refreshCore}>Reload</button>}>
        <div className="status-line">{jobsStatus}</div>
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Type</th>
              <th>Status</th>
              <th>Created</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <tr key={job.id}>
                <td>{job.id}</td>
                <td>{job.type}</td>
                <td>{job.status}</td>
                <td>{job.created_at || '-'}</td>
                <td>
                  <div className="actions">
                    <button className="btn" onClick={() => openJobDetails(job.id)}>
                      Details
                    </button>
                    {job.status === 'running' || job.status === 'queued' ? (
                      <button className="btn danger" disabled={isReadOnly} onClick={() => cancelJob(job.id)}>
                        Cancel
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
        title="Logs"
        subtitle="Операційний потік помилок і попереджень"
        extra={
          <div className="actions">
            <select value={logsLevel} onChange={(event) => setLogsLevel(event.target.value)}>
              <option value="">all</option>
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
            <button className="btn" onClick={refreshCore}>Reload</button>
            <button
              className="btn"
              onClick={() => {
                setLogsLevel('');
                setLogsJobId('');
                void refreshCore();
              }}
            >
              Reset
            </button>
          </div>
        }
      >
        <pre>{toJsonString(logs.slice(0, 120))}</pre>
      </Section>

      {jobDetails.jobId ? (
        <Section
          title={`Job details #${jobDetails.jobId}`}
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
                Reload details
              </button>
              <button className="btn" onClick={closeJobDetails}>Close</button>
            </div>
          }
        >
          {jobDetails.loading ? <div className="status-line">Loading...</div> : null}
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
                <pre>{toJsonString((jobDetails.payload.logs || []).slice(0, 200))}</pre>
              </div>
            </div>
          ) : null}
        </Section>
      ) : null}
    </div>
  );
}
