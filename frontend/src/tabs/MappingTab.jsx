import React, { useEffect, useMemo, useRef, useState } from 'react';
import { columnLetter } from '../lib/mapping';
import { Section } from '../components/ui';

function formatDateTime(value) {
  if (!value) {
    return '-';
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return '-';
  }
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
}

export function MappingTab({
  selectedSupplierId,
  setSelectedSupplierId,
  suppliers,
  selectedSourceId,
  setSelectedSourceId,
  sources,
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
  const [isPreviewVisible, setPreviewVisible] = useState(false);
  const [editingMappingRecord, setEditingMappingRecord] = useState(null);
  const previousMappingStatusRef = useRef('');

  const selectedSupplier = suppliers.find(
    (supplier) => String(supplier.id) === String(selectedSupplierId)
  );
  const selectedSource = sources.find((source) => String(source.id) === String(selectedSourceId));
  const resolvedSupplierName =
    supplierLockedName || selectedSupplier?.name || `#${selectedSupplierId || '-'}`;
  const sourcePreviewHasError = /(error|помилка)/i.test(sourcePreview.status || '');
  const mappingRows = Array.isArray(mappingRecords) ? mappingRecords : [];
  const isOperationalStatus = (value) =>
    /(error|помилка|failed|завантаження|loading)/i.test(String(value || ''));

  const mappingRowsBySource = useMemo(() => {
    const sourceId = Number(selectedSourceId);
    if (!Number.isFinite(sourceId) || sourceId <= 0) {
      return [];
    }
    return mappingRows.filter((row) => Number(row?.source_id || 0) === sourceId);
  }, [mappingRows, selectedSourceId]);

  const mappingKeyLabel = (key) => {
    if (key === 'extra') return 'Назва (extra)';
    if (key === 'comment') return 'Коментар (comment)';
    return key;
  };

  const closeMappingEditor = () => {
    setMappingEditorOpen(false);
    setEditingMappingRecord(null);
    setPreviewVisible(false);
  };

  const openCreateMapping = async () => {
    if (!selectedSourceId) {
      return;
    }
    resetMappingDraft();
    setEditingMappingRecord(null);
    setPreviewVisible(true);
    setMappingEditorOpen(true);
    await loadSourceSheets();
    await loadSourcePreview();
  };

  const openEditMapping = (row) => {
    const sourceId = Number(row?.source_id || 0);
    if (sourceId > 0) {
      setSelectedSourceId(String(sourceId));
    }
    const rowSheet = String(row?.mapping_meta?.sheet_name || '').trim();
    if (rowSheet) {
      setSelectedSheetName(rowSheet);
    }
    loadMappingFromRecord(row);
    setEditingMappingRecord(row || null);
    setPreviewVisible(false);
    setMappingEditorOpen(true);
  };

  const handleDeleteMapping = async (row) => {
    const mappingId = Number(row?.id || 0);
    if (!Number.isFinite(mappingId) || mappingId <= 0) {
      return;
    }
    const deleted = await deleteMapping(mappingId);
    if (deleted && editingMappingRecord && Number(editingMappingRecord.id) === mappingId) {
      closeMappingEditor();
    }
  };

  const togglePreview = async () => {
    if (isPreviewVisible) {
      setPreviewVisible(false);
      return;
    }
    if (sourcePreview.sampleRows.length === 0) {
      await loadSourcePreview();
    }
    setPreviewVisible(true);
  };

  useEffect(() => {
    if (!selectedSupplierId || !selectedSourceId) {
      return;
    }
    void refreshMappingRecords(selectedSupplierId, selectedSourceId);
  }, [selectedSupplierId, selectedSourceId]);

  useEffect(() => {
    const normalizedStatus = String(mappingStatus || '').toLowerCase();
    const wasSaved = previousMappingStatusRef.current.includes('мапінг збережено');
    const isSavedNow = normalizedStatus.includes('мапінг збережено');
    if (isMappingEditorOpen && isSavedNow && !wasSaved) {
      closeMappingEditor();
    }
    previousMappingStatusRef.current = normalizedStatus;
  }, [isMappingEditorOpen, mappingStatus]);

  return (
    <Section
      title="Мапінг джерела"
      subtitle="Постачальник, джерело і список мапінгів"
    >
      {supplierLocked ? (
        <div className="context-inline">
          <div>
            <strong>Постачальник:</strong> {resolvedSupplierName}
            <span className="muted"> (ID: {selectedSupplierId || '-'})</span>
          </div>
        </div>
      ) : (
        <div className="form-row">
          <div>
            <label>Постачальник</label>
            <select value={selectedSupplierId} onChange={(event) => setSelectedSupplierId(event.target.value)}>
              <option value="">-- оберіть --</option>
              {suppliers.map((supplier) => (
                <option key={supplier.id} value={supplier.id}>
                  {supplier.id} - {supplier.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      <div className="form-row">
        <div>
          <label>Джерело</label>
          <select value={selectedSourceId} onChange={(event) => setSelectedSourceId(event.target.value)}>
            <option value="">-- оберіть джерело --</option>
            {sources.map((source) => (
              <option key={source.id} value={source.id}>
                {source.name || `Джерело #${source.id}`} (ID: {source.id})
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="section-head">
        <div>
          <h4 className="block-title">Список мапінгів</h4>
          <p className="muted">
            {selectedSource ? `Джерело: ${selectedSource.name} (ID: ${selectedSource.id})` : 'Оберіть джерело'}
          </p>
        </div>
        <button
          className="btn primary"
          disabled={isReadOnly || !selectedSourceId}
          onClick={openCreateMapping}
        >
          Додати новий мапінг
        </button>
      </div>

      <div className="source-table-wrap">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Header row</th>
              <th>Створено</th>
              <th>Дії</th>
            </tr>
          </thead>
          <tbody>
            {mappingRowsBySource.length === 0 ? (
              <tr>
                <td colSpan={4} className="supplier-empty-row">
                  Мапінгів для цього джерела ще немає
                </td>
              </tr>
            ) : (
              mappingRowsBySource.map((row) => (
                <tr key={row.id}>
                  <td>#{row.id}</td>
                  <td>{row.header_row || '-'}</td>
                  <td>{formatDateTime(row.created_at)}</td>
                  <td>
                    <div className="actions">
                      <button className="btn" onClick={() => openEditMapping(row)}>
                        Редагувати
                      </button>
                      <button
                        className="btn danger"
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

      {isOperationalStatus(mappingRecordsStatus) ? (
        <div className={`status-line ${/(error|помилка|failed)/i.test(mappingRecordsStatus) ? 'error' : ''}`}>
          {mappingRecordsStatus}
        </div>
      ) : null}
      {isOperationalStatus(sourcesStatus) ? (
        <div className={`status-line ${/(error|помилка|failed)/i.test(sourcesStatus) ? 'error' : ''}`}>
          {sourcesStatus}
        </div>
      ) : null}

      {isMappingEditorOpen ? (
        <div className="modal-backdrop" onClick={closeMappingEditor}>
          <div className="modal-card" onClick={(event) => event.stopPropagation()}>
            <div className="section-head">
              <div>
                <h3>
                  {editingMappingRecord
                    ? `Редагування мапінгу #${editingMappingRecord.id}`
                    : 'Новий мапінг'}
                </h3>
                <p className="muted">
                  Постачальник: {resolvedSupplierName}
                  <span className="muted"> | Джерело: {selectedSource?.name || '-'}</span>
                </p>
              </div>
              <button className="btn" onClick={closeMappingEditor}>Закрити</button>
            </div>

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
            </div>

            <div className="actions" style={{ marginBottom: 8 }}>
              <button className="btn" onClick={loadSourceSheets} disabled={!selectedSourceId}>
                Завантажити аркуші
              </button>
              <button className="btn" onClick={togglePreview} disabled={!selectedSourceId}>
                {isPreviewVisible ? 'Сховати превʼю' : 'Показати превʼю'}
              </button>
            </div>

            {isOperationalStatus(sourceSheetsStatus) ? (
              <div className={`status-line ${/(error|помилка|failed)/i.test(sourceSheetsStatus) ? 'error' : ''}`}>
                {sourceSheetsStatus}
              </div>
            ) : null}
            {isPreviewVisible ? (
              <>
                <div className={`status-line ${sourcePreviewHasError ? 'error' : ''}`}>{sourcePreview.status}</div>
                {sourcePreview.sampleRows.length > 0 ? (
                  <div className="preview-table-wrap" style={{ marginTop: 8 }}>
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
                  <div className="empty-preview" style={{ marginTop: 8 }}>
                    Превʼю ще не завантажено або джерело не містить рядків.
                  </div>
                )}
              </>
            ) : null}

            <div className="mapping-builder" style={{ marginTop: 10 }}>
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

            <div className="actions mapping-actions-main">
              <button className="btn primary" disabled={isReadOnly} onClick={saveMapping}>
                Зберегти мапінг
              </button>
              <button className="btn" onClick={closeMappingEditor}>
                Скасувати
              </button>
            </div>

            <div className={`status-line ${/(error|помилка)/i.test(mappingStatus) ? 'error' : ''}`}>
              {mappingStatus}
            </div>
          </div>
        </div>
      ) : null}
    </Section>
  );
}
