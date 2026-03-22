import React from 'react';
import { columnLetter } from '../lib/mapping';
import { Section, Tag } from '../components/ui';

export function MappingTab({
  selectedSupplierId,
  setSelectedSupplierId,
  suppliers,
  selectedSourceId,
  setSelectedSourceId,
  sources,
  refreshSources,
  setEditingSourceId,
  setSourceDraft,
  setSourceErrors,
  toSourceDraft,
  deleteSource,
  isReadOnly,
  sourcesStatus,
  editingSourceId,
  sourceDraft,
  sourceTypes,
  sourceErrors,
  parseSourceUrlHint,
  saveSource,
  sourceFormStatus,
  sourceSheets,
  selectedSheetName,
  setSelectedSheetName,
  mappingHeaderRow,
  setMappingHeaderRow,
  loadSourceSheets,
  loadSourcePreview,
  sourceSheetsStatus,
  sourcePreview,
  mappingKeys,
  mappingFields,
  updateMappingField,
  mappingColumnOptions,
  applyBuilderToJson,
  refreshMapping,
  mappingErrors,
  mappingComment,
  setMappingComment,
  mappingText,
  setMappingText,
  saveMapping,
  mappingStatus,
  resetMappingDraft,
  supplierLocked = false,
  supplierLockedName = ''
}) {
  const selectedSupplier = suppliers.find(
    (supplier) => String(supplier.id) === String(selectedSupplierId)
  );
  const resolvedSupplierName =
    supplierLockedName || selectedSupplier?.name || `#${selectedSupplierId || '-'}`;
  const mappingKeyLabel = (key) => {
    if (key === 'extra') return 'Назва (extra)';
    if (key === 'comment') return 'Коментар (comment)';
    return key;
  };

  return (
    <div className="grid">
      <Section
        title={supplierLocked ? 'Крок 1. Джерела постачальника' : 'Крок 1. Постачальник і джерело'}
        subtitle={
          supplierLocked
            ? 'Робота в межах вибраного постачальника'
            : 'Оберіть, що саме налаштовуємо'
        }
      >
        {supplierLocked ? (
          <div className="context-inline">
            <div>
              <strong>Постачальник:</strong> {resolvedSupplierName}
              <span className="muted"> (ID: {selectedSupplierId || '-'})</span>
            </div>
            <button className="btn" onClick={() => refreshSources(selectedSupplierId)}>
              Оновити джерела
            </button>
          </div>
        ) : null}

        <div className="form-row">
          {!supplierLocked ? (
            <div>
              <label>Постачальник</label>
              <select
                value={selectedSupplierId}
                onChange={(event) => setSelectedSupplierId(event.target.value)}
              >
                <option value="">-- оберіть --</option>
                {suppliers.map((supplier) => (
                  <option key={supplier.id} value={supplier.id}>
                    {supplier.id} - {supplier.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <div>
            <label>Джерело</label>
            <select value={selectedSourceId} onChange={(event) => setSelectedSourceId(event.target.value)}>
              <option value="">-- оберіть --</option>
              {sources.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.id} - {source.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label>&nbsp;</label>
            <div className="actions">
              {!supplierLocked ? (
                <button className="btn" onClick={() => refreshSources(selectedSupplierId)}>
                  Оновити джерела
                </button>
              ) : null}
              <button
                className="btn"
                onClick={() => {
                  setEditingSourceId('');
                  setSourceDraft(toSourceDraft(null));
                  setSourceErrors({});
                }}
              >
                Додати джерело
              </button>
            </div>
          </div>
        </div>

        <details className="details-block" style={{ marginTop: 10 }}>
          <summary>
            {editingSourceId ? `Редагування source #${editingSourceId}` : 'Додати нове джерело'}
          </summary>
          <div className="form-row" style={{ marginTop: 10 }}>
            <div>
              <label>Назва</label>
              <input
                value={sourceDraft.name}
                onChange={(event) => setSourceDraft((prev) => ({ ...prev, name: event.target.value }))}
              />
            </div>
            <div>
              <label>Тип джерела</label>
              <select
                value={sourceDraft.source_type}
                onChange={(event) =>
                  setSourceDraft((prev) => ({ ...prev, source_type: event.target.value }))
                }
              >
                {sourceTypes.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
              {sourceErrors.source_type ? (
                <div className="field-error">{sourceErrors.source_type}</div>
              ) : null}
            </div>
          </div>
          <div className="form-row">
            <div>
              <label>source_url</label>
              <input
                value={sourceDraft.source_url}
                onChange={(event) =>
                  setSourceDraft((prev) => ({ ...prev, source_url: event.target.value }))
                }
              />
              {sourceErrors.source_url ? <div className="field-error">{sourceErrors.source_url}</div> : null}
              <div className="hint">detected: {parseSourceUrlHint(sourceDraft.source_url) || '-'}</div>
            </div>
            <div>
              <label>sheet_name</label>
              <input
                value={sourceDraft.sheet_name}
                onChange={(event) =>
                  setSourceDraft((prev) => ({ ...prev, sheet_name: event.target.value }))
                }
              />
            </div>
          </div>
          <label>
            <input
              type="checkbox"
              checked={sourceDraft.is_active}
              onChange={(event) =>
                setSourceDraft((prev) => ({ ...prev, is_active: event.target.checked }))
              }
              style={{ width: 'auto', marginRight: 8 }}
            />
            Джерело активне
          </label>
          <div className="actions" style={{ marginTop: 8 }}>
            <button className="btn primary" disabled={isReadOnly} onClick={saveSource}>
              {editingSourceId ? 'Зберегти джерело' : 'Створити джерело'}
            </button>
            <button
              className="btn"
              onClick={() => {
                setEditingSourceId('');
                setSourceDraft(toSourceDraft(null));
                setSourceErrors({});
              }}
            >
              Скинути форму
            </button>
          </div>
          <div className="status-line">{sourceFormStatus}</div>
        </details>

        <table>
          <thead>
            <tr>
              <th>Джерело</th>
              <th>Тип</th>
              <th>Аркуш</th>
              <th>Стан</th>
              <th>Дії</th>
            </tr>
          </thead>
          <tbody>
            {sources.map((source) => (
              <tr key={source.id}>
                <td>
                  <div>{source.name || '-'}</div>
                  <div className="muted">ID: {source.id}</div>
                </td>
                <td>{source.source_type}</td>
                <td>{source.sheet_name || '-'}</td>
                <td>
                  <Tag tone={source.is_active ? 'ok' : 'warn'}>
                    {source.is_active ? 'active' : 'paused'}
                  </Tag>
                </td>
                <td>
                  <div className="actions">
                    <button
                      className="btn"
                      onClick={() => {
                        setEditingSourceId(String(source.id));
                        setSelectedSourceId(String(source.id));
                        setSourceDraft(toSourceDraft(source));
                        setSourceErrors({});
                      }}
                    >
                      Редагувати
                    </button>
                    <button
                      className="btn danger"
                      disabled={isReadOnly}
                      onClick={() => deleteSource(source.id)}
                    >
                      Видалити
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="status-line">{sourcesStatus}</div>
      </Section>

      <Section title="Крок 2. Перевірка джерела" subtitle="Аркуші та тестове превʼю таблиці">
        <div className="form-row">
          <div>
            <label>Аркуш</label>
            <select value={selectedSheetName} onChange={(event) => setSelectedSheetName(event.target.value)}>
              <option value="">-- auto --</option>
              {sourceSheets.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label>Header row</label>
            <input value={mappingHeaderRow} onChange={(event) => setMappingHeaderRow(event.target.value)} />
            {mappingErrors.header_row ? <div className="field-error">{mappingErrors.header_row}</div> : null}
          </div>
          <div>
            <label>&nbsp;</label>
            <div className="actions">
              <button className="btn" onClick={loadSourceSheets}>Завантажити аркуші</button>
              <button className="btn" onClick={loadSourcePreview}>Показати превʼю</button>
            </div>
          </div>
        </div>

        <div className="status-line">{sourceSheetsStatus}</div>
        <div className={`status-line ${sourcePreview.status.includes('error') ? 'error' : ''}`}>
          {sourcePreview.status}
        </div>

        {sourcePreview.sampleRows.length > 0 ? (
          <div className="preview-table-wrap">
            <table>
              <thead>
                <tr>
                  {sourcePreview.headers.map((header, index) => (
                    <th key={index}>
                      {columnLetter(index + 1)} / {index + 1}
                      <br />
                      {header || '[blank]'}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sourcePreview.sampleRows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {sourcePreview.headers.map((_, colIndex) => (
                      <td key={`${rowIndex}_${colIndex}`}>{row[colIndex] || ''}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-preview">Превʼю ще не завантажено</div>
        )}

      </Section>

      <Section title="Крок 3. Мапінг полів" subtitle="Налаштуйте відповідність колонок і збережіть">
        <div className="hint" style={{ marginBottom: 8 }}>
          Для додаткових даних товару використовуйте поле <strong>comment</strong> у builder.
        </div>
        <div className="mapping-builder">
          {mappingKeys.map((key) => {
            const entry = mappingFields[key];
            return (
              <div className="mapping-row" key={key}>
                <div className="mapping-key">{mappingKeyLabel(key)}</div>
                <select
                  value={entry.mode}
                  onChange={(event) => {
                    const mode = event.target.value;
                    if (mode === 'static') {
                      updateMappingField(key, {
                        mode: 'static',
                        value: entry.value === null ? '' : String(entry.value)
                      });
                    } else {
                      updateMappingField(key, {
                        mode: 'column',
                        value:
                          Number.isFinite(Number(entry.value)) && Number(entry.value) > 0
                            ? Number(entry.value)
                            : null
                      });
                    }
                  }}
                >
                  <option value="column">Колонка</option>
                  <option value="static">Статичне значення</option>
                </select>
                {entry.mode === 'column' ? (
                  <select
                    value={entry.value === null ? '' : String(entry.value)}
                    onChange={(event) =>
                      updateMappingField(key, {
                        value: event.target.value ? Number(event.target.value) : null
                      })
                    }
                  >
                    <option value="">-- не обрано --</option>
                    {mappingColumnOptions.map((option) => (
                      <option key={`${key}_${option.value}`} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    value={String(entry.value ?? '')}
                    onChange={(event) =>
                      updateMappingField(key, {
                        value: event.target.value
                      })
                    }
                  />
                )}
                <label>
                  <input
                    type="checkbox"
                    checked={entry.allowEmpty === true}
                    onChange={(event) =>
                      updateMappingField(key, { allowEmpty: event.target.checked })
                    }
                    style={{ width: 'auto', marginRight: 6 }}
                  />
                  allow empty
                </label>
              </div>
            );
          })}
        </div>

        <div className="actions" style={{ marginTop: 8 }}>
          <button className="btn" onClick={resetMappingDraft}>
            Новий мапінг
          </button>
          <button className="btn" onClick={applyBuilderToJson}>
            Builder → JSON
          </button>
          <button className="btn" onClick={() => refreshMapping(selectedSupplierId, selectedSourceId)}>
            Оновити з бази
          </button>
          <button className="btn primary" disabled={isReadOnly} onClick={saveMapping}>
            Зберегти мапінг
          </button>
        </div>

        <details className="details-block" style={{ marginTop: 10 }}>
          <summary>JSON та технічні поля мапінгу</summary>
          <label style={{ marginTop: 10 }}>Технічна примітка конфігурації</label>
          <input value={mappingComment} onChange={(event) => setMappingComment(event.target.value)} />
          <div className="hint">Це службове поле конфігурації, не поле товару.</div>
          <label style={{ marginTop: 10 }}>Mapping JSON</label>
          <textarea value={mappingText} onChange={(event) => setMappingText(event.target.value)} />
          {mappingErrors.mapping ? <div className="field-error">{mappingErrors.mapping}</div> : null}
        </details>

        <div
          className={`status-line ${
            mappingStatus.includes('помилка') || mappingStatus.includes('error') ? 'error' : ''
          }`}
        >
          {mappingStatus}
        </div>
      </Section>
    </div>
  );
}
