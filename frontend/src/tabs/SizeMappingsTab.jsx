import React, { useEffect, useRef, useState } from 'react';
import { Tag } from '../components/ui';

// Pure numeric size: digits only with optional decimal separator (e.g. 36, 36.5, 36,5)
const isNumericSize = (s) => /^\d+([.,]\d+)?$/.test(String(s || '').trim());

const CATEGORY_TABS = [
  { id: 'all',     label: 'Всі' },
  { id: 'numeric', label: 'Числові' },
  { id: 'alpha',   label: 'Буквені' }
];

const PER_PAGE = 50;

function filterByCategory(rows, key, category) {
  if (category === 'all') return rows;
  if (category === 'numeric') return rows.filter((r) => isNumericSize(r[key]));
  return rows.filter((r) => !isNumericSize(r[key]));
}

function countByCategory(rows, key) {
  const numeric = rows.filter((r) => isNumericSize(r[key])).length;
  return { all: rows.length, numeric, alpha: rows.length - numeric };
}

function Pagination({ page, totalPages, onPage }) {
  if (totalPages <= 1) return null;
  return (
    <div className="size-pagination">
      <button className="btn btn-sm" disabled={page === 1} onClick={() => onPage(page - 1)}>← Назад</button>
      <span className="size-page-indicator">сторінка {page} з {totalPages}</span>
      <button className="btn btn-sm" disabled={page === totalPages} onClick={() => onPage(page + 1)}>Вперед →</button>
    </div>
  );
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  // skip header row
  return lines.slice(1).map((line) => {
    const comma = line.indexOf(',');
    if (comma === -1) return null;
    const size_from = line.slice(0, comma).trim().replace(/^"|"$/g, '');
    const size_to   = line.slice(comma + 1).trim().replace(/^"|"$/g, '');
    if (!size_from) return null;
    // empty size_to is allowed — maps size to nothing (removes size suffix from SKU)
    return { size_from, size_to };
  }).filter(Boolean);
}

const EMPTY_DRAFT = { size_from: '', size_to: '', notes: '', is_active: true, emptyTo: false };

