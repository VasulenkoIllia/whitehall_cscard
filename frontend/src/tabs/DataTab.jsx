import React from 'react';
import { Section } from '../components/ui';
import { SizeMappingsTab } from './SizeMappingsTab';

function formatDateTimeCell(value) {
  if (!value) {
    return '-';
  }
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return date.toLocaleString('uk-UA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function formatPriceCell(value) {
  if (value === null || typeof value === 'undefined' || value === '') {
    return '-';
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return String(value);
  }
  return numeric.toLocaleString('uk-UA');
}

const VIEW_CONFIG = {
  merged: {
    title: 'Зведені дані (merged)',
    tabLabel: 'Зведені',
    loadLabel: 'Завантажити зведені',
    exportHref: '/admin/api/merged-export',
    columns: [
      { key: 'article', label: 'Артикул (raw)' },
      { key: 'size', label: 'Розмір' },
      { key: 'supplier_name', label: 'Постачальник' },
      { key: 'supplier_sku_prefix', label: 'SKU префікс' },
      { key: 'quantity', label: 'К-сть' },
      { key: 'price', label: 'Ціна' },
      { key: 'extra', label: 'Назва' },
      { key: 'comment', label: 'Коментар' },
      { key: 'created_at', label: 'Створено' }
    ],
    supportsSupplierFilter: false,
    supportsMissingOnly: false,
    supportsMergedSort: true,
    supportsFinalSort: false
  },
  final: {
    title: 'Фінальні товари (final)',
    tabLabel: 'Фінальні',
    loadLabel: 'Завантажити фінальні',
    exportHref: '/admin/api/final-export',
    columns: [
      { key: 'article', label: 'SKU (ефективний)' },
      { key: 'size', label: 'Розмір' },
      { key: 'supplier_name', label: 'Постачальник' },
      { key: 'supplier_sku_prefix', label: 'SKU префікс' },
      { key: 'quantity', label: 'К-сть' },
      { key: 'price_base', label: 'Базова ціна' },
      { key: 'price_final', label: 'Фінальна ціна' },
      { key: 'extra', label: 'Назва' },
      { key: 'comment', label: 'Коментар' },
      { key: 'created_at', label: 'Створено' }
    ],
    supportsSupplierFilter: true,
    supportsMissingOnly: false,
    supportsMergedSort: false,
    supportsFinalSort: true
  },
  compare: {
    title: 'Порівняння з магазином (CS-Cart)',
    tabLabel: 'Порівняння',
    loadLabel: 'Завантажити порівняння',
    exportHref: '/admin/api/compare-export?store=cscart',
    columns: [
      { key: 'article', label: 'SKU (ефективний)' },
      { key: 'size', label: 'Розмір' },
      { key: 'supplier_name', label: 'Постачальник' },
      { key: 'supplier_sku_prefix', label: 'SKU префікс' },
      { key: 'quantity', label: 'К-сть' },
      { key: 'price_base', label: 'Базова ціна' },
      { key: 'price_final', label: 'Фінальна ціна' },
      { key: 'sku_article', label: 'SKU з розміром' },
      { key: 'store_article', label: 'Артикул в магазині' },
      { key: 'store_sku', label: 'SKU магазину' },
      { key: 'store_price', label: 'Ціна в магазині' },
      { key: 'store_visibility', label: 'Видимість в магазині' },
      { key: 'store_supplier', label: 'Постачальник в магазині' },
      { key: 'comment', label: 'Коментар' },
      { key: 'extra', label: 'Назва' }
    ],
    supportsSupplierFilter: true,
    supportsMissingOnly: true,
    supportsMergedSort: false,
    supportsFinalSort: false
  },
  store_now: {
    title: 'Зараз в магазині (дзеркало)',
    tabLabel: 'В магазині',
    loadLabel: 'Завантажити дзеркало магазину',
    exportHref: null,
    columns: [
      { key: 'article', label: 'Артикул' },
      { key: 'supplier', label: 'Постачальник' },
      { key: 'parent_article', label: 'Батьківський артикул' },
      { key: 'price', label: 'Ціна' },
      { key: 'amount', label: 'К-сть' },
      { key: 'visibility', label: 'Видимість' },
      { key: 'seen_at', label: 'Останній snapshot' },
      { key: 'synced_at', label: 'Останнє sync-оновлення' }
    ],
    supportsSupplierFilter: false,
    supportsMissingOnly: false,
    supportsMergedSort: false,
    supportsFinalSort: false
  },
  store_preview: {
    title: 'Відправка в магазин (preview)',
    tabLabel: 'До відправки',
    loadLabel: 'Завантажити preview відправки',
    exportHref: null,
    columns: [
      { key: 'article', label: 'SKU (ефективний)' },
      { key: 'size', label: 'Розмір' },
      { key: 'supplier_name', label: 'Постачальник' },
      { key: 'supplier_sku_prefix', label: 'SKU префікс' },
      { key: 'quantity', label: 'К-сть' },
      { key: 'price_base', label: 'Базова ціна' },
      { key: 'price_final', label: 'Фінальна ціна' },
      { key: 'sku_article', label: 'SKU з розміром' },
      { key: 'parent_article', label: 'Батьківський артикул' },
      { key: 'visibility', label: 'Видимість' },
      { key: 'extra', label: 'Назва' },
      { key: 'comment', label: 'Коментар' },
      { key: 'created_at', label: 'Створено' }
    ],
    supportsSupplierFilter: true,
    supportsMissingOnly: false,
    supportsMergedSort: false,
    supportsFinalSort: false
  }
};

export function DataTab({
  dataFilters,
  setDataFilters,
  activeDataView,
  setActiveDataView,
  loadMerged,
  loadFinal,
  loadCompare,
  loadStoreMirror,
  loadStorePreview,
  shiftDataOffset,
  mergedState,
  finalState,
  compareState,
  storeMirrorState,
  storePreviewState,
  suppliers,
  isReadOnly,
  // size mappings
  sizeMappings,
  unmappedSizes,
  sizeMappingStatus,
  refreshSizeMappings,
  refreshUnmappedSizes,
  createSizeMapping,
  updateSizeMapping,
  deleteSizeMapping,
  bulkImportSizeMappings
}) {
  const supplierOptions = Array.isArray(suppliers) ? suppliers : [];
  const runLoadActive = () => {
    if (activeDataView === 'merged') {
      void loadMerged();
      return;
    }
    if (activeDataView === 'final') {
      void loadFinal();
      return;
    }
    if (activeDataView === 'compare') {
      void loadCompare();
      return;
    }
    if (activeDataView === 'store_now') {
      void loadStoreMirror();
      return;
    }
    void loadStorePreview();
  };

  const currentConfig = VIEW_CONFIG[activeDataView] || VIEW_CONFIG.merged;
  const currentState = (() => {
    if (activeDataView === 'merged') {
      return mergedState;
    }
    if (activeDataView === 'final') {
      return finalState;
    }
    if (activeDataView === 'compare') {
      return compareState;
    }
    if (activeDataView === 'store_now') {
      return storeMirrorState;
    }
    return storePreviewState;
  })();
  const isStorePreview = activeDataView === 'store_preview';
  const storePreviewMode = dataFilters.storePreviewMode === 'delta' ? 'delta' : 'candidates';
  const storePreviewColumns =
    storePreviewMode === 'delta'
      ? [
          { key: 'article', label: 'SKU (до імпорту)' },
          { key: 'size', label: 'Розмір' },
          { key: 'supplier_name', label: 'Постачальник' },
          { key: 'supplier_sku_prefix', label: 'SKU префікс' },
          { key: 'parent_article', label: 'Батьківський артикул' },
          { key: 'price_final', label: 'Ціна для оновлення' },
          { key: 'store_amount', label: 'К-сть в магазині' },
          { key: 'quantity', label: 'К-сть (нова)' },
          { key: 'visibility', label: 'Статус' }
        ]
      : currentConfig.columns;
  const currentColumns = isStorePreview ? storePreviewColumns : currentConfig.columns;

  // ── Size mappings view ─────────────────────────────────────────────────────
  if (activeDataView === 'sizes') {
    return (
      <div className="data-grid">
        <div className="mini-tabs" style={{ marginBottom: 12 }}>
          {Object.entries(VIEW_CONFIG).map(([viewId, config]) => (
            <button
              key={viewId}
              className={`tab ${activeDataView === viewId ? 'active' : ''}`}
              onClick={() => setActiveDataView(viewId)}
            >
              {config.tabLabel}
            </button>
          ))}
          <button
            className="tab active"
            onClick={() => setActiveDataView('sizes')}
          >
            Розміри
            {unmappedSizes?.total > 0 && (
              <span className="tab-badge">{unmappedSizes.total}</span>
            )}
          </button>
        </div>
        <SizeMappingsTab
          sizeMappings={sizeMappings}
          unmappedSizes={unmappedSizes}
          sizeMappingStatus={sizeMappingStatus}
          refreshSizeMappings={refreshSizeMappings}
          refreshUnmappedSizes={refreshUnmappedSizes}
          createSizeMapping={createSizeMapping}
          updateSizeMapping={updateSizeMapping}
          deleteSizeMapping={deleteSizeMapping}
          bulkImportSizeMappings={bulkImportSizeMappings}
          isReadOnly={isReadOnly}
        />
      </div>
    );
  }

  return (
    <div className="data-grid">
      <Section
        title="Перегляд даних"
        subtitle="Merged / Final / Compare / Зараз в магазині / Відправка в магазин"
      >
        <div className="mini-tabs">
          {Object.entries(VIEW_CONFIG).map(([viewId, config]) => (
            <button
              key={viewId}
              className={`tab ${activeDataView === viewId ? 'active' : ''}`}
              onClick={() => setActiveDataView(viewId)}
            >
              {config.tabLabel}
            </button>
          ))}
          <button
            className={`tab ${activeDataView === 'sizes' ? 'active' : ''}`}
            onClick={() => setActiveDataView('sizes')}
          >
            Розміри
            {unmappedSizes?.total > 0 && (
              <span className="tab-badge">{unmappedSizes.total}</span>
            )}
          </button>
        </div>

        <div className="form-row" style={{ marginTop: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 180px', minWidth: 140 }}>
            <label>Пошук</label>
            <input
              value={dataFilters.search}
              onChange={(event) => setDataFilters((prev) => ({ ...prev, search: event.target.value, offset: '0' }))}
              placeholder="артикул / SKU"
            />
          </div>
          {currentConfig.supportsSupplierFilter ? (
            <div style={{ flex: '1 1 160px', minWidth: 130 }}>
              <label>Постачальник</label>
              <select
                value={dataFilters.supplierId}
                onChange={(event) => setDataFilters((prev) => ({ ...prev, supplierId: event.target.value, offset: '0' }))}
              >
                <option value="">Всі</option>
                {supplierOptions.map((s) => (
                  <option key={s.id} value={String(s.id)}>
                    {s.name}{s.sku_prefix ? ` (SKU: ${s.sku_prefix})` : ''}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          {isStorePreview ? (
            <div style={{ flex: '1 1 180px', minWidth: 150 }}>
              <label>Режим</label>
              <select
                value={storePreviewMode}
                onChange={(event) =>
                  setDataFilters((prev) => ({
                    ...prev,
                    storePreviewMode: event.target.value === 'delta' ? 'delta' : 'candidates',
                    offset: '0'
                  }))
                }
              >
                <option value="delta">Реальне оновлення (дельта)</option>
                <option value="candidates">Всі кандидати (до фільтрів)</option>
              </select>
            </div>
          ) : null}
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexShrink: 0, flexWrap: 'wrap' }}>
            {currentConfig.supportsMergedSort ? (
              <div>
                <label>Сортування</label>
                <select
                  style={{ width: 'auto' }}
                  value={dataFilters.mergedSort}
                  onChange={(event) => setDataFilters((prev) => ({ ...prev, mergedSort: event.target.value }))}
                >
                  <option value="article_asc">Артикул А→Я</option>
                  <option value="article_desc">Артикул Я→А</option>
                  <option value="created_desc">Нові спочатку</option>
                </select>
              </div>
            ) : null}
            {currentConfig.supportsFinalSort ? (
              <div>
                <label>Сортування</label>
                <select
                  style={{ width: 'auto' }}
                  value={dataFilters.finalSort}
                  onChange={(event) => setDataFilters((prev) => ({ ...prev, finalSort: event.target.value }))}
                >
                  <option value="article_asc">Артикул А→Я</option>
                  <option value="article_desc">Артикул Я→А</option>
                  <option value="created_desc">Нові спочатку</option>
                </select>
              </div>
            ) : null}
            {currentConfig.supportsMissingOnly ? (
              <div style={{ paddingBottom: 4 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                  <input
                    type="checkbox"
                    checked={dataFilters.missingOnly}
                    onChange={(event) => setDataFilters((prev) => ({ ...prev, missingOnly: event.target.checked }))}
                    style={{ width: 'auto', margin: 0 }}
                  />
                  Лише missing
                </label>
              </div>
            ) : null}
            <div>
              <label>На сторінці</label>
              <select
                style={{ width: 'auto' }}
                value={dataFilters.limit}
                onChange={(event) => setDataFilters((prev) => ({ ...prev, limit: event.target.value, offset: '0' }))}
              >
                <option value="50">50</option>
                <option value="100">100</option>
                <option value="200">200</option>
                <option value="500">500</option>
              </select>
            </div>
          </div>
        </div>

        <div className="actions" style={{ marginTop: 10 }}>
          {(() => {
            const limit = Math.max(1, Number(dataFilters.limit || 50));
            const offset = Math.max(0, Number(dataFilters.offset || 0));
            const total = currentState.total;
            const page = Math.floor(offset / limit) + 1;
            const totalPages = total > 0 ? Math.ceil(total / limit) : 1;
            const isFirst = offset === 0;
            const isLast = total > 0 ? page >= totalPages : false;

            const exportHref = (() => {
              if (!currentConfig.exportHref) return null;
              const params = new URLSearchParams();
              if (dataFilters.search) params.set('search', dataFilters.search);
              if (currentConfig.supportsSupplierFilter && dataFilters.supplierId) params.set('supplierId', dataFilters.supplierId);
              if (currentConfig.supportsMissingOnly && dataFilters.missingOnly) params.set('missingOnly', '1');
              if (currentConfig.supportsMergedSort && dataFilters.mergedSort) params.set('sort', dataFilters.mergedSort);
              if (currentConfig.supportsFinalSort && dataFilters.finalSort) params.set('sort', dataFilters.finalSort);
              // job IDs are positive integers (>0), so truthiness check is safe
              if (currentState.jobId) params.set('jobId', String(currentState.jobId));
              const qs = params.toString();
              if (!qs) return currentConfig.exportHref;
              const sep = currentConfig.exportHref.includes('?') ? '&' : '?';
              return `${currentConfig.exportHref}${sep}${qs}`;
            })();

            return (
              <>
                <button className="btn primary" onClick={runLoadActive}>
                  {currentConfig.loadLabel}
                </button>
                <button className="btn" onClick={() => shiftDataOffset(-1)} disabled={isFirst}>← Назад</button>
                <button className="btn" onClick={() => shiftDataOffset(1)} disabled={isLast}>Вперед →</button>
                {exportHref ? (
                  <a className="btn" href={exportHref} download>⬇ Скачати CSV</a>
                ) : null}
                <span className="chip">сторінка {page} з {totalPages}</span>
                <span className="chip">всього: {total}</span>
              </>
            );
          })()}
          {isStorePreview && storePreviewMode === 'delta' && currentState.batchTotal !== null ? (
            <>
              <span className="chip">оновлень цін/к-сті: {Number(currentState.previewTotal || 0)}</span>
              <span className="chip">будуть приховані: {Math.max(0, Number(currentState.batchTotal || 0) - Number(currentState.previewTotal || 0))}</span>
              <span className="chip">всього відправиться: {Number(currentState.batchTotal || 0)}</span>
            </>
          ) : null}
          {isStorePreview && storePreviewMode === 'candidates' ? (
            <span className="chip">кандидати: {currentState.total}</span>
          ) : null}
          {currentState.jobId ? <span className="chip">job: {currentState.jobId}</span> : null}
        </div>

        {isStorePreview && storePreviewMode === 'delta' && currentState.batchTotal !== null ? (
          <div className="preflight-warning" style={{ marginTop: 8 }}>
            <strong>Scope:</strong> тільки товари з характеристикою <strong>«Оновлення товару API» = Y</strong> (feature_id=564) в CS-Cart потрапляють у обробку.
            {Number(currentState.batchTotal || 0) > Number(currentState.previewTotal || 0) ? (
              <> {Math.max(0, Number(currentState.batchTotal || 0) - Number(currentState.previewTotal || 0))} з них <strong>будуть приховані</strong> (status=H) — керовані SKU яких більше немає в постачальників. Це штатна поведінка повного імпорту без фільтра постачальника.</>
            ) : null}
          </div>
        ) : null}
      </Section>

      <Section
        title={currentConfig.title}
        subtitle={isStorePreview && storePreviewMode === 'delta' && currentState.batchTotal !== null
          ? `Scope: лише SKU з «Оновлення товару API» = Y · оновлень: ${Number(currentState.previewTotal || 0)} · прихувань: ${Math.max(0, Number(currentState.batchTotal || 0) - Number(currentState.previewTotal || 0))}`
          : undefined}
      >
        <div className="status-line">{currentState.status}</div>
        {currentState.rows.length === 0 ? (
          <div className="empty-preview">Немає даних для поточного фільтра</div>
        ) : (
          <div className="preview-table-wrap" style={isStorePreview ? { maxHeight: 560 } : undefined}>
            <table className="data-table">
              <thead>
                <tr>
                  {currentColumns.map((column) => (
                    <th key={column.key} style={{ position: 'sticky', top: 0, background: '#f4f8ff', zIndex: 1 }}>
                      {column.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {currentState.rows.map((row, rowIndex) => {
                  const isHiding = isStorePreview && row.visibility === false;
                  return (
                    <tr key={`row_${rowIndex}`} style={isHiding ? { opacity: 0.55 } : undefined}>
                      {currentColumns.map((column) => {
                        if (column.key === 'visibility' || column.key === 'store_visibility') {
                          const isPreviewVisibility = column.key === 'visibility' && isStorePreview && storePreviewMode === 'delta';
                          return (
                            <td key={`${rowIndex}_${column.key}`}>
                              {row[column.key] === true ? (
                                <span style={{ color: '#0f8a4b', fontWeight: 600 }}>Активний</span>
                              ) : row[column.key] === false ? (
                                isPreviewVisibility ? (
                                  <span style={{ color: '#b36b00', fontWeight: 600 }}>Буде прихований</span>
                                ) : (
                                  <span style={{ color: '#c22727' }}>Прихований</span>
                                )
                              ) : '-'}
                            </td>
                          );
                        }
                        if (column.key === 'quantity' && isStorePreview && storePreviewMode === 'delta') {
                          const newAmt = row.quantity === null || row.quantity === undefined ? null : Number(row.quantity);
                          const oldAmt = row.store_amount === null || row.store_amount === undefined ? null : Number(row.store_amount);
                          const changed = newAmt !== null && oldAmt !== null && newAmt !== oldAmt;
                          return (
                            <td key={`${rowIndex}_${column.key}`}>
                              {newAmt === null ? (
                                <span style={{ color: 'var(--muted)' }}>-</span>
                              ) : changed ? (
                                <span style={{ color: '#1a6ef5', fontWeight: 600 }}>{newAmt}</span>
                              ) : (
                                <span>{newAmt}</span>
                              )}
                            </td>
                          );
                        }
                        if (column.key === 'store_amount') {
                          const val = row.store_amount === null || row.store_amount === undefined ? null : Number(row.store_amount);
                          return (
                            <td key={`${rowIndex}_${column.key}`} style={{ color: 'var(--muted)' }}>
                              {val === null ? '-' : val}
                            </td>
                          );
                        }
                        if (
                          column.key === 'price' ||
                          column.key === 'price_base' ||
                          column.key === 'price_final' ||
                          column.key === 'store_price'
                        ) {
                          return <td key={`${rowIndex}_${column.key}`}>{formatPriceCell(row[column.key])}</td>;
                        }
                        if (
                          column.key === 'created_at' ||
                          column.key === 'seen_at' ||
                          column.key === 'synced_at'
                        ) {
                          return <td key={`${rowIndex}_${column.key}`}>{formatDateTimeCell(row[column.key])}</td>;
                        }
                        if (column.key === 'supplier_sku_prefix') {
                          const value = String(row[column.key] || '').trim();
                          return <td key={`${rowIndex}_${column.key}`}>{value || '-'}</td>;
                        }
                        return (
                          <td key={`${rowIndex}_${column.key}`}>{String(row[column.key] ?? '-')}</td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}
