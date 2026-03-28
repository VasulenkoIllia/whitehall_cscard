import React, { useEffect, useRef, useMemo, useState } from 'react';
import { columnLetter } from '../lib/mapping';
import { Section } from '../components/ui';

function formatDateTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '-';
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
}

const isErrorStatus = (value) => /(error|помилка|failed)/i.test(String(value || ''));
const isOperationalStatus = (value) => /(error|помилка|failed|завантаження|loading)/i.test(String(value || ''));

export function MappingTab({
  selectedSupplierId,
  setSelectedSupplierId,
  suppliers,
  selectedSourceId,
  setSelectedSourceId,
  sources,
  sourceDraft,
  setSourceDraft,
  sourceErrors,
  sourceFormStatus,
  editingSourceId,
  startCreateSource,
  startEditSource,
  saveSource,
  deleteSource,
  isReadOnly,
  sourcesStatus,
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
  refreshMappingRecords,
  mappingRecords,
  mappingRecordsStatus,
  loadMappingFromRecord,
  mappingErrors,
  saveMapping,
  deleteMapping,
  mappingStatus,
  resetMappingDraft,
  supplierLocked = false,
  supplierLockedName = ''
}) {
  const [isMappingEditorOpen, setMappingEditorOpen] = useState(false);
  const [isSourceEditorOpen, setSourceEditorOpen] = useState(false);
  const [isPreviewVisible, setPreviewVisible] = useState(false);
  const [editingMappingRecord, setEditingMappingRecord] = useState(null);
  const previousMappingStatusRef = useRef('');
  const previousSourceFormStatusRef = useRef('');

  const selectedSupplier = suppliers.find((s) => String(s.id) === String(selectedSupplierId));
  const selectedSource = sources.find((s) => String(s.id) === String(selectedSourceId));
  const resolvedSupplierName = supplierLockedName || selectedSupplier?.name || `#${selectedSupplierId || '-'}`;

  const mappingRows = Array.isArray(mappingRecords) ? mappingRecords : [];
  const mappingRowsBySource = useMemo(() => {
    const sourceId = Number(selectedSourceId);
    if (!Number.isFinite(sourceId) || sourceId <= 0) return [];
    return mappingRows.filter((row) => Number(row?.source_id || 0) === sourceId);
  }, [mappingRows, selectedSourceId]);

  const mappingKeyLabel = (key) => {
    if (key === 'extra') return 'Назва (extra)';
    if (key === 'comment') return 'Коментар';
    return key;
  };

  const openCreateSourceEditor = () => {
    if (!selectedSupplierId) return;
    startCreateSource();
    setSourceEditorOpen(true);
  };

  const openEditSourceEditor = (source) => {
    if (!source) return;
    startEditSource(source);
    setSourceEditorOpen(true);
  };

  const closeSourceEditor = () => setSourceEditorOpen(false);

  const handleDeleteSource = async (sourceIdRaw) => {
    const sourceId = Number(sourceIdRaw);
    if (!Number.isFinite(sourceId) || sourceId <= 0) return;
    await deleteSource(sourceId);
  };

  const closeMappingEditor = () => {
    setMappingEditorOpen(false);
    setEditingMappingRecord(null);
    setPreviewVisible(false);
  };

  const openCreateMapping = async () => {
    if (!selectedSourceId) return;
    resetMappingDraft();
    setEditingMappingRecord(null);
    setPreviewVisible(true);
    setMappingEditorOpen(true);
    await loadSourceSheets();
    await loadSourcePreview();
  };

  const openEditMapping = (row) => {
    const sourceId = Number(row?.source_id || 0);
    if (sourceId > 0) setSelectedSourceId(String(sourceId));
    const rowSheet = String(row?.mapping_meta?.sheet_name || '').trim();
    if (rowSheet) setSelectedSheetName(rowSheet);
    loadMappingFromRecord(row);
    setEditingMappingRecord(row || null);
    setPreviewVisible(false);
    setMappingEditorOpen(true);
  };

  const handleDeleteMapping = async (row) => {
    const mappingId = Number(row?.id || 0);
    if (!Number.isFinite(mappingId) || mappingId <= 0) return;
    const deleted = await deleteMapping(mappingId);
    if (deleted && editingMappingRecord && Number(editingMappingRecord.id) === mappingId) {
      closeMappingEditor();
    }
  };

  const togglePreview = async () => {
    if (isPreviewVisible) { setPreviewVisible(false); return; }
    if (sourcePreview.sampleRows.length === 0) await loadSourcePreview();
    setPreviewVisible(true);
  };

  useEffect(() => {
    if (!selectedSupplierId || !selectedSourceId) return;
    void refreshMappingRecords(selectedSupplierId, selectedSourceId);
  }, [selectedSupplierId, selectedSourceId]);

  useEffect(() => {
    const status = String(mappingStatus || '').toLowerCase();
    const wasSaved = previousMappingStatusRef.current.includes('мапінг збережено');
    if (isMappingEditorOpen && status.includes('мапінг збережено') && !wasSaved) closeMappingEditor();
    previousMappingStatusRef.current = status;
  }, [isMappingEditorOpen, mappingStatus]);

  useEffect(() => {
    const status = String(sourceFormStatus || '').toLowerCase();
    const wasSaved = previousSourceFormStatusRef.current.includes('джерело збережено');
    if (isSourceEditorOpen && status.includes('джерело збережено') && !wasSaved) closeSourceEditor();
    previousSourceFormStatusRef.current = status;
  }, [isSourceEditorOpen, sourceFormStatus]);

  return (
    <Section title="Джерела та мапінги">

      {/* Supplier selector (only when not locked) */}
      {!supplierLocked ? (
        <div style={{ marginBottom: 12 }}>
          <label>Постачальник</label>
          <select value={selectedSupplierId} onChange={(event) => setSelectedSupplierId(event.target.value)}>
            <option value="">— оберіть —</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>{s.id} — {s.name}</option>
            ))}
          </select>
        </div>
      ) : null}

      {/* Sources */}
      <div className="mapping-section-head">
        <h4 className="block-title">Джерела</h4>
        <button
          className="btn btn-sm primary"
          disabled={isReadOnly || !selectedSupplierId}
          onClick={openCreateSourceEditor}
        >
          + Додати
        </button>
      </div>

      <div className="source-table-wrap" style={{ marginBottom: 16 }}>
        <table>
          <thead>
            <tr>
              <th>Назва</th>
              <th>Тип</th>
              <th>Аркуш</th>
              <th>Стан</th>
              <th style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>Дії</th>
            </tr>
          </thead>
          <tbody>
            {sources.length === 0 ? (
              <tr>
                <td colSpan={5} className="supplier-empty-row">
                  Джерел ще немає — додайте перше
                </td>
              </tr>
            ) : (
              sources.map((source) => {
                const sourceId = String(source.id);
                const isSelected = sourceId === String(selectedSourceId);
                return (
                  <tr
                    key={`source_row_${source.id}`}
                    className={isSelected ? 'supplier-row-selected mapping-source-row' : 'mapping-source-row'}
                    onClick={() => setSelectedSourceId(sourceId)}
                    title="Клікніть щоб обрати джерело"
                  >
                    <td>
                      <div className="supplier-name-title">{source.name || `Джерело #${source.id}`}</div>
                      <div className="supplier-name-meta">ID: {source.id}</div>
                    </td>
                    <td>{source.source_type || '-'}</td>
                    <td>{source.sheet_name || '—'}</td>
                    <td>
                      <span className={`mapping-status-badge ${source.is_active ? 'ok' : 'warn'}`}>
                        {source.is_active ? 'Активне' : 'Призупинено'}
                      </span>
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <div className="actions" style={{ justifyContent: 'flex-end' }} onClick={(e) => e.stopPropagation()}>
                        <button className="btn btn-sm" onClick={() => openEditSourceEditor(source)}>
                          Редагувати
                        </button>
                        <button
                          className="btn btn-sm danger"
                          disabled={isReadOnly}
                          onClick={() => handleDeleteSource(source.id)}
                        >
                          Видалити
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {isOperationalStatus(sourcesStatus) ? (
        <div className={`status-line ${isErrorStatus(sourcesStatus) ? 'error' : ''}`}>{sourcesStatus}</div>
      ) : null}

      {/* Mappings — shown when source is selected */}
      <div className="mapping-section-head">
        <h4 className="block-title">
          Мапінги
          {selectedSource ? <span className="muted" style={{ fontWeight: 400, marginLeft: 6 }}>· {selectedSource.name || `#${selectedSource.id}`}</span> : null}
        </h4>
        <button
          className="btn btn-sm primary"
          disabled={isReadOnly || !selectedSourceId}
          onClick={openCreateMapping}
        >
          + Додати
        </button>
      </div>

      {!selectedSourceId ? (
        <div className="empty-preview">Оберіть джерело вище щоб переглянути або додати мапінги</div>
      ) : (
        <div className="source-table-wrap">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Рядок заголовку</th>
                <th>Створено</th>
                <th style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>Дії</th>
              </tr>
            </thead>
            <tbody>
              {mappingRowsBySource.length === 0 ? (
                <tr>
                  <td colSpan={4} className="supplier-empty-row">
                    Мапінгів ще немає — додайте перший
                  </td>
                </tr>
              ) : (
                mappingRowsBySource.map((row) => (
                  <tr key={row.id}>
                    <td>#{row.id}</td>
                    <td>{row.header_row || '—'}</td>
                    <td>{formatDateTime(row.created_at)}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <div className="actions" style={{ justifyContent: 'flex-end' }}>
                        <button className="btn btn-sm" onClick={() => openEditMapping(row)}>
                          Редагувати
                        </button>
                        <button
                          className="btn btn-sm danger"
                          disabled={isReadOnly}
                          onClick={() => handleDeleteMapping(row)}
                        >
                          Видалити
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {isOperationalStatus(mappingRecordsStatus) ? (
        <div className={`status-line ${isErrorStatus(mappingRecordsStatus) ? 'error' : ''}`}>{mappingRecordsStatus}</div>
      ) : null}

      {/* Mapping editor modal */}
      {isMappingEditorOpen ? (
        <div className="modal-backdrop" onClick={closeMappingEditor}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="section-head">
              <div>
                <h3>{editingMappingRecord ? `Мапінг #${editingMappingRecord.id}` : 'Новий мапінг'}</h3>
                <p className="muted">{resolvedSupplierName} · {selectedSource?.name || '—'}</p>
              </div>
              <button className="btn" onClick={closeMappingEditor}>Закрити</button>
            </div>

            <div className="form-row">
              <div>
                <label>Аркуш</label>
                <select value={selectedSheetName} onChange={(e) => setSelectedSheetName(e.target.value)}>
                  <option value="">— авто —</option>
                  {sourceSheets.map((name) => (
                    <option key={name} value={name}>{name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label>Рядок заголовку</label>
                <input value={mappingHeaderRow} onChange={(e) => setMappingHeaderRow(e.target.value)} />
                {mappingErrors.header_row ? <div className="field-error">{mappingErrors.header_row}</div> : null}
              </div>
            </div>

            <div className="actions" style={{ marginBottom: 10 }}>
              <button className="btn" onClick={loadSourceSheets} disabled={!selectedSourceId}>
                Завантажити аркуші
              </button>
              <button className="btn" onClick={togglePreview} disabled={!selectedSourceId}>
                {isPreviewVisible ? 'Сховати превʼю' : 'Показати превʼю'}
              </button>
            </div>

            {isOperationalStatus(sourceSheetsStatus) ? (
              <div className={`status-line ${isErrorStatus(sourceSheetsStatus) ? 'error' : ''}`}>{sourceSheetsStatus}</div>
            ) : null}

            {isPreviewVisible ? (
              <>
                <div className={`status-line ${/(error|помилка)/i.test(sourcePreview.status || '') ? 'error' : ''}`}>
                  {sourcePreview.status}
                </div>
                {sourcePreview.sampleRows.length > 0 ? (
                  <div className="preview-table-wrap" style={{ marginBottom: 10 }}>
                    <table>
                      <thead>
                        <tr>
                          {sourcePreview.headers.map((header, index) => (
                            <th key={index}>
                              {columnLetter(index + 1)} / {index + 1}<br />
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
                  <div className="empty-preview" style={{ marginBottom: 10 }}>Превʼю порожнє або ще не завантажене</div>
                )}
              </>
            ) : null}

            <div className="mapping-builder">
              {mappingKeys.map((key) => {
                const entry = mappingFields[key];
                return (
                  <div className="mapping-row" key={key}>
                    <div className="mapping-key">{mappingKeyLabel(key)}</div>
                    <select
                      value={entry.mode}
                      onChange={(e) => {
                        const mode = e.target.value;
                        if (mode === 'static') {
                          updateMappingField(key, { mode: 'static', value: entry.value === null ? '' : String(entry.value) });
                        } else {
                          updateMappingField(key, {
                            mode: 'column',
                            value: Number.isFinite(Number(entry.value)) && Number(entry.value) > 0 ? Number(entry.value) : null
                          });
                        }
                      }}
                    >
                      <option value="column">Колонка</option>
                      <option value="static">Статичне</option>
                    </select>
                    {entry.mode === 'column' ? (
                      <select
                        value={entry.value === null ? '' : String(entry.value)}
                        onChange={(e) => updateMappingField(key, { value: e.target.value ? Number(e.target.value) : null })}
                      >
                        <option value="">— не обрано —</option>
                        {mappingColumnOptions.map((opt) => (
                          <option key={`${key}_${opt.value}`} value={opt.value}>{opt.label}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        value={String(entry.value ?? '')}
                        onChange={(e) => updateMappingField(key, { value: e.target.value })}
                      />
                    )}
                    <label className="mapping-allow-empty">
                      <input
                        type="checkbox"
                        checked={entry.allowEmpty === true}
                        onChange={(e) => updateMappingField(key, { allowEmpty: e.target.checked })}
                        style={{ width: 'auto' }}
                      />
                      пусте
                    </label>
                  </div>
                );
              })}
            </div>

            <div className="actions mapping-actions-main">
              <button className="btn primary" disabled={isReadOnly} onClick={saveMapping}>
                Зберегти
              </button>
              <button className="btn" onClick={closeMappingEditor}>Скасувати</button>
            </div>

            <div className={`status-line ${isErrorStatus(mappingStatus) ? 'error' : ''}`}>{mappingStatus}</div>
          </div>
        </div>
      ) : null}

      {/* Source editor modal */}
      {isSourceEditorOpen ? (
        <div className="modal-backdrop" onClick={closeSourceEditor}>
          <div className="modal-card supplier-modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="section-head">
              <div>
                <h3>{editingSourceId ? `Джерело #${editingSourceId}` : 'Нове джерело'}</h3>
                <p className="muted">{resolvedSupplierName}</p>
              </div>
              <button className="btn" onClick={closeSourceEditor}>Закрити</button>
            </div>

            <div className="form-row">
              <div>
                <label>Назва</label>
                <input
                  value={sourceDraft.name}
                  onChange={(e) => setSourceDraft((prev) => ({ ...prev, name: e.target.value }))}
                />
              </div>
              <div>
                <label>Аркуш за замовчуванням</label>
                <input
                  value={sourceDraft.sheet_name}
                  onChange={(e) => setSourceDraft((prev) => ({ ...prev, sheet_name: e.target.value }))}
                  placeholder="Аркуш1"
                />
              </div>
            </div>

            <div>
              <label>Google Sheet ID / URL</label>
              <input
                value={sourceDraft.source_url}
                onChange={(e) => setSourceDraft((prev) => ({ ...prev, source_url: e.target.value }))}
                placeholder="1gxT2aRO... або повний URL"
              />
              {sourceErrors.source_url ? <div className="field-error">{sourceErrors.source_url}</div> : null}
            </div>

            <label className="supplier-modal-checkbox" style={{ marginTop: 10 }}>
              <input
                type="checkbox"
                checked={sourceDraft.is_active}
                onChange={(e) => setSourceDraft((prev) => ({ ...prev, is_active: e.target.checked }))}
              />
              Джерело активне
            </label>

            <div className="actions supplier-modal-actions">
              <button className="btn primary" disabled={isReadOnly} onClick={saveSource}>
                {editingSourceId ? 'Зберегти' : 'Створити'}
              </button>
              {editingSourceId ? (
                <button
                  className="btn danger"
                  disabled={isReadOnly}
                  onClick={async () => { await handleDeleteSource(editingSourceId); closeSourceEditor(); }}
                >
                  Видалити
                </button>
              ) : null}
            </div>
            <div className={`status-line ${isErrorStatus(sourceFormStatus) ? 'error' : ''}`}>{sourceFormStatus}</div>
          </div>
        </div>
      ) : null}
    </Section>
  );
}