export function SizeMappingsTab({
  sizeMappings,
  unmappedSizes,
  sizeMappingStatus,
  refreshSizeMappings,
  refreshUnmappedSizes,
  createSizeMapping,
  updateSizeMapping,
  deleteSizeMapping,
  bulkImportSizeMappings,
  isReadOnly,
}) {
  const mappingRows = Array.isArray(sizeMappings?.rows) ? sizeMappings.rows : [];
  const unmappedRows = Array.isArray(unmappedSizes?.rows) ? unmappedSizes.rows : [];

  const [activeView, setActiveView]             = useState('unmapped');
  const [mappingCategory, setMappingCategory]   = useState('all');
  const [unmappedCategory, setUnmappedCategory] = useState('all');
  const [search, setSearch]                     = useState('');
  const [unmappedSearch, setUnmappedSearch]     = useState('');
  const [mappingPage, setMappingPage]           = useState(1);
  const [unmappedPage, setUnmappedPage]         = useState(1);

  const [draft, setDraft]           = useState(null);
  const [draftMode, setDraftMode]   = useState('create');
  const [draftErrors, setDraftErrors] = useState({});
  const [deleteId, setDeleteId]     = useState(null);

  // CSV import state
  const fileInputRef = useRef(null);
  const [csvPreview, setCsvPreview] = useState(null); // { all, matched, toImport }
  const [csvImporting, setCsvImporting] = useState(false);
  const [csvError, setCsvError]     = useState('');

  // Auto-load on first mount
  useEffect(() => {
    if (mappingRows.length === 0) void refreshSizeMappings();
    if (unmappedRows.length === 0) void refreshUnmappedSizes();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reset pagination when filters change
  useEffect(() => { setMappingPage(1); }, [mappingCategory, search]);
  useEffect(() => { setUnmappedPage(1); }, [unmappedCategory, unmappedSearch]);

  const isError = (s) => /(error|помилка)/i.test(String(s || ''));

  // ── Filtering ─────────────────────────────────────────────────────────────

  const searchLower = search.trim().toLowerCase();
  const searchedMappings = searchLower
    ? mappingRows.filter(
        (r) =>
          String(r.size_from || '').toLowerCase().includes(searchLower) ||
          String(r.size_to || '').toLowerCase().includes(searchLower)
      )
    : mappingRows;
  const filteredMappings = filterByCategory(searchedMappings, 'size_from', mappingCategory);

  const unmappedSearchLower = unmappedSearch.trim().toLowerCase();
  const searchedUnmapped = unmappedSearchLower
    ? unmappedRows.filter((r) => String(r.raw_size || '').toLowerCase().includes(unmappedSearchLower))
    : unmappedRows;
  const filteredUnmapped = filterByCategory(searchedUnmapped, 'raw_size', unmappedCategory);
  const unmappedCounts   = countByCategory(searchedUnmapped, 'raw_size');
  const mappingCounts    = countByCategory(searchedMappings, 'size_from');

  // Real total from backend (may be > fetched rows)
  const unmappedRealTotal = unmappedSizes?.total || unmappedRows.length;
  const unmappedTruncated = unmappedRows.length < unmappedRealTotal;

  // Pagination slices
  const mappingTotalPages  = Math.max(1, Math.ceil(filteredMappings.length / PER_PAGE));
  const unmappedTotalPages = Math.max(1, Math.ceil(filteredUnmapped.length / PER_PAGE));
  const safeMappingPage    = Math.min(mappingPage, mappingTotalPages);
  const safeUnmappedPage   = Math.min(unmappedPage, unmappedTotalPages);
  const pagedMappings  = filteredMappings.slice((safeMappingPage - 1) * PER_PAGE, safeMappingPage * PER_PAGE);
  const pagedUnmapped  = filteredUnmapped.slice((safeUnmappedPage - 1) * PER_PAGE, safeUnmappedPage * PER_PAGE);

  // ── Draft helpers ─────────────────────────────────────────────────────────

  const openCreate = (prefill = {}) => {
    setDraft({ ...EMPTY_DRAFT, ...prefill });
    setDraftMode('create');
    setDraftErrors({});
  };

  const openEdit = (row) => {
    const sizeTo = row.size_to ?? '';
    setDraft({
      id: row.id,
      size_from: row.size_from || '',
      size_to:   sizeTo,
      notes:     row.notes     || '',
      is_active: row.is_active !== false,
      emptyTo:   sizeTo === '',
    });
    setDraftMode('edit');
    setDraftErrors({});
  };

  const closeDraft = () => { setDraft(null); setDraftErrors({}); };

  const validateDraft = () => {
    const errs = {};
    if (!String(draft.size_from || '').trim()) errs.size_from = 'Вкажіть оригінальний розмір';
    if (!draft.emptyTo && !String(draft.size_to || '').trim()) errs.size_to = 'Вкажіть нормалізований розмір або позначте «Пустий рядок»';
    setDraftErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleSave = async () => {
    if (isReadOnly) return;
    if (!validateDraft()) return;
    const payload = {
      size_from:           String(draft.size_from).trim(),
      size_to:             draft.emptyTo ? '' : String(draft.size_to).trim(),
      notes:               String(draft.notes || '').trim() || null,
      allow_empty_size_to: draft.emptyTo || undefined,
    };
    if (draftMode === 'edit') {
      await updateSizeMapping(draft.id, { ...payload, is_active: draft.is_active });
    } else {
      await createSizeMapping(payload);
    }
    closeDraft();
  };

  const handleDelete = async () => {
    if (isReadOnly) return;
    if (!deleteId) return;
    await deleteSizeMapping(deleteId);
    setDeleteId(null);
  };

  // ── CSV import helpers ────────────────────────────────────────────────────

  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    setCsvError('');
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result;
      if (typeof text !== 'string') { setCsvError('Не вдалося прочитати файл'); return; }
      const all = parseCsv(text);
      if (all.length === 0) { setCsvError('Файл порожній або невірний формат (очікується: Розмір,Відповідність)'); return; }
      // Compare against loaded unmapped rows for preview
      const unmappedSet = new Set(unmappedRows.map((r) => String(r.raw_size || '').toLowerCase().trim()));
      const matched = all.filter((r) => unmappedSet.has(r.size_from.toLowerCase()));
      // If unmapped data was truncated, import all CSV rows (server skips existing via ON CONFLICT)
      const toImport = unmappedTruncated ? all : matched;
      setCsvPreview({ all, matched, toImport, truncated: unmappedTruncated });
    };
    reader.readAsText(file, 'utf-8');
  };

  const handleCsvConfirm = async () => {
    if (!csvPreview?.toImport?.length) return;
    setCsvImporting(true);
    setCsvError('');
    try {
      await bulkImportSizeMappings(csvPreview.toImport);
      setCsvPreview(null);
    } catch (err) {
      setCsvError(String(err?.message || err || 'Помилка імпорту'));
    } finally {
      setCsvImporting(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="size-mappings-root">

      {/* ── Main view tabs ──────────────────────────────────────────────────── */}
      <div className="size-view-tabs">
        <button
          className={`size-view-tab ${activeView === 'unmapped' ? 'active' : ''}`}
          onClick={() => setActiveView('unmapped')}
        >
          Незнайомі розміри
          <span className={`size-view-badge ${unmappedRealTotal > 0 ? 'warn' : ''}`}>
            {unmappedRealTotal}
          </span>
        </button>
        <button
          className={`size-view-tab ${activeView === 'mappings' ? 'active' : ''}`}
          onClick={() => setActiveView('mappings')}
        >
          Таблиця відповідностей
          <span className="size-view-badge">
            {mappingRows.length}
          </span>
        </button>
      </div>

      {/* ── Unmapped panel ──────────────────────────────────────────────────── */}
      {activeView === 'unmapped' && (
        <div className="size-panel">
          <div className="size-section-toolbar">
            <input
              className="size-search-input"
              placeholder="Пошук незнайомого розміру..."
              value={unmappedSearch}
              onChange={(e) => setUnmappedSearch(e.target.value)}
            />
            <div className="mini-tabs">
              {CATEGORY_TABS.map((cat) => (
                <button
                  key={cat.id}
                  className={`tab ${unmappedCategory === cat.id ? 'active' : ''}`}
                  onClick={() => setUnmappedCategory(cat.id)}
                >
                  {cat.label}
                  {unmappedRows.length > 0 && cat.id !== 'all' && (
                    <span className="size-tab-count">{unmappedCounts[cat.id]}</span>
                  )}
                </button>
              ))}
            </div>
            <button className="btn" onClick={refreshUnmappedSizes}>Оновити</button>
          </div>

          {unmappedTruncated && !unmappedSizes?.status && (
            <div className="size-truncated-note">
              Завантажено топ {unmappedRows.length} розмірів з {unmappedRealTotal} незнайомих (за к-стю товарів). Для пошуку інших — введіть запит вище.
            </div>
          )}

          {unmappedSizes?.status && (
            <div className={`status-line${isError(unmappedSizes.status) ? ' error' : ''}`}>
              {unmappedSizes.status}
            </div>
          )}

          {filteredUnmapped.length === 0 ? (
            <div className="size-empty">
              {unmappedRows.length === 0
                ? 'Всі розміри мають маппінг або дані ще не завантажено'
                : 'Нічого не знайдено в цій категорії'}
            </div>
          ) : (
            <>
              <div className="size-table-wrap">
                <table className="size-table">
                  <thead>
                    <tr>
                      <th>Оригінал від постачальника</th>
                      <th>Стане (без маппінгу)</th>
                      <th style={{ textAlign: 'right' }}>Товарів</th>
                      <th style={{ textAlign: 'right' }}>Пост.</th>
                      <th style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>Дії</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagedUnmapped.map((row) => (
                      <tr key={row.raw_size}>
                        <td><code className="size-code">{row.raw_size}</code></td>
                        <td>
                          <span className="size-will-become">{row.will_become}</span>
                          {row.raw_size !== row.will_become && (
                            <span className="size-will-become-note"> (UPPER)</span>
                          )}
                        </td>
                        <td style={{ textAlign: 'right' }}>{row.product_count}</td>
                        <td style={{ textAlign: 'right' }}>{row.supplier_count}</td>
                        <td style={{ textAlign: 'right' }}>
                          <button
                            className="btn btn-sm primary"
                            disabled={isReadOnly}
                            onClick={() => {
                              openCreate({ size_from: row.raw_size, size_to: row.will_become });
                              setActiveView('mappings');
                            }}
                          >
                            + Маппінг
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="size-status-bar">
                <span>
                  {unmappedSearchLower || unmappedCategory !== 'all'
                    ? `Знайдено: ${filteredUnmapped.length} з завантажених ${unmappedRows.length}`
                    : `Показано: ${((safeUnmappedPage - 1) * PER_PAGE) + 1}–${Math.min(safeUnmappedPage * PER_PAGE, filteredUnmapped.length)} з ${filteredUnmapped.length}`
                  }
                </span>
                <Pagination page={safeUnmappedPage} totalPages={unmappedTotalPages} onPage={setUnmappedPage} />
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Mappings panel ──────────────────────────────────────────────────── */}
      {activeView === 'mappings' && (
        <div className="size-panel">
          <div className="size-section-toolbar">
            <input
              className="size-search-input"
              placeholder="Пошук розміру..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <div className="mini-tabs">
              {CATEGORY_TABS.map((cat) => (
                <button
                  key={cat.id}
                  className={`tab ${mappingCategory === cat.id ? 'active' : ''}`}
                  onClick={() => setMappingCategory(cat.id)}
                >
                  {cat.label}
                  {searchedMappings.length > 0 && (
                    <span className="size-tab-count">{mappingCounts[cat.id]}</span>
                  )}
                </button>
              ))}
            </div>
            <div className="actions" style={{ flexWrap: 'nowrap' }}>
              <button className="btn" onClick={refreshSizeMappings}>Оновити</button>
              <button className="btn" disabled={isReadOnly} onClick={() => fileInputRef.current?.click()}>Імпорт CSV</button>
              <button className="btn primary" disabled={isReadOnly} onClick={() => openCreate()}>+ Новий</button>
            </div>
          </div>

          {/* hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv"
            style={{ display: 'none' }}
            disabled={isReadOnly}
            onChange={handleFileChange}
          />

          {csvError && (
            <div className="status-line error">{csvError}</div>
          )}

          {filteredMappings.length === 0 ? (
            <div className="size-empty">
              {mappingRows.length === 0 ? 'Маппінгів ще немає' : 'Нічого не знайдено'}
            </div>
          ) : (
            <>
              <div className="size-table-wrap">
                <table className="size-table">
                  <thead>
                    <tr>
                      <th>Оригінал</th>
                      <th>Нормалізований</th>
                      <th>Нотатки</th>
                      <th>Стан</th>
                      <th style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>Дії</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagedMappings.map((row) => (
                      <tr key={row.id} style={row.is_active ? {} : { opacity: 0.5 }}>
                        <td><code className="size-code">{row.size_from}</code></td>
                        <td>
                          {row.size_to === '' || row.size_to == null
                            ? <span className="muted" style={{ fontStyle: 'italic', fontSize: '0.85em' }}>пустий рядок</span>
                            : <strong>{row.size_to}</strong>
                          }
                        </td>
                        <td className="muted">{row.notes || '—'}</td>
                        <td>
                          <Tag tone={row.is_active ? 'ok' : 'warn'}>
                            {row.is_active ? 'Активний' : 'Вимкнений'}
                          </Tag>
                        </td>
                        <td>
                          <div className="actions" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                            <button className="btn btn-sm" disabled={isReadOnly} onClick={() => openEdit(row)}>Ред.</button>
                            <button className="btn btn-sm danger" disabled={isReadOnly} onClick={() => setDeleteId(row.id)}>×</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className={`size-status-bar${isError(sizeMappingStatus) ? ' error' : ''}`}>
                <span>
                  Показано: {((safeMappingPage - 1) * PER_PAGE) + 1}–{Math.min(safeMappingPage * PER_PAGE, filteredMappings.length)} з {filteredMappings.length}
                  {sizeMappingStatus ? ` · ${sizeMappingStatus}` : ''}
                </span>
                <Pagination page={safeMappingPage} totalPages={mappingTotalPages} onPage={setMappingPage} />
              </div>
            </>
          )}
        </div>
      )}

      {/* ── CSV preview / confirm modal ──────────────────────────────────────── */}
      {csvPreview !== null ? (
        <div className="modal-backdrop" onClick={() => !csvImporting && setCsvPreview(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520 }}>
            <div className="section-head">
              <h3>Імпорт з CSV</h3>
              {!csvImporting && (
                <button className="btn" onClick={() => setCsvPreview(null)}>Закрити</button>
              )}
            </div>

            <div style={{ marginBottom: 12 }}>
              <p style={{ marginBottom: 6 }}>
                У файлі: <strong>{csvPreview.all.length}</strong> записів
              </p>
              {csvPreview.truncated ? (
                <p className="muted" style={{ fontSize: '0.85em', marginBottom: 6 }}>
                  Буде надіслано всі <strong>{csvPreview.all.length}</strong> записів на сервер — існуючі маппінги будуть <strong>перезаписані</strong>.
                </p>
              ) : (
                <>
                  <p style={{ marginBottom: 6 }}>
                    Знайдено в наших незнайомих розмірах:{' '}
                    <strong style={{ color: csvPreview.matched.length > 0 ? 'var(--color-ok)' : undefined }}>
                      {csvPreview.matched.length}
                    </strong>
                  </p>
                  <p className="muted" style={{ fontSize: '0.85em' }}>
                    Решта {csvPreview.all.length - csvPreview.matched.length} записів не мають відповідності в поточних даних і будуть пропущені.
                    Якщо розмір вже має маппінг — він буде <strong>перезаписаний</strong>.
                  </p>
                </>
              )}
            </div>

            {csvPreview.toImport.length > 0 && (
              <div className="size-table-wrap" style={{ maxHeight: 220, overflowY: 'auto', marginBottom: 12 }}>
                <table className="size-table">
                  <thead>
                    <tr>
                      <th>Оригінал</th>
                      <th>Нормалізований</th>
                    </tr>
                  </thead>
                  <tbody>
                    {csvPreview.toImport.slice(0, 30).map((r) => (
                      <tr key={r.size_from}>
                        <td><code className="size-code">{r.size_from}</code></td>
                        <td>
                          {r.size_to === '' || r.size_to == null
                            ? <span className="muted" style={{ fontStyle: 'italic', fontSize: '0.85em' }}>пустий рядок</span>
                            : <strong>{r.size_to}</strong>
                          }
                        </td>
                      </tr>
                    ))}
                    {csvPreview.toImport.length > 30 && (
                      <tr>
                        <td colSpan={2} className="muted" style={{ textAlign: 'center' }}>
                          …та ще {csvPreview.toImport.length - 30}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}

            {csvPreview.toImport.length === 0 ? (
              <p className="muted">Нічого імпортувати — жоден розмір з файлу не знайдено в базі.</p>
            ) : (
              <div className="actions" style={{ marginTop: 8 }}>
                <button
                  className="btn primary"
                  disabled={isReadOnly || csvImporting}
                  onClick={handleCsvConfirm}
                >
                  {csvImporting ? 'Імпортую...' : `Імпортувати ${csvPreview.toImport.length} маппінгів`}
                </button>
                {!csvImporting && (
                  <button className="btn" onClick={() => setCsvPreview(null)}>Скасувати</button>
                )}
              </div>
            )}
          </div>
        </div>
      ) : null}

      {/* ── Create / Edit modal ─────────────────────────────────────────────── */}
      {draft !== null ? (
        <div className="modal-backdrop" onClick={closeDraft}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="section-head">
              <h3>{draftMode === 'edit' ? 'Редагування маппінгу' : 'Новий маппінг'}</h3>
              <button className="btn" onClick={closeDraft}>Закрити</button>
            </div>

            <div className="form-row">
              <div style={{ flex: 1 }}>
                <label>Оригінал (від постачальника)</label>
                <input
                  value={draft.size_from}
                  onChange={(e) => setDraft((p) => ({ ...p, size_from: e.target.value }))}
                  placeholder="xl (158-170 cm)"
                />
                {draftErrors.size_from && (
                  <div className="field-error">{draftErrors.size_from}</div>
                )}
              </div>
              <div style={{ flex: 1 }}>
                <label>Нормалізований розмір</label>
                <input
                  value={draft.size_to}
                  onChange={(e) => setDraft((p) => ({ ...p, size_to: e.target.value, emptyTo: false }))}
                  placeholder="XL"
                  disabled={draft.emptyTo}
                  style={draft.emptyTo ? { opacity: 0.4 } : undefined}
                />
                <label className="inline-checkbox" style={{ marginTop: 6 }}>
                  <input
                    type="checkbox"
                    checked={!!draft.emptyTo}
                    onChange={(e) => setDraft((p) => ({ ...p, emptyTo: e.target.checked, size_to: '' }))}
                  />
                  Пустий рядок <span className="muted" style={{ fontSize: '0.85em' }}>(видалити розмір з артикулу)</span>
                </label>
                {draftErrors.size_to && (
                  <div className="field-error">{draftErrors.size_to}</div>
                )}
              </div>
            </div>

            <div>
              <label>Нотатки (необов'язково)</label>
              <input
                value={draft.notes}
                onChange={(e) => setDraft((p) => ({ ...p, notes: e.target.value }))}
                placeholder="наприклад: великий розмір для кап'юшонів"
              />
            </div>

            {draftMode === 'edit' && (
              <div style={{ marginTop: 8 }}>
                <label className="inline-checkbox">
                  <input
                    type="checkbox"
                    checked={draft.is_active}
                    onChange={(e) => setDraft((p) => ({ ...p, is_active: e.target.checked }))}
                  />
                  Активний
                </label>
              </div>
            )}

            <div className="actions" style={{ marginTop: 14 }}>
              <button className="btn primary" disabled={isReadOnly} onClick={handleSave}>
                {draftMode === 'edit' ? 'Зберегти' : 'Створити'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* ── Delete confirmation ─────────────────────────────────────────────── */}
      {deleteId !== null ? (
        <div className="modal-backdrop confirm-modal-backdrop" onClick={() => setDeleteId(null)}>
          <div className="modal-card confirm-modal-card" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginBottom: 6 }}>Видалити маппінг?</h3>
            <p className="muted" style={{ marginBottom: 16 }}>
              Розмір більше не нормалізуватиметься і перейде в автоматичний UPPER.
            </p>
            <div className="actions">
              <button className="btn danger" autoFocus disabled={isReadOnly} onClick={handleDelete}>
                Так, видалити
              </button>
              <button className="btn" onClick={() => setDeleteId(null)}>Скасувати</button>
            </div>
          </div>
        </div>
      ) : null}

    </div>
  );
}
