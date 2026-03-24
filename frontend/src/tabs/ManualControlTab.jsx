import React, { useMemo } from 'react';
import { Section } from '../components/ui';

export function ManualControlTab({
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

  return (
    <div className="data-grid">
      <Section title="Ручне керування" subtitle="Запускайте кроки по порядку: імпорт → фінал → дзеркало → магазин">
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
    </div>
  );
}
