import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Section, Tag } from '../components/ui';

// Must match the number of <th> columns in the suppliers table header.
const SUPPLIER_TABLE_COL_COUNT = 7;

const CYRILLIC_TO_LATIN = {
  а: 'a', б: 'b', в: 'v', г: 'h', ґ: 'g', д: 'd', е: 'e', є: 'ye',
  ж: 'zh', з: 'z', и: 'y', і: 'i', ї: 'yi', й: 'y', к: 'k', л: 'l',
  м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u',
  ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ь: '',
  ю: 'yu', я: 'ya', ё: 'yo', э: 'e', ы: 'y', ъ: ''
};

const normalizeSupplierSortKey = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .split('')
    .map((char) => CYRILLIC_TO_LATIN[char] ?? char)
    .join('')
    .replace(/\s+/g, ' ');

const compareSupplierNameAsc = (left, right) => {
  const leftKey = normalizeSupplierSortKey(left?.name);
  const rightKey = normalizeSupplierSortKey(right?.name);
  const byKey = leftKey.localeCompare(rightKey, 'en', { sensitivity: 'base', numeric: true });
  if (byKey !== 0) return byKey;
  return String(left?.name || '').localeCompare(String(right?.name || ''), 'uk', { sensitivity: 'base', numeric: true });
};

