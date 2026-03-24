import React from 'react';
import { Section } from '../components/ui';

const VIEW_CONFIG = {
  merged: {
    title: 'Merged preview',
    loadLabel: 'Завантажити merged',
    exportHref: '/admin/api/merged-export',
    columns: [
      { key: 'article', label: 'Article' },
      { key: 'size', label: 'Size' },
      { key: 'quantity', label: 'К-сть' },
      { key: 'price', label: 'Ціна' },
      { key: 'supplier_name', label: 'Постачальник' },
      { key: 'extra', label: 'Назва' },
      { key: 'comment', label: 'Коментар' }
    ],
    supportsSupplierFilter: false,
    supportsMissingOnly: false,
    supportsMergedSort: true,
    supportsFinalSort: false
  },
  final: {
    title: 'Final preview',
    loadLabel: 'Завантажити final',
    exportHref: '/admin/api/final-export',
    columns: [
      { key: 'article', label: 'Article' },
      { key: 'size', label: 'Size' },
      { key: 'quantity', label: 'К-сть' },
      { key: 'price_base', label: 'Базова ціна' },
      { key: 'price_final', label: 'Фінальна ціна' },
      { key: 'supplier_name', label: 'Постачальник' },
      { key: 'comment', label: 'Коментар' }
    ],
    supportsSupplierFilter: true,
    supportsMissingOnly: false,
    supportsMergedSort: false,
    supportsFinalSort: true
  },
  compare: {
    title: 'Compare preview (CS-Cart)',
    loadLabel: 'Завантажити compare',
    exportHref: '/admin/api/compare-export?store=cscart',
    columns: [
      { key: 'article', label: 'Article' },
      { key: 'size', label: 'Size' },
      { key: 'price_final', label: 'Фінальна ціна' },
      { key: 'comment', label: 'Коментар' },
      { key: 'sku_article', label: 'SKU article' },
      { key: 'store_sku', label: 'Store SKU' },
      { key: 'store_visibility', label: 'Видимість' }
    ],
    supportsSupplierFilter: true,
    supportsMissingOnly: true,
    supportsMergedSort: false,
    supportsFinalSort: false
  },
  store_now: {
    title: 'Зараз в магазині (store mirror)',
    loadLabel: 'Завантажити дзеркало магазину',
    exportHref: null,
    columns: [
      { key: 'article', label: 'Article' },
      { key: 'supplier', label: 'Постачальник в магазині' },
      { key: 'parent_article', label: 'Parent article' },
      { key: 'price', label: 'Ціна в магазині' },
      { key: 'visibility', label: 'Видимість' },
      { key: 'seen_at', label: 'Seen at' }
    ],
    supportsSupplierFilter: false,
    supportsMissingOnly: false,
    supportsMergedSort: false,
    supportsFinalSort: false
  },
  store_preview: {
    title: 'Відправка в магазин (preview)',
    loadLabel: 'Завантажити preview відправки',
    exportHref: null,
    columns: [
      { key: 'article', label: 'Article' },
      { key: 'size', label: 'Size' },
      { key: 'quantity', label: 'К-сть' },
      { key: 'price_base', label: 'Базова ціна' },
      { key: 'price_final', label: 'Фінальна ціна' },
      { key: 'supplier_name', label: 'Постачальник' },
      { key: 'parent_article', label: 'Parent article' },
      { key: 'comment', label: 'Коментар' }
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
  storePreviewState
}) {
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
  const hasAdvancedFilters =
    currentConfig.supportsMergedSort ||
    currentConfig.supportsFinalSort ||
    currentConfig.supportsMissingOnly;
  const isStorePreview = activeDataView === 'store_preview';
  const storePreviewMode = dataFilters.storePreviewMode === 'delta' ? 'delta' : 'candidates';
  const storePreviewColumns =
    storePreviewMode === 'delta'
      ? [
          { key: 'article', label: 'Article' },
          { key: 'supplier_name', label: 'Постачальник' },
          { key: 'parent_article', label: 'Parent article' },
          { key: 'price_final', label: 'Ціна для оновлення' },
          { key: 'visibility', label: 'Видимість' }
        ]
      : currentConfig.columns;
  const currentColumns = isStorePreview ? storePreviewColumns : currentConfig.columns;

  return (
    <div className="data-grid">
      <Section
        title="Перегляд даних"
        subtitle="Merged / Final / Compare / Зараз в магазині / Відправка в магазин"
      >
        <div className="mini-tabs">
          <button
            className={`tab ${activeDataView === 'merged' ? 'active' : ''}`}
            onClick={() => setActiveDataView('merged')}
          >
            merged
          </button>
          <button
            className={`tab ${activeDataView === 'final' ? 'active' : ''}`}
            onClick={() => setActiveDataView('final')}
          >
            final
          </button>
          <button
            className={`tab ${activeDataView === 'compare' ? 'active' : ''}`}
            onClick={() => setActiveDataView('compare')}
          >
            compare
          </button>
          <button
            className={`tab ${activeDataView === 'store_now' ? 'active' : ''}`}
            onClick={() => setActiveDataView('store_now')}
          >
            зараз в магазині
          </button>
          <button
            className={`tab ${activeDataView === 'store_preview' ? 'active' : ''}`}
            onClick={() => setActiveDataView('store_preview')}
          >
            відправка в магазин
          </button>
        </div>

        <div className="form-row" style={{ marginTop: 10 }}>
          <div>
            <label>Пошук (article / SKU)</label>
            <input
              value={dataFilters.search}
              onChange={(event) => setDataFilters((prev) => ({ ...prev, search: event.target.value }))}
            />
          </div>
          {currentConfig.supportsSupplierFilter ? (
            <div>
              <label>supplierId</label>
              <input
                value={dataFilters.supplierId}
                onChange={(event) => setDataFilters((prev) => ({ ...prev, supplierId: event.target.value }))}
              />
            </div>
          ) : null}
          {isStorePreview ? (
            <div>
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
                <option value="candidates">Усі кандидати</option>
                <option value="delta">Лише оновиться (дельта)</option>
              </select>
            </div>
          ) : null}
          <div>
            <label>Розмір сторінки (limit)</label>
            <input
              value={dataFilters.limit}
              onChange={(event) => setDataFilters((prev) => ({ ...prev, limit: event.target.value }))}
            />
          </div>
          <div>
            <label>offset</label>
            <input
              value={dataFilters.offset}
              onChange={(event) => setDataFilters((prev) => ({ ...prev, offset: event.target.value }))}
            />
          </div>
        </div>

        {hasAdvancedFilters ? (
          <details className="details-block">
            <summary>Розширені фільтри</summary>
            <div className="form-row" style={{ marginTop: 10 }}>
              {currentConfig.supportsMergedSort ? (
                <div>
                  <label>Merged sort</label>
                  <select
                    value={dataFilters.mergedSort}
                    onChange={(event) => setDataFilters((prev) => ({ ...prev, mergedSort: event.target.value }))}
                  >
                    <option value="article_asc">article asc</option>
                    <option value="article_desc">article desc</option>
                    <option value="created_desc">created desc</option>
                  </select>
                </div>
              ) : null}
              {currentConfig.supportsFinalSort ? (
                <div>
                  <label>Final sort</label>
                  <select
                    value={dataFilters.finalSort}
                    onChange={(event) => setDataFilters((prev) => ({ ...prev, finalSort: event.target.value }))}
                  >
                    <option value="article_asc">article asc</option>
                    <option value="article_desc">article desc</option>
                    <option value="created_desc">created desc</option>
                  </select>
                </div>
              ) : null}
              {currentConfig.supportsMissingOnly ? (
                <div>
                  <label>
                    <input
                      type="checkbox"
                      checked={dataFilters.missingOnly}
                      onChange={(event) =>
                        setDataFilters((prev) => ({ ...prev, missingOnly: event.target.checked }))
                      }
                      style={{ width: 'auto', marginRight: 8 }}
                    />
                    compare: лише missing
                  </label>
                </div>
              ) : null}
            </div>
          </details>
        ) : null}

        <div className="actions" style={{ marginTop: 10 }}>
          <button className="btn primary" onClick={runLoadActive}>
            {currentConfig.loadLabel}
          </button>
          <button className="btn" onClick={() => shiftDataOffset(-1)}>Попередня сторінка</button>
          <button className="btn" onClick={() => shiftDataOffset(1)}>Наступна сторінка</button>
          {currentConfig.exportHref ? (
            <a className="btn" href={currentConfig.exportHref}>Export CSV</a>
          ) : null}
          <span className="chip">total: {currentState.total}</span>
          <span className="chip">offset: {dataFilters.offset}</span>
          {isStorePreview ? (
            <span className="chip">
              mode: {storePreviewMode === 'delta' ? 'лише оновиться' : 'усі кандидати'}
            </span>
          ) : null}
          {isStorePreview && Number.isFinite(Number(currentState.previewTotal)) ? (
            <span className="chip">кандидати: {Number(currentState.previewTotal || 0)}</span>
          ) : null}
          {isStorePreview && currentState.batchTotal !== null ? (
            <span className="chip">оновиться: {Number(currentState.batchTotal || 0)}</span>
          ) : null}
          {currentState.jobId ? <span className="chip">jobId: {currentState.jobId}</span> : null}
        </div>
      </Section>

      <Section title={currentConfig.title}>
        <div className="status-line">{currentState.status}</div>
        {currentState.rows.length === 0 ? (
          <div className="empty-preview">Немає даних для поточного фільтра</div>
        ) : (
          <div className="preview-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  {currentColumns.map((column) => (
                    <th key={column.key}>{column.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {currentState.rows.map((row, rowIndex) => (
                  <tr key={`row_${rowIndex}`}>
                    {currentColumns.map((column) => (
                      <td key={`${rowIndex}_${column.key}`}>{String(row[column.key] ?? '-')}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}
