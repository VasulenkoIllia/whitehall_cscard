import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Section, Tag } from '../components/ui';

const CYRILLIC_TO_LATIN = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'h',
  ґ: 'g',
  д: 'd',
  е: 'e',
  є: 'ye',
  ж: 'zh',
  з: 'z',
  и: 'y',
  і: 'i',
  ї: 'yi',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'kh',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'shch',
  ь: '',
  ю: 'yu',
  я: 'ya',
  ё: 'yo',
  э: 'e',
  ы: 'y',
  ъ: ''
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
  const byKey = leftKey.localeCompare(rightKey, 'en', {
    sensitivity: 'base',
    numeric: true
  });
  if (byKey !== 0) {
    return byKey;
  }
  return String(left?.name || '').localeCompare(String(right?.name || ''), 'uk', {
    sensitivity: 'base',
    numeric: true
  });
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

  const allSupplierRows = useMemo(() => (Array.isArray(suppliers) ? suppliers : []), [suppliers]);

  const supplierRows = useMemo(() => {
    let rows = [...allSupplierRows];
    const normalizedSearch = String(supplierSearch || '').trim().toLowerCase();
    if (normalizedSearch) {
      rows = rows.filter((supplier) =>
        String(supplier.name || '').toLowerCase().includes(normalizedSearch)
      );
    }
    if (supplierSort === 'name_desc') {
      rows.sort((a, b) => compareSupplierNameAsc(b, a));
      return rows;
    }
    if (supplierSort === 'name_asc') {
      rows.sort((a, b) => compareSupplierNameAsc(a, b));
      return rows;
    }
    rows.sort((a, b) => Number(a.id || 0) - Number(b.id || 0));
    return rows;
  }, [allSupplierRows, supplierSearch, supplierSort]);

  const selectedCount = selectedSupplierIds.length;
  const selectedSuppliers = useMemo(
    () =>
      allSupplierRows.filter((supplier) =>
        selectedSupplierIds.includes(String(supplier.id))
      ),
    [allSupplierRows, selectedSupplierIds]
  );
  const activeVisibleCount = supplierRows.filter((supplier) => Boolean(supplier.is_active)).length;
  const inactiveVisibleCount = Math.max(supplierRows.length - activeVisibleCount, 0);
  const uniqueVisibleRuleSets = new Set(
    supplierRows
      .map((supplier) => String(supplier.markup_rule_set_name || '').trim())
      .filter(Boolean)
  ).size;

  const bulkTargetSuppliers = useMemo(
    () =>
      allSupplierRows.filter((supplier) =>
        bulkTargetSupplierIds.includes(String(supplier.id))
      ),
    [allSupplierRows, bulkTargetSupplierIds]
  );

  const filteredBulkSuppliers = useMemo(() => {
    const normalizedSearch = String(bulkSupplierSearch || '').trim().toLowerCase();
    if (!normalizedSearch) {
      return allSupplierRows;
    }
    return allSupplierRows.filter((supplier) =>
      String(supplier.name || '').toLowerCase().includes(normalizedSearch)
    );
  }, [allSupplierRows, bulkSupplierSearch]);

  const globalRuleSet = useMemo(
    () =>
      (Array.isArray(markupRuleSets) ? markupRuleSets : []).find(
        (ruleSet) => Number(ruleSet.id) === Number(globalRuleSetId)
      ) || null,
    [markupRuleSets, globalRuleSetId]
  );

  const visibleSupplierIds = useMemo(
    () => supplierRows.map((supplier) => String(supplier.id)),
    [supplierRows]
  );

  const allVisibleSelected =
    visibleSupplierIds.length > 0 &&
    visibleSupplierIds.every((id) => selectedSupplierIds.includes(id));
  const someVisibleSelected =
    visibleSupplierIds.some((id) => selectedSupplierIds.includes(id)) && !allVisibleSelected;

  useEffect(() => {
    if (!bulkRuleSetId) {
      const fallbackRuleSetId =
        Number(globalRuleSetId) > 0 ? String(globalRuleSetId) : String(markupRuleSets?.[0]?.id || '');
      if (fallbackRuleSetId) {
        setBulkRuleSetId(fallbackRuleSetId);
      }
    }
  }, [bulkRuleSetId, globalRuleSetId, markupRuleSets]);

  const openCreateSupplierModal = () => {
    setEditingSupplierId('');
    setSupplierDraft(toSupplierDraft(null));
    setSupplierErrors({});
    setSupplierModalOpen(true);
  };

  const openEditSupplierModal = (supplier) => {
    setEditingSupplierId(String(supplier.id));
    setSupplierDraft(toSupplierDraft(supplier));
    setSupplierErrors({});
    setSelectedSupplierId(String(supplier.id));
    setSupplierModalOpen(true);
  };

  const closeSupplierModal = () => {
    setSupplierModalOpen(false);
  };

  const closeMappingModal = () => {
    setMappingModalOpen(false);
  };

  const openMappingModal = (supplier) => {
    const supplierId = String(supplier.id);
    setSelectedSupplierId(supplierId);
    setMappingModalSupplier({
      id: supplierId,
      name: String(supplier.name || '')
    });
    setMappingModalOpen(true);
  };

  const openBulkRuleSetModal = () => {
    const normalizedSelectedIds = selectedSupplierIds.filter((id) =>
      allSupplierRows.some((supplier) => String(supplier.id) === String(id))
    );
    setBulkTargetSupplierIds(normalizedSelectedIds);
    setBulkSupplierSearch('');
    setBulkRuleSetModalOpen(true);
  };

  const closeBulkRuleSetModal = () => {
    setBulkRuleSetModalOpen(false);
  };

  const submitBulkRuleSet = async () => {
    const success = await applyRuleSetToSelectedSuppliers(bulkRuleSetId, bulkTargetSupplierIds);
    if (success) {
      setBulkRuleSetModalOpen(false);
    }
  };

  const toggleBulkTargetSupplier = (supplierId, isChecked) => {
    setBulkTargetSupplierIds((prev) => {
      const normalizedId = String(supplierId);
      if (isChecked) {
        return prev.includes(normalizedId) ? prev : [...prev, normalizedId];
      }
      return prev.filter((value) => value !== normalizedId);
    });
  };

  const selectAllBulkTargets = () => {
    setBulkTargetSupplierIds(allSupplierRows.map((supplier) => String(supplier.id)));
  };

  const clearBulkTargets = () => {
    setBulkTargetSupplierIds([]);
  };

  const toggleSupplierSelection = (supplierId, isChecked) => {
    setSelectedSupplierIds((prev) => {
      const normalizedId = String(supplierId);
      if (isChecked) {
        return prev.includes(normalizedId) ? prev : [...prev, normalizedId];
      }
      return prev.filter((value) => value !== normalizedId);
    });
  };

  const selectAllVisibleSuppliers = () => {
    setSelectedSupplierIds((prev) => {
      const merged = new Set(prev);
      visibleSupplierIds.forEach((id) => merged.add(id));
      return Array.from(merged);
    });
  };

  const clearVisibleSuppliersSelection = () => {
    setSelectedSupplierIds((prev) => prev.filter((id) => !visibleSupplierIds.includes(id)));
  };

  useEffect(() => {
    if (!isSupplierModalOpen) {
      return;
    }
    if (String(supplierFormStatus || '').toLowerCase().includes('збережено')) {
      setSupplierModalOpen(false);
    }
  }, [isSupplierModalOpen, supplierFormStatus]);

  useEffect(() => {
    if (!selectAllRef.current) {
      return;
    }
    selectAllRef.current.indeterminate = someVisibleSelected;
  }, [someVisibleSelected]);

  return (
    <div className="data-grid">
      <div className="mini-tabs">
        <button
          className={`tab ${activeInnerTab === 'suppliers' ? 'active' : ''}`}
          onClick={() => setActiveInnerTab('suppliers')}
        >
          Постачальники
        </button>
        <button
          className={`tab ${activeInnerTab === 'pricing' ? 'active' : ''}`}
          onClick={() => setActiveInnerTab('pricing')}
        >
          Націнки
        </button>
      </div>

      {activeInnerTab === 'suppliers' ? (
        <Section
          title="Постачальники"
          subtitle="Пошук і керування постачальниками"
        >
          <div className="suppliers-kpi-grid">
            <div className="suppliers-kpi-card">
              <div className="suppliers-kpi-label">У списку</div>
              <div className="suppliers-kpi-value">{supplierRows.length}</div>
            </div>
            <div className="suppliers-kpi-card">
              <div className="suppliers-kpi-label">Активні</div>
              <div className="suppliers-kpi-value">{activeVisibleCount}</div>
            </div>
            <div className="suppliers-kpi-card">
              <div className="suppliers-kpi-label">Неактивні</div>
              <div className="suppliers-kpi-value">{inactiveVisibleCount}</div>
            </div>
            <div className="suppliers-kpi-card">
              <div className="suppliers-kpi-label">Типи націнок</div>
              <div className="suppliers-kpi-value">{uniqueVisibleRuleSets}</div>
            </div>
          </div>

          <div className="suppliers-toolbar">
            <div className="suppliers-toolbar-search">
              <input
                placeholder="Пошук постачальника..."
                value={supplierSearch}
                onChange={(event) => setSupplierSearch(event.target.value)}
              />
            </div>
            <div className="actions suppliers-toolbar-actions">
              <button className="btn primary" disabled={isReadOnly} onClick={openCreateSupplierModal}>
                Новий постачальник
              </button>
              <button className="btn" disabled={isReadOnly || markupRuleSets.length === 0} onClick={openBulkRuleSetModal}>
                Застосувати націнку
              </button>
            </div>
          </div>

          <div className="suppliers-selection-row">
            <div className="suppliers-selection-info">
              <div className="muted">
                Вибрано постачальників: {selectedCount}
              </div>
              {selectedSuppliers.length > 0 ? (
                <div className="selected-chip-list suppliers-selection-chips">
                  {selectedSuppliers.slice(0, 6).map((supplier) => (
                    <span className="chip supplier-chip" key={`selected_preview_${supplier.id}`}>
                      {supplier.name}
                    </span>
                  ))}
                  {selectedSuppliers.length > 6 ? (
                    <span className="chip supplier-chip">+{selectedSuppliers.length - 6}</span>
                  ) : null}
                </div>
              ) : null}
            </div>
            <div className="actions">
              <button className="btn" onClick={selectAllVisibleSuppliers}>
                Обрати всіх
              </button>
              <button className="btn" onClick={clearVisibleSuppliersSelection}>
                Очистити
              </button>
            </div>
          </div>

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
                          if (event.target.checked) {
                            selectAllVisibleSuppliers();
                            return;
                          }
                          clearVisibleSuppliersSelection();
                        }}
                      />
                      <span>Всі</span>
                    </label>
                  </th>
                  <th>
                    <div className="supplier-header-filter">
                      <span>Постачальник</span>
                      <select
                        className="inline-select supplier-inline-sort"
                        value={supplierSort}
                        onChange={(event) => setSupplierSort(event.target.value)}
                      >
                        <option value="name_asc">А-Я</option>
                        <option value="name_desc">Я-А</option>
                        <option value="id_asc">За ID</option>
                      </select>
                    </div>
                  </th>
                  <th>Стан</th>
                  <th>Пріоритет</th>
                  <th>Rule set</th>
                  <th>Дії</th>
                </tr>
              </thead>
              <tbody>
                {supplierRows.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="supplier-empty-row">
                      Нічого не знайдено за поточним пошуком
                    </td>
                  </tr>
                ) : (
                  supplierRows.map((supplier) => {
                    const isSelected = selectedSupplierIds.includes(String(supplier.id));
                    return (
                      <tr
                        key={supplier.id}
                        className={isSelected ? 'supplier-row-selected' : ''}
                      >
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
                            {supplier.is_active ? 'active' : 'paused'}
                          </Tag>
                        </td>
                        <td>{supplier.priority}</td>
                        <td>
                          <span className="rule-set-pill">{supplier.markup_rule_set_name || '-'}</span>
                        </td>
                        <td>
                          <div className="actions supplier-row-actions">
                            <button className="btn" onClick={() => openEditSupplierModal(supplier)}>
                              Редагувати
                            </button>
                            <button className="btn" onClick={() => openMappingModal(supplier)}>
                              Мапінг
                            </button>
                            <button
                              className="btn danger"
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

          <div className="status-line">Показано: {supplierRows.length}</div>
          <div className="status-line">{suppliersStatus}</div>
        </Section>
      ) : null}

      {activeInnerTab === 'pricing' ? pricingPanel : null}

      {isSupplierModalOpen ? (
        <div className="modal-backdrop" onClick={closeSupplierModal}>
          <div className="modal-card supplier-modal-card" onClick={(event) => event.stopPropagation()}>
            <div className="section-head">
              <div>
                <h3>{editingSupplierId ? `Редагування постачальника #${editingSupplierId}` : 'Новий постачальник'}</h3>
                <p className="muted">Базові параметри постачальника для роботи в пайплайні</p>
              </div>
              <button className="btn" onClick={closeSupplierModal}>Закрити</button>
            </div>

            <div className="supplier-modal-grid">
              <div>
                <label>Назва</label>
                <input
                  placeholder="Наприклад: Склад WHITE HALL"
                  value={supplierDraft.name}
                  onChange={(event) =>
                    setSupplierDraft((prev) => ({ ...prev, name: event.target.value }))
                  }
                />
                {supplierErrors.name ? <div className="field-error">{supplierErrors.name}</div> : null}
              </div>
              <div>
                <label>Пріоритет</label>
                <input
                  value={supplierDraft.priority}
                  onChange={(event) =>
                    setSupplierDraft((prev) => ({ ...prev, priority: event.target.value }))
                  }
                />
                {supplierErrors.priority ? <div className="field-error">{supplierErrors.priority}</div> : null}
              </div>
            </div>

            <div className="supplier-modal-rule">
              <div>
                <label>Тип націнки (rule set)</label>
                <select
                  value={supplierDraft.markup_rule_set_id}
                  onChange={(event) =>
                    setSupplierDraft((prev) => ({ ...prev, markup_rule_set_id: event.target.value }))
                  }
                >
                  <option value="">
                    За замовчуванням ({globalRuleSet?.name || `#${globalRuleSetId || '-'}`})
                  </option>
                  {markupRuleSets.map((ruleSet) => (
                    <option key={`supplier_ruleset_${ruleSet.id}`} value={ruleSet.id}>
                      {ruleSet.name}
                      {Number(globalRuleSetId) === Number(ruleSet.id) ? ' (default)' : ''}
                    </option>
                  ))}
                </select>
                <div className="hint">
                  Порожнє значення = використовувати глобальний default rule set.
                </div>
                {supplierErrors.markup_rule_set_id ? (
                  <div className="field-error">{supplierErrors.markup_rule_set_id}</div>
                ) : null}
              </div>
            </div>

            <label className="supplier-modal-checkbox">
                <input
                  type="checkbox"
                  checked={supplierDraft.is_active}
                  onChange={(event) =>
                    setSupplierDraft((prev) => ({ ...prev, is_active: event.target.checked }))
                  }
                />
                Постачальник активний
            </label>

            <div className="actions supplier-modal-actions">
              <button
                className="btn primary"
                disabled={isReadOnly}
                onClick={saveSupplier}
              >
                {editingSupplierId ? 'Зберегти' : 'Створити'}
              </button>
              <button
                className="btn"
                onClick={() => {
                  setEditingSupplierId('');
                  setSupplierDraft(toSupplierDraft(null));
                  setSupplierErrors({});
                }}
              >
                Скинути форму
              </button>
            </div>
            <div className="status-line">{supplierFormStatus}</div>
          </div>
        </div>
      ) : null}

      {isMappingModalOpen ? (
        <div className="modal-backdrop" onClick={closeMappingModal}>
          <div className="modal-card modal-card-wide" onClick={(event) => event.stopPropagation()}>
            <div className="section-head">
              <div>
                <h3>Мапінг постачальника: {mappingModalSupplier?.name || '-'}</h3>
                <p className="muted">
                  Усі дії в цій модалці виконуються в межах одного постачальника.
                </p>
              </div>
              <button className="btn" onClick={closeMappingModal}>Закрити</button>
            </div>
            {mappingPanel}
          </div>
        </div>
      ) : null}

      {isBulkRuleSetModalOpen ? (
        <div className="modal-backdrop" onClick={closeBulkRuleSetModal}>
          <div className="modal-card" onClick={(event) => event.stopPropagation()}>
            <div className="section-head">
              <div>
                <h3>Застосувати тип націнки</h3>
                <p className="muted">Оберіть тип націнки і постачальників</p>
              </div>
              <button className="btn" onClick={closeBulkRuleSetModal}>Закрити</button>
            </div>

            <div className="form-row">
              <div>
                <label>Тип націнки</label>
                <select value={bulkRuleSetId} onChange={(event) => setBulkRuleSetId(event.target.value)}>
                  <option value="">-- оберіть --</option>
                  {markupRuleSets.map((ruleSet) => (
                    <option key={`bulk_modal_ruleset_${ruleSet.id}`} value={ruleSet.id}>
                      {ruleSet.name}
                      {Number(globalRuleSetId) === Number(ruleSet.id) ? ' (default)' : ''}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="actions bulk-modal-toolbar" style={{ marginTop: 8, marginBottom: 8 }}>
              <input
                className="bulk-modal-search"
                placeholder="Пошук постачальника в модалці..."
                value={bulkSupplierSearch}
                onChange={(event) => setBulkSupplierSearch(event.target.value)}
              />
              <button className="btn" onClick={selectAllBulkTargets}>
                Обрати всіх
              </button>
              <button className="btn" onClick={clearBulkTargets}>
                Очистити
              </button>
            </div>
            <div className="supplier-picker-list">
              {filteredBulkSuppliers.map((supplier) => {
                const id = String(supplier.id);
                const checked = bulkTargetSupplierIds.includes(id);
                return (
                  <label className="supplier-picker-row" key={`bulk_pick_${id}`}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(event) => toggleBulkTargetSupplier(id, event.target.checked)}
                    />
                    <span>{supplier.name}</span>
                    <span className="muted">ID: {supplier.id}</span>
                  </label>
                );
              })}
            </div>

            {bulkTargetSuppliers.length > 0 ? (
              <div className="selected-chip-list" style={{ marginTop: 8, marginBottom: 8 }}>
                {bulkTargetSuppliers.map((supplier) => (
                  <span className="chip supplier-chip" key={`bulk_selected_${supplier.id}`}>
                    {supplier.name}
                  </span>
                ))}
              </div>
            ) : (
              <div className="muted" style={{ marginTop: 8, marginBottom: 8 }}>
                Нікого не обрано
              </div>
            )}

            <div className="status-line">
              До застосування: {bulkTargetSuppliers.length}
            </div>
            <div className="status-line">{supplierBulkPricingStatus}</div>

            <div className="actions" style={{ marginTop: 10 }}>
              <button
                className="btn primary"
                disabled={isReadOnly || !bulkRuleSetId || bulkTargetSupplierIds.length === 0}
                onClick={submitBulkRuleSet}
              >
                Застосувати
              </button>
              <button className="btn" onClick={closeBulkRuleSetModal}>
                Скасувати
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