export function SuppliersTab({
  refreshSuppliers,
  supplierSearch,
  setSupplierSearch,
  supplierSort,
  setSupplierSort,
  selectedSupplierIds,
  setSelectedSupplierIds,
  suppliers,
  setEditingSupplierId,
  setSupplierDraft,
  setSupplierErrors,
  setSelectedSupplierId,
  toSupplierDraft,
  deleteSupplier,
  isReadOnly,
  suppliersStatus,
  editingSupplierId,
  supplierDraft,
  supplierErrors,
  supplierFormStatus,
  setSupplierFormStatus,
  saveSupplier,
  mappingPanel,
  pricingPanel,
  markupRuleSets,
  globalRuleSetId,
  applyRuleSetToSelectedSuppliers,
  supplierBulkPricingStatus
}) {
  const [activeInnerTab, setActiveInnerTab] = useState('suppliers');
  const [isSupplierModalOpen, setSupplierModalOpen] = useState(false);
  const [isMappingModalOpen, setMappingModalOpen] = useState(false);
  const [mappingModalSupplier, setMappingModalSupplier] = useState(null);
  const [isBulkRuleSetModalOpen, setBulkRuleSetModalOpen] = useState(false);
  const [bulkRuleSetId, setBulkRuleSetId] = useState('');
  const [bulkTargetSupplierIds, setBulkTargetSupplierIds] = useState([]);
  const [bulkSupplierSearch, setBulkSupplierSearch] = useState('');
  const selectAllRef = useRef(null);
  const previousSupplierFormStatusRef = useRef('');

  const allSupplierRows = useMemo(() => (Array.isArray(suppliers) ? suppliers : []), [suppliers]);

  const supplierRows = useMemo(() => {
    let rows = [...allSupplierRows];
    const normalizedSearch = String(supplierSearch || '').trim().toLowerCase();
    if (normalizedSearch) {
      rows = rows.filter((s) => String(s.name || '').toLowerCase().includes(normalizedSearch));
    }
    if (supplierSort === 'name_desc') { rows.sort((a, b) => compareSupplierNameAsc(b, a)); return rows; }
    if (supplierSort === 'name_asc') { rows.sort((a, b) => compareSupplierNameAsc(a, b)); return rows; }
    rows.sort((a, b) => Number(a.id || 0) - Number(b.id || 0));
    return rows;
  }, [allSupplierRows, supplierSearch, supplierSort]);

  const selectedCount = selectedSupplierIds.length;
  const selectedSuppliers = useMemo(
    () => allSupplierRows.filter((s) => selectedSupplierIds.includes(String(s.id))),
    [allSupplierRows, selectedSupplierIds]
  );

  const activeTotal = allSupplierRows.filter((s) => Boolean(s.is_active)).length;
  const inactiveTotal = allSupplierRows.length - activeTotal;
  const prefixedTotal = allSupplierRows.filter((s) => String(s.sku_prefix || '').trim().length > 0).length;
  const uniqueRuleSets = new Set(
    allSupplierRows.map((s) => String(s.markup_rule_set_name || '').trim()).filter(Boolean)
  ).size;

  const bulkTargetSuppliers = useMemo(
    () => allSupplierRows.filter((s) => bulkTargetSupplierIds.includes(String(s.id))),
    [allSupplierRows, bulkTargetSupplierIds]
  );

  const filteredBulkSuppliers = useMemo(() => {
    const q = String(bulkSupplierSearch || '').trim().toLowerCase();
    return q ? allSupplierRows.filter((s) => String(s.name || '').toLowerCase().includes(q)) : allSupplierRows;
  }, [allSupplierRows, bulkSupplierSearch]);

  const globalRuleSet = useMemo(
    () => (Array.isArray(markupRuleSets) ? markupRuleSets : []).find(
      (rs) => Number(rs.id) === Number(globalRuleSetId)
    ) || null,
    [markupRuleSets, globalRuleSetId]
  );

  const visibleSupplierIds = useMemo(() => supplierRows.map((s) => String(s.id)), [supplierRows]);
  const allVisibleSelected = visibleSupplierIds.length > 0 && visibleSupplierIds.every((id) => selectedSupplierIds.includes(id));
  const someVisibleSelected = visibleSupplierIds.some((id) => selectedSupplierIds.includes(id)) && !allVisibleSelected;

  useEffect(() => {
    if (!bulkRuleSetId) {
      const fallback = Number(globalRuleSetId) > 0 ? String(globalRuleSetId) : String(markupRuleSets?.[0]?.id || '');
      if (fallback) setBulkRuleSetId(fallback);
    }
  }, [bulkRuleSetId, globalRuleSetId, markupRuleSets]);

  const openCreateSupplierModal = () => {
    setEditingSupplierId('');
    setSupplierDraft(toSupplierDraft(null));
    setSupplierErrors({});
    setSupplierFormStatus('');
    setSupplierModalOpen(true);
  };

  const openEditSupplierModal = (supplier) => {
    setEditingSupplierId(String(supplier.id));
    setSupplierDraft(toSupplierDraft(supplier));
    setSupplierErrors({});
    setSelectedSupplierId(String(supplier.id));
    setSupplierFormStatus('');
    setSupplierModalOpen(true);
  };

  const openMappingModal = (supplier) => {
    const supplierId = String(supplier.id);
    setSelectedSupplierId(supplierId);
    setMappingModalSupplier({ id: supplierId, name: String(supplier.name || '') });
    setMappingModalOpen(true);
  };

  const openBulkRuleSetModal = () => {
    const normalized = selectedSupplierIds.filter((id) => allSupplierRows.some((s) => String(s.id) === String(id)));
    setBulkTargetSupplierIds(normalized);
    setBulkSupplierSearch('');
    setBulkRuleSetModalOpen(true);
  };

  const submitBulkRuleSet = async () => {
    const success = await applyRuleSetToSelectedSuppliers(bulkRuleSetId, bulkTargetSupplierIds);
    if (success) setBulkRuleSetModalOpen(false);
  };

  const toggleBulkTargetSupplier = (supplierId, isChecked) => {
    setBulkTargetSupplierIds((prev) => {
      const id = String(supplierId);
      return isChecked ? (prev.includes(id) ? prev : [...prev, id]) : prev.filter((v) => v !== id);
    });
  };

  const toggleSupplierSelection = (supplierId, isChecked) => {
    setSelectedSupplierIds((prev) => {
      const id = String(supplierId);
      return isChecked ? (prev.includes(id) ? prev : [...prev, id]) : prev.filter((v) => v !== id);
    });
  };

  const selectAllVisibleSuppliers = () => {
    setSelectedSupplierIds((prev) => Array.from(new Set([...prev, ...visibleSupplierIds])));
  };

  const clearVisibleSuppliersSelection = () => {
    setSelectedSupplierIds((prev) => prev.filter((id) => !visibleSupplierIds.includes(id)));
  };

  useEffect(() => {
    const status = String(supplierFormStatus || '').toLowerCase();
    const wasSaved = previousSupplierFormStatusRef.current.includes('збережено');
    if (isSupplierModalOpen && status.includes('збережено') && !wasSaved) setSupplierModalOpen(false);
    previousSupplierFormStatusRef.current = status;
  }, [isSupplierModalOpen, supplierFormStatus]);

  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someVisibleSelected;
  }, [someVisibleSelected]);

  return (
    <div className="data-grid">
      <div className="mini-tabs">
        <button className={`tab ${activeInnerTab === 'suppliers' ? 'active' : ''}`} onClick={() => setActiveInnerTab('suppliers')}>
          Постачальники
        </button>
        <button className={`tab ${activeInnerTab === 'pricing' ? 'active' : ''}`} onClick={() => setActiveInnerTab('pricing')}>
          Націнки
        </button>
      </div>

      {activeInnerTab === 'suppliers' ? (
        <Section title="Постачальники" subtitle="Пошук і керування постачальниками">

          {/* Compact stats bar */}
          <div className="suppliers-stats-bar">
            <span className="suppliers-stat"><strong>{allSupplierRows.length}</strong> постачальників</span>
            <span className="suppliers-stat-sep">·</span>
            <span className="suppliers-stat"><strong className="stat-ok">{activeTotal}</strong> активних</span>
            <span className="suppliers-stat-sep">·</span>
            <span className="suppliers-stat"><strong className={inactiveTotal > 0 ? 'stat-warn' : ''}>{inactiveTotal}</strong> неактивних</span>
            <span className="suppliers-stat-sep">·</span>
            <span className="suppliers-stat"><strong>{prefixedTotal}</strong> з префіксом SKU</span>
            <span className="suppliers-stat-sep">·</span>
            <span className="suppliers-stat"><strong>{uniqueRuleSets}</strong> типів націнок</span>
          </div>

          {/* Toolbar */}
          <div className="suppliers-toolbar">
            <div className="suppliers-toolbar-search">
              <input
                placeholder="Пошук постачальника..."
                value={supplierSearch}
                onChange={(event) => setSupplierSearch(event.target.value)}
              />
            </div>
            <div className="actions suppliers-toolbar-actions">
              <select
                value={supplierSort}
                onChange={(event) => setSupplierSort(event.target.value)}
                style={{ width: 'auto' }}
              >
                <option value="name_asc">А → Я</option>
                <option value="name_desc">Я → А</option>
                <option value="id_asc">За ID</option>
              </select>
              <button className="btn" onClick={selectAllVisibleSuppliers}>Обрати всіх</button>
              <button className="btn primary" disabled={isReadOnly} onClick={openCreateSupplierModal}>
                + Новий
              </button>
            </div>
          </div>

          {/* Contextual selection bar — visible only when something is selected */}
          {selectedCount > 0 ? (
            <div className="suppliers-context-bar">
              <span className="suppliers-context-count">Вибрано: <strong>{selectedCount}</strong></span>
              <div className="suppliers-context-chips">
                {selectedSuppliers.slice(0, 5).map((s) => (
                  <span className="chip supplier-chip" key={`ctx_${s.id}`}>{s.name}</span>
                ))}
                {selectedSuppliers.length > 5 ? (
                  <span className="chip supplier-chip">+{selectedSuppliers.length - 5}</span>
                ) : null}
              </div>
              <div className="actions" style={{ marginLeft: 'auto', flexShrink: 0 }}>
                <button
                  className="btn primary"
                  disabled={isReadOnly || markupRuleSets.length === 0}
                  onClick={openBulkRuleSetModal}
                >
                  Застосувати націнку
                </button>
                <button className="btn" onClick={clearVisibleSuppliersSelection}>Зняти виділення</button>
              </div>
            </div>
          ) : null}

          {/* Table */}
          <div className="supplier-table-wrap">
            <table className="supplier-table">
              <thead>
                <tr>
                  <th>
                    <label className="inline-checkbox">
                      <input
                        ref={selectAllRef}
                        type="checkbox"
                        checked={allVisibleSelected}
                        onChange={(event) => {
                          if (event.target.checked) { selectAllVisibleSuppliers(); return; }
                          clearVisibleSuppliersSelection();
                        }}
                      />
                      <span>Всі</span>
                    </label>
                  </th>
                  <th>Постачальник</th>
                  <th>Стан</th>
                  <th>SKU префікс</th>
                  <th>Пріоритет</th>
                  <th>Тип націнки</th>
                  <th style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>Дії</th>
                </tr>
              </thead>
              <tbody>
                {supplierRows.length === 0 ? (
                  <tr>
                    <td colSpan={SUPPLIER_TABLE_COL_COUNT} className="supplier-empty-row">
                      Нічого не знайдено за поточним пошуком
                    </td>
                  </tr>
                ) : (
                  supplierRows.map((supplier) => {
                    const isSelected = selectedSupplierIds.includes(String(supplier.id));
                    return (
                      <tr key={supplier.id} className={isSelected ? 'supplier-row-selected' : ''}>
                        <td>
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={(event) => toggleSupplierSelection(supplier.id, event.target.checked)}
                          />
                        </td>
                        <td>
                          <div className="supplier-name-cell">
                            <div className="supplier-name-title">{supplier.name}</div>
                            <div className="supplier-name-meta">ID: {supplier.id}</div>
                          </div>
                        </td>
                        <td>
                          <Tag tone={supplier.is_active ? 'ok' : 'warn'}>
                            {supplier.is_active ? 'Активний' : 'Призупинено'}
                          </Tag>
                        </td>
                        <td>
                          <span className="rule-set-pill">
                            {supplier.sku_prefix ? supplier.sku_prefix : '—'}
                          </span>
                        </td>
                        <td>{supplier.priority}</td>
                        <td>
                          <span className="rule-set-pill">{supplier.markup_rule_set_name || '—'}</span>
                        </td>
                        <td>
                          <div className="actions supplier-row-actions">
                            <button className="btn btn-sm" onClick={() => openEditSupplierModal(supplier)}>
                              Редагувати
                            </button>
                            <button className="btn btn-sm" onClick={() => openMappingModal(supplier)}>
                              Мапінг
                            </button>
                            <button
                              className="btn btn-sm danger"
                              disabled={isReadOnly}
                              onClick={() => deleteSupplier(supplier.id)}
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

          <div className="status-line">
            Показано: {supplierRows.length} з {allSupplierRows.length}
            {suppliersStatus ? ` · ${suppliersStatus}` : ''}
          </div>
        </Section>
      ) : null}

      {activeInnerTab === 'pricing' ? pricingPanel : null}

      {/* Supplier create/edit modal */}
      {isSupplierModalOpen ? (
        <div className="modal-backdrop" onClick={() => setSupplierModalOpen(false)}>
          <div className="modal-card supplier-modal-card" onClick={(event) => event.stopPropagation()}>
            <div className="section-head">
              <div>
                <h3>{editingSupplierId ? `Редагування постачальника #${editingSupplierId}` : 'Новий постачальник'}</h3>
                <p className="muted">Базові параметри постачальника для роботи в пайплайні</p>
              </div>
              <button className="btn" onClick={() => setSupplierModalOpen(false)}>Закрити</button>
            </div>

            <div className="supplier-modal-grid">
              <div>
                <label>Назва</label>
                <input
                  placeholder="Наприклад: Склад WHITE HALL"
                  value={supplierDraft.name}
                  onChange={(event) => setSupplierDraft((prev) => ({ ...prev, name: event.target.value }))}
                />
                {supplierErrors.name ? <div className="field-error">{supplierErrors.name}</div> : null}
              </div>
              <div>
                <label>Пріоритет</label>
                <input
                  type="number"
                  value={supplierDraft.priority}
                  onChange={(event) => setSupplierDraft((prev) => ({ ...prev, priority: event.target.value }))}
                />
                {supplierErrors.priority ? <div className="field-error">{supplierErrors.priority}</div> : null}
              </div>
              <div>
                <label>SKU префікс (необовʼязково)</label>
                <input
                  placeholder="Напр.: SUPA"
                  value={supplierDraft.sku_prefix}
                  onChange={(event) =>
                    setSupplierDraft((prev) => ({ ...prev, sku_prefix: event.target.value.toUpperCase() }))
                  }
                />
                <div className="hint">Формат: A-Z, 0-9, "-", "_" (до 24 символів).</div>
                {supplierErrors.sku_prefix ? <div className="field-error">{supplierErrors.sku_prefix}</div> : null}
              </div>
            </div>

            <div className="supplier-modal-rule">
              <div>
                <label>Тип націнки</label>
                <select
                  value={supplierDraft.markup_rule_set_id}
                  onChange={(event) => setSupplierDraft((prev) => ({ ...prev, markup_rule_set_id: event.target.value }))}
                >
                  <option value="">
                    За замовчуванням ({globalRuleSet?.name || `#${globalRuleSetId || '—'}`})
                  </option>
                  {markupRuleSets.map((rs) => (
                    <option key={`supplier_ruleset_${rs.id}`} value={rs.id}>
                      {rs.name}{Number(globalRuleSetId) === Number(rs.id) ? ' (default)' : ''}
                    </option>
                  ))}
                </select>
                <div className="hint">Порожнє — використовувати глобальний тип націнки.</div>
                {supplierErrors.markup_rule_set_id ? (
                  <div className="field-error">{supplierErrors.markup_rule_set_id}</div>
                ) : null}
              </div>
            </div>

            <label className="supplier-modal-checkbox">
              <input
                type="checkbox"
                checked={supplierDraft.is_active}
                onChange={(event) => setSupplierDraft((prev) => ({ ...prev, is_active: event.target.checked }))}
              />
              Постачальник активний
            </label>

            <div className="actions supplier-modal-actions">
              <button className="btn primary" disabled={isReadOnly} onClick={saveSupplier}>
                {editingSupplierId ? 'Зберегти' : 'Створити'}
              </button>
            </div>
            <div className="status-line">{supplierFormStatus}</div>
          </div>
        </div>
      ) : null}

      {/* Mapping modal */}
      {isMappingModalOpen ? (
        <div className="modal-backdrop" onClick={() => setMappingModalOpen(false)}>
          <div className="modal-card modal-card-wide" onClick={(event) => event.stopPropagation()}>
            <div className="section-head">
              <div>
                <h3>Мапінг постачальника: {mappingModalSupplier?.name || '—'}</h3>
                <p className="muted">Усі дії в цій модалці виконуються в межах одного постачальника.</p>
              </div>
              <button className="btn" onClick={() => setMappingModalOpen(false)}>Закрити</button>
            </div>
            {mappingPanel}
          </div>
        </div>
      ) : null}

      {/* Bulk rule set modal */}
      {isBulkRuleSetModalOpen ? (
        <div className="modal-backdrop" onClick={() => setBulkRuleSetModalOpen(false)}>
          <div className="modal-card" onClick={(event) => event.stopPropagation()}>
            <div className="section-head">
              <div>
                <h3>Застосувати тип націнки</h3>
                <p className="muted">Оберіть тип націнки і постачальників</p>
              </div>
              <button className="btn" onClick={() => setBulkRuleSetModalOpen(false)}>Закрити</button>
            </div>

            <div>
              <label>Тип націнки</label>
              <select value={bulkRuleSetId} onChange={(event) => setBulkRuleSetId(event.target.value)}>
                <option value="">— оберіть —</option>
                {markupRuleSets.map((rs) => (
                  <option key={`bulk_modal_ruleset_${rs.id}`} value={rs.id}>
                    {rs.name}{Number(globalRuleSetId) === Number(rs.id) ? ' (default)' : ''}
                  </option>
                ))}
              </select>
            </div>

            <div className="actions bulk-modal-toolbar" style={{ marginTop: 10, marginBottom: 6 }}>
              <input
                className="bulk-modal-search"
                placeholder="Пошук постачальника..."
                value={bulkSupplierSearch}
                onChange={(event) => setBulkSupplierSearch(event.target.value)}
              />
              <button className="btn" onClick={() => setBulkTargetSupplierIds(allSupplierRows.map((s) => String(s.id)))}>
                Обрати всіх
              </button>
              <button className="btn" onClick={() => setBulkTargetSupplierIds([])}>
                Очистити
              </button>
            </div>

            <div className="supplier-picker-list">
              {filteredBulkSuppliers.map((supplier) => {
                const id = String(supplier.id);
                return (
                  <label className="supplier-picker-row" key={`bulk_pick_${id}`}>
                    <input
                      type="checkbox"
                      checked={bulkTargetSupplierIds.includes(id)}
                      onChange={(event) => toggleBulkTargetSupplier(id, event.target.checked)}
                    />
                    <span>{supplier.name}</span>
                    <span className="muted">ID: {supplier.id}</span>
                  </label>
                );
              })}
            </div>

            <div className="status-line" style={{ marginTop: 8 }}>
              До застосування: <strong>{bulkTargetSuppliers.length}</strong>
              {supplierBulkPricingStatus ? ` · ${supplierBulkPricingStatus}` : ''}
            </div>

            <div className="actions" style={{ marginTop: 10 }}>
              <button
                className="btn primary"
                disabled={isReadOnly || !bulkRuleSetId || bulkTargetSupplierIds.length === 0}
                onClick={submitBulkRuleSet}
              >
                Застосувати
              </button>
              <button className="btn" onClick={() => setBulkRuleSetModalOpen(false)}>
                Скасувати
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
