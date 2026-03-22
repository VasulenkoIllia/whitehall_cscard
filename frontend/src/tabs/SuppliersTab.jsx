import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Section, Tag } from '../components/ui';

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
  const [bulkRuleSetId, setBulkRuleSetId] = useState('');
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
      rows.sort((a, b) =>
        String(b.name || '').localeCompare(String(a.name || ''), 'uk', { sensitivity: 'base' })
      );
      return rows;
    }
    if (supplierSort === 'name_asc') {
      rows.sort((a, b) =>
        String(a.name || '').localeCompare(String(b.name || ''), 'uk', { sensitivity: 'base' })
      );
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
          subtitle="Керуйте постачальниками та обирайте їх для дій у вкладці Націнки"
          extra={
            <div className="actions">
              <button className="btn" onClick={refreshSuppliers}>Оновити список</button>
              <button className="btn primary" disabled={isReadOnly} onClick={openCreateSupplierModal}>
                Новий постачальник
              </button>
            </div>
          }
        >
          <div className="form-row">
            <div>
              <label>Пошук</label>
              <input
                placeholder="Назва постачальника..."
                value={supplierSearch}
                onChange={(event) => setSupplierSearch(event.target.value)}
              />
            </div>
          </div>

          <div className="selected-summary">
            <div className="selected-summary-head">
              <strong>Вибрано постачальників: {selectedCount}</strong>
              <div className="actions">
                <button className="btn" onClick={selectAllVisibleSuppliers}>
                  Обрати всіх
                </button>
                <button className="btn" onClick={clearVisibleSuppliersSelection}>
                  Очистити
                </button>
              </div>
            </div>

            {selectedSuppliers.length > 0 ? (
              <div className="selected-chip-list">
                {selectedSuppliers.slice(0, 8).map((supplier) => (
                  <span className="chip supplier-chip" key={`selected_${supplier.id}`}>
                    {supplier.name}
                  </span>
                ))}
                {selectedSuppliers.length > 8 ? (
                  <span className="chip supplier-chip">+{selectedSuppliers.length - 8}</span>
                ) : null}
              </div>
            ) : (
              <div className="muted">Немає вибраних постачальників</div>
            )}

            <div className="bulk-pricing-inline">
              <div>
                <label>Тип націнки для вибраних</label>
                <select value={bulkRuleSetId} onChange={(event) => setBulkRuleSetId(event.target.value)}>
                  <option value="">-- оберіть --</option>
                  {markupRuleSets.map((ruleSet) => (
                    <option key={`bulk_ruleset_${ruleSet.id}`} value={ruleSet.id}>
                      {ruleSet.name}
                      {Number(globalRuleSetId) === Number(ruleSet.id) ? ' (default)' : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label>&nbsp;</label>
                <button
                  className="btn primary"
                  disabled={isReadOnly || !bulkRuleSetId || selectedCount === 0}
                  onClick={() => applyRuleSetToSelectedSuppliers(bulkRuleSetId)}
                >
                  Застосувати ({selectedCount})
                </button>
              </div>
            </div>
            <div className="status-line">{supplierBulkPricingStatus}</div>
          </div>

          <table>
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
                  <div className="column-header-with-sort">
                    <span>Постачальник</span>
                    <select
                      className="inline-select"
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
              {supplierRows.map((supplier) => (
                <tr key={supplier.id}>
                  <td>
                    <input
                      type="checkbox"
                      checked={selectedSupplierIds.includes(String(supplier.id))}
                      onChange={(event) => toggleSupplierSelection(supplier.id, event.target.checked)}
                    />
                  </td>
                  <td>
                    <div>{supplier.name}</div>
                    <div className="muted">ID: {supplier.id}</div>
                  </td>
                  <td>
                    <Tag tone={supplier.is_active ? 'ok' : 'warn'}>
                      {supplier.is_active ? 'active' : 'paused'}
                    </Tag>
                  </td>
                  <td>{supplier.priority}</td>
                  <td>{supplier.markup_rule_set_name || '-'}</td>
                  <td>
                    <div className="actions">
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
              ))}
            </tbody>
          </table>

          <div className="status-line">Показано: {supplierRows.length}</div>
          <div className="status-line">{suppliersStatus}</div>
        </Section>
      ) : null}

      {activeInnerTab === 'pricing' ? pricingPanel : null}

      {isSupplierModalOpen ? (
        <div className="modal-backdrop" onClick={closeSupplierModal}>
          <div className="modal-card" onClick={(event) => event.stopPropagation()}>
            <div className="section-head">
              <div>
                <h3>{editingSupplierId ? `Редагування постачальника #${editingSupplierId}` : 'Новий постачальник'}</h3>
                <p className="muted">Базові параметри постачальника для роботи в пайплайні</p>
              </div>
              <button className="btn" onClick={closeSupplierModal}>Закрити</button>
            </div>

            <div className="form-row">
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

            <div className="checkbox-row">
              <label>
                <input
                  type="checkbox"
                  checked={supplierDraft.is_active}
                  onChange={(event) =>
                    setSupplierDraft((prev) => ({ ...prev, is_active: event.target.checked }))
                  }
                />
                Постачальник активний
              </label>
            </div>

            <div className="actions" style={{ marginTop: 10 }}>
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
    </div>
  );
}
