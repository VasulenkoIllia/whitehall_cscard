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
    ]
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
    ]
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
    ]
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
  shiftDataOffset,
  mergedState,
  finalState,
  compareState
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
    void loadCompare();
  };

  const currentConfig = VIEW_CONFIG[activeDataView];
  const currentState =
    activeDataView === 'merged' ? mergedState : activeDataView === 'final' ? finalState : compareState;

  return (
    <div className="data-grid">
      <Section title="Перегляд даних" subtitle="Merged / Final / Compare для перевірки перед імпортом">
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
        </div>

        <div className="form-row" style={{ marginTop: 10 }}>
          <div>
            <label>Пошук (article / SKU)</label>
            <input
              value={dataFilters.search}
              onChange={(event) => setDataFilters((prev) => ({ ...prev, search: event.target.value }))}
            />
          </div>
          <div>
            <label>supplierId (для final/compare)</label>
            <input
              value={dataFilters.supplierId}
              onChange={(event) => setDataFilters((prev) => ({ ...prev, supplierId: event.target.value }))}
            />
          </div>
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

        <details className="details-block">
          <summary>Розширені фільтри</summary>
          <div className="form-row" style={{ marginTop: 10 }}>
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
          </div>
        </details>

        <div className="actions" style={{ marginTop: 10 }}>
          <button className="btn primary" onClick={runLoadActive}>
            {currentConfig.loadLabel}
          </button>
          <button className="btn" onClick={() => shiftDataOffset(-1)}>Попередня сторінка</button>
          <button className="btn" onClick={() => shiftDataOffset(1)}>Наступна сторінка</button>
          <a className="btn" href={currentConfig.exportHref}>Export CSV</a>
          <span className="chip">total: {currentState.total}</span>
          <span className="chip">offset: {dataFilters.offset}</span>
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
                  {currentConfig.columns.map((column) => (
                    <th key={column.key}>{column.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {currentState.rows.map((row, rowIndex) => (
                  <tr key={`row_${rowIndex}`}>
                    {currentConfig.columns.map((column) => (
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
