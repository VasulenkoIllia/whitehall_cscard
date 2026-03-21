import React from 'react';
import { toJsonString } from '../lib/api';
import { columnLetter } from '../lib/mapping';
import { Section } from '../components/ui';

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
  mappingStatus
}) {
  return (
    <div className="grid">
      <Section title="Джерела" subtitle="Source CRUD + sheet preview">
        <div className="form-row">
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
            <button className="btn" onClick={() => refreshSources(selectedSupplierId)}>
              Оновити джерела
            </button>
          </div>
        </div>

        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Name</th>
              <th>Type</th>
              <th>Active</th>
              <th>Sheet</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {sources.map((source) => (
              <tr key={source.id}>
                <td>{source.id}</td>
                <td>{source.name}</td>
                <td>{source.source_type}</td>
                <td>{source.is_active ? 'true' : 'false'}</td>
                <td>{source.sheet_name || '-'}</td>
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
                      Edit
                    </button>
                    <button
                      className="btn danger"
                      disabled={isReadOnly}
                      onClick={() => deleteSource(source.id)}
                    >
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="status-line">{sourcesStatus}</div>
      </Section>

      <Section title={editingSourceId ? `Редагування source #${editingSourceId}` : 'Нове джерело'}>
        <div className="form-row">
          <div>
            <label>Name</label>
            <input
              value={sourceDraft.name}
              onChange={(event) => setSourceDraft((prev) => ({ ...prev, name: event.target.value }))}
            />
          </div>
          <div>
            <label>source_type</label>
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
          is_active
        </label>
        <div className="actions" style={{ marginTop: 8 }}>
          <button className="btn primary" disabled={isReadOnly} onClick={saveSource}>
            {editingSourceId ? 'Save source' : 'Create source'}
          </button>
          <button
            className="btn"
            onClick={() => {
              setEditingSourceId('');
              setSourceDraft(toSourceDraft(null));
              setSourceErrors({});
            }}
          >
            Reset form
          </button>
        </div>
        <div className="status-line">{sourceFormStatus}</div>
      </Section>

      <Section title="Google Sheets preview" subtitle="Лоад аркушів + headers/sample rows">
        <div className="form-row">
          <div>
            <label>Sheet name</label>
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
          </div>
        </div>
        <div className="actions">
          <button className="btn" onClick={loadSourceSheets}>Load sheets</button>
          <button className="btn" onClick={loadSourcePreview}>Load preview</button>
        </div>
        <div className="status-line">{sourceSheetsStatus}</div>
        <div className={`status-line ${sourcePreview.status.includes('error') ? 'error' : ''}`}>
          {sourcePreview.status}
        </div>
        <pre>
          {toJsonString({
            sheet: sourcePreview.sheetName || selectedSheetName || null,
            headerRow: sourcePreview.headerRow,
            headers: sourcePreview.headers
          })}
        </pre>
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
        ) : null}
      </Section>

      <Section title="Мапінг" subtitle="Builder + JSON + Коментар">
        <div className="mapping-builder">
          {mappingKeys.map((key) => {
            const entry = mappingFields[key];
            return (
              <div className="mapping-row" key={key}>
                <div className="mapping-key">{key}</div>
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
                  <option value="column">column</option>
                  <option value="static">static</option>
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
                    <option value="">-- not set --</option>
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
          <button className="btn" onClick={applyBuilderToJson}>
            Builder to JSON
          </button>
          <button className="btn" onClick={() => refreshMapping(selectedSupplierId, selectedSourceId)}>
            Reload mapping
          </button>
        </div>

        <div className="form-row">
          <div>
            <label>Header row</label>
            <input value={mappingHeaderRow} onChange={(event) => setMappingHeaderRow(event.target.value)} />
            {mappingErrors.header_row ? <div className="field-error">{mappingErrors.header_row}</div> : null}
          </div>
          <div>
            <label>Коментар</label>
            <input value={mappingComment} onChange={(event) => setMappingComment(event.target.value)} />
          </div>
        </div>
        <label>Mapping JSON</label>
        <textarea value={mappingText} onChange={(event) => setMappingText(event.target.value)} />
        {mappingErrors.mapping ? <div className="field-error">{mappingErrors.mapping}</div> : null}
        <div className="actions" style={{ marginTop: 8 }}>
          <button className="btn primary" disabled={isReadOnly} onClick={saveMapping}>
            Save mapping
          </button>
        </div>
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
