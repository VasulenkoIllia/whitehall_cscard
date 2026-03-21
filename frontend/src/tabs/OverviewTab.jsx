import React, { useMemo } from 'react';
import { toJsonString } from '../lib/api';
import { Section, Tag } from '../components/ui';

export function OverviewTab({
  readiness,
  stats,
  recentErrorLogs,
  openJobDetails,
  suppliers,
  selectedSupplierId,
  setSelectedSupplierId,
  sources,
  selectedSourceId,
  setSelectedSourceId,
  actionForm,
  setActionForm,
  isReadOnly,
  runJob,
  runStoreImport,
  runCleanupWithPreflight,
  actionStatus
}) {
  const gateEntries = useMemo(() => {
    const gates = readiness?.gates && typeof readiness.gates === 'object' ? readiness.gates : {};
    return Object.entries(gates).map(([key, value]) => ({
      key,
      value,
      isOk: value === true
    }));
  }, [readiness]);

  const supplierId = Number(selectedSupplierId);
  const sourceId = Number(selectedSourceId);
  const retentionDays = Number(actionForm.retentionDays);

  const supplierOptions = useMemo(
    () =>
      [...(Array.isArray(suppliers) ? suppliers : [])].sort((a, b) =>
        String(a?.name || '').localeCompare(String(b?.name || ''), 'uk')
      ),
    [suppliers]
  );

  const metricCards = [
    { label: 'Постачальники', value: Number(stats?.suppliers || 0) },
    { label: 'Джерела', value: Number(stats?.sources || 0) },
    { label: 'Сирі рядки', value: Number(stats?.products_raw || 0) },
    { label: 'Фінальні товари', value: Number(stats?.products_final || 0) },
    { label: 'Активні джоби', value: (readiness?.jobs?.running_blocking_jobs || []).length },
    { label: 'Помилки (останні)', value: recentErrorLogs.length }
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
                    <td>{gate.key}</td>
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

      <Section title="Робочий сценарій" subtitle="Запускайте кроки по порядку: імпорт → фінал → дзеркало → магазин">
        <div className="actions">
          <button className="btn" disabled={isReadOnly} onClick={() => runJob('import_all', '/jobs/import-all')}>
            1. Імпорт усіх джерел
          </button>
          <button className="btn" disabled={isReadOnly} onClick={() => runJob('finalize', '/jobs/finalize')}>
            2. Фіналізація
          </button>
          <button
            className="btn"
            disabled={isReadOnly}
            onClick={() => runJob('store_mirror_sync', '/jobs/store-mirror-sync')}
          >
            3. Оновити дзеркало магазину
          </button>
          <button className="btn primary" disabled={isReadOnly} onClick={runStoreImport}>
            4. Імпорт у магазин
          </button>
        </div>

        <div className="status-line">
          {actionForm.storeSupplier
            ? `Для кроку "4. Імпорт у магазин" обрано постачальника: ${actionForm.storeSupplier}`
            : 'Для кроку "4. Імпорт у магазин" використовується режим: усі постачальники'}
        </div>

        <details className="details-block" style={{ marginTop: 10 }}>
          <summary>Розширені дії для оператора</summary>

          <div className="operator-group">
            <h4 className="block-title">1. Точковий імпорт (без повного пайплайна)</h4>
            <p className="muted">Використовуйте, коли треба оновити лише одного постачальника або одне джерело.</p>
            <div className="form-row">
              <div>
                <label>Оберіть постачальника</label>
                <select
                  value={selectedSupplierId}
                  onChange={(event) => {
                    setSelectedSupplierId(event.target.value);
                    setSelectedSourceId('');
                  }}
                >
                  <option value="">-- оберіть постачальника --</option>
                  {supplierOptions.map((supplier) => (
                    <option key={supplier.id} value={supplier.id}>
                      {supplier.name} {supplier.is_active ? '' : '(paused)'}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label>Оберіть джерело постачальника</label>
                <select
                  value={selectedSourceId}
                  onChange={(event) => setSelectedSourceId(event.target.value)}
                  disabled={!selectedSupplierId}
                >
                  <option value="">-- оберіть джерело --</option>
                  {sources.map((source) => (
                    <option key={source.id} value={source.id}>
                      {(source.name || 'Без назви')} · {source.source_type}
                      {source.sheet_name ? ` · ${source.sheet_name}` : ''}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="actions">
              <button
                className="btn"
                disabled={isReadOnly || !Number.isFinite(sourceId) || sourceId <= 0}
                onClick={() =>
                  runJob('import_source', '/jobs/import-source', {
                    sourceId
                  })
                }
              >
                Запустити імпорт джерела
              </button>
              <button
                className="btn"
                disabled={isReadOnly || !Number.isFinite(supplierId) || supplierId <= 0}
                onClick={() =>
                  runJob('import_supplier', '/jobs/import-supplier', {
                    supplierId
                  })
                }
              >
                Запустити імпорт постачальника
              </button>
            </div>
          </div>

          <div className="operator-group">
            <h4 className="block-title">2. Налаштування кроку "Імпорт у магазин"</h4>
            <p className="muted">Це налаштування впливає на кнопку "4. Імпорт у магазин" вище.</p>
            <div className="form-row">
              <div>
                <label>Кого оновлювати в магазині</label>
                <select
                  value={actionForm.storeSupplier}
                  onChange={(event) =>
                    setActionForm((prev) => ({ ...prev, storeSupplier: event.target.value }))
                  }
                >
                  <option value="">Усі постачальники</option>
                  {supplierOptions.map((supplier) => (
                    <option key={`store_${supplier.id}`} value={supplier.name}>
                      {supplier.name}
                    </option>
                  ))}
                </select>
              </div>
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
              Продовжити останній невдалий store import
            </label>
          </div>

          <div className="operator-group">
            <h4 className="block-title">3. Повний update pipeline</h4>
            <p className="muted">Запускає весь ланцюжок: import → finalize → store import.</p>
            <div className="form-row">
              <div>
                <label>Обмежити запуск одним постачальником (опційно)</label>
                <select
                  value={actionForm.updatePipelineSupplier}
                  onChange={(event) =>
                    setActionForm((prev) => ({
                      ...prev,
                      updatePipelineSupplier: event.target.value
                    }))
                  }
                >
                  <option value="">Усі постачальники</option>
                  {supplierOptions.map((supplier) => (
                    <option key={`pipeline_${supplier.id}`} value={supplier.name}>
                      {supplier.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="actions">
              <button
                className="btn"
                disabled={isReadOnly}
                onClick={() =>
                  runJob('update_pipeline', '/jobs/update-pipeline', {
                    supplier: actionForm.updatePipelineSupplier.trim() || undefined
                  })
                }
              >
                Запустити повний update pipeline
              </button>
            </div>
          </div>

          <div className="operator-group operator-group-warn">
            <h4 className="block-title">4. Очищення історії (cleanup)</h4>
            <p className="muted">Видаляє старі джоби та логи. Використовуйте для підтримки швидкої бази.</p>
            <div className="form-row">
              <div>
                <label>Скільки днів історії залишати</label>
                <input
                  value={actionForm.retentionDays}
                  onChange={(event) =>
                    setActionForm((prev) => ({ ...prev, retentionDays: event.target.value }))
                  }
                />
              </div>
            </div>
            <div className="actions">
              <button
                className="btn"
                disabled={isReadOnly || !Number.isFinite(retentionDays) || retentionDays <= 0}
                onClick={runCleanupWithPreflight}
              >
                Запустити cleanup
              </button>
            </div>
          </div>
        </details>

        <div className="status-line">{actionStatus}</div>
      </Section>

      <Section title="Останні помилки" subtitle="Короткий журнал для швидкої діагностики">
        {recentErrorLogs.length > 0 ? (
          <div className="preview-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Час</th>
                  <th>Job</th>
                  <th>Повідомлення</th>
                  <th>Дія</th>
                </tr>
              </thead>
              <tbody>
                {recentErrorLogs.map((item) => (
                  <tr key={item.id}>
                    <td>{item.created_at || '-'}</td>
                    <td>{item.job_id || '-'}</td>
                    <td className="truncate-cell" title={item.message || '-'}>
                      {item.message || '-'}
                    </td>
                    <td>
                      {item.job_id ? (
                        <button className="btn" onClick={() => openJobDetails(item.job_id)}>
                          Деталі
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
          <div className="empty-preview">Помилки за поточним фільтром не знайдені</div>
        )}

        <details className="details-block" style={{ marginTop: 10 }}>
          <summary>Детальний JSON (readiness + stats)</summary>
          <div className="grid" style={{ marginTop: 10 }}>
            <div>
              <h4 className="block-title">Readiness</h4>
              <pre>{toJsonString(readiness || {})}</pre>
            </div>
            <div>
              <h4 className="block-title">Stats</h4>
              <pre>{toJsonString(stats || {})}</pre>
            </div>
          </div>
        </details>
      </Section>
    </div>
  );
}
