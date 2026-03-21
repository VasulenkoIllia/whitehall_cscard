import React from 'react';
import { Section } from '../components/ui';

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
  const renderPreviewTable = (rows, columns, emptyLabel) => {
    if (!rows.length) {
      return <div className="empty-preview">{emptyLabel}</div>;
    }
    return (
      <div className="preview-table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column.key}>{column.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={`row_${rowIndex}`}>
                {columns.map((column) => (
                  <td key={`${rowIndex}_${column.key}`}>
                    {typeof column.render === 'function'
                      ? column.render(row[column.key], row)
                      : String(row[column.key] ?? '-')}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  return (
    <div className="data-grid">
      <Section title="Фільтри" subtitle="Параметри серверної вибірки та сортування">
        <div className="form-row">
          <div>
            <label>limit</label>
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
          <div>
            <label>search</label>
            <input
              value={dataFilters.search}
              onChange={(event) => setDataFilters((prev) => ({ ...prev, search: event.target.value }))}
            />
          </div>
          <div>
            <label>supplierId (final/compare)</label>
            <input
              value={dataFilters.supplierId}
              onChange={(event) => setDataFilters((prev) => ({ ...prev, supplierId: event.target.value }))}
            />
          </div>
        </div>
        <div className="form-row">
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
        </div>
        <div className="actions">
          <label>
            <input
              type="checkbox"
              checked={dataFilters.missingOnly}
              onChange={(event) =>
                setDataFilters((prev) => ({ ...prev, missingOnly: event.target.checked }))
              }
              style={{ width: 'auto', marginRight: 8 }}
            />
            compare missingOnly
          </label>
          <button
            className="btn"
            onClick={() => {
              if (activeDataView === 'merged') {
                void loadMerged();
              } else if (activeDataView === 'final') {
                void loadFinal();
              } else {
                void loadCompare();
              }
            }}
          >
            Load active view
          </button>
          <button
            className="btn"
            onClick={() => {
              void loadMerged();
              void loadFinal();
              void loadCompare();
            }}
          >
            Load all
          </button>
          <button className="btn" onClick={() => shiftDataOffset(-1)}>Prev page</button>
          <button className="btn" onClick={() => shiftDataOffset(1)}>Next page</button>
        </div>
      </Section>

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

      {activeDataView === 'merged' ? (
        <Section title="Merged preview" extra={<button className="btn" onClick={loadMerged}>Load</button>}>
          <div className="actions" style={{ marginBottom: 8 }}>
            <a className="btn" href="/admin/api/merged-export">Export CSV</a>
            <span className="chip">total: {mergedState.total}</span>
            <span className="chip">offset: {dataFilters.offset}</span>
          </div>
          <div className="status-line">{mergedState.status}</div>
          {renderPreviewTable(
            mergedState.rows,
            [
              { key: 'article', label: 'article' },
              { key: 'size', label: 'size' },
              { key: 'quantity', label: 'qty' },
              { key: 'price', label: 'price' },
              { key: 'supplier_name', label: 'supplier' },
              { key: 'extra', label: 'extra' }
            ],
            'Merged preview is empty'
          )}
        </Section>
      ) : null}

      {activeDataView === 'final' ? (
        <Section title="Final preview" extra={<button className="btn" onClick={loadFinal}>Load</button>}>
          <div className="actions" style={{ marginBottom: 8 }}>
            <a className="btn" href="/admin/api/final-export">Export CSV</a>
            <span className="chip">total: {finalState.total}</span>
            <span className="chip">offset: {dataFilters.offset}</span>
          </div>
          <div className="status-line">{finalState.status}</div>
          {renderPreviewTable(
            finalState.rows,
            [
              { key: 'article', label: 'article' },
              { key: 'size', label: 'size' },
              { key: 'quantity', label: 'qty' },
              { key: 'price_base', label: 'base' },
              { key: 'price_final', label: 'final' },
              { key: 'supplier_name', label: 'supplier' }
            ],
            'Final preview is empty'
          )}
        </Section>
      ) : null}

      {activeDataView === 'compare' ? (
        <Section
          title="Compare preview (CS-Cart)"
          extra={<button className="btn" onClick={loadCompare}>Load</button>}
        >
          <div className="actions" style={{ marginBottom: 8 }}>
            <a className="btn" href="/admin/api/compare-export?store=cscart">Export CSV</a>
            <span className="chip">total: {compareState.total}</span>
            <span className="chip">offset: {dataFilters.offset}</span>
          </div>
          <div className="status-line">{compareState.status}</div>
          {renderPreviewTable(
            compareState.rows,
            [
              { key: 'article', label: 'article' },
              { key: 'size', label: 'size' },
              { key: 'price_final', label: 'final' },
              { key: 'sku_article', label: 'sku_article' },
              { key: 'store_sku', label: 'store_sku' },
              { key: 'store_visibility', label: 'visibility' }
            ],
            'Compare preview is empty'
          )}
        </Section>
      ) : null}
    </div>
  );
}
