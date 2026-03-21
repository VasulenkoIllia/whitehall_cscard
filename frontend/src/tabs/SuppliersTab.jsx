import React from 'react';
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
  setBulkDraft,
  bulkDraft,
  supplierFormStatus,
  saveSupplier,
  bulkStatus,
  saveSupplierBulk
}) {
  return (
    <div className="grid">
      <Section
        title="Постачальники"
        subtitle="Пошук, сортування та вибір для пайплайна"
        extra={<button className="btn" onClick={refreshSuppliers}>Оновити список</button>}
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
          <div>
            <label>Сортування</label>
            <select value={supplierSort} onChange={(event) => setSupplierSort(event.target.value)}>
              <option value="id_asc">За ID</option>
              <option value="name_asc">Назва А-Я</option>
              <option value="name_desc">Назва Я-А</option>
            </select>
          </div>
          <div>
            <label>Вибрано для масових дій</label>
            <input value={selectedSupplierIds.length ? selectedSupplierIds.join(', ') : 'немає'} readOnly />
          </div>
        </div>

        <table>
          <thead>
            <tr>
              <th>Вибір</th>
              <th>Постачальник</th>
              <th>Стан</th>
              <th>Пріоритет</th>
              <th>Націнка</th>
              <th>Rule set</th>
              <th>Дії</th>
            </tr>
          </thead>
          <tbody>
            {suppliers.map((supplier) => (
              <tr key={supplier.id}>
                <td>
                  <input
                    type="checkbox"
                    checked={selectedSupplierIds.includes(String(supplier.id))}
                    onChange={(event) => {
                      setSelectedSupplierIds((prev) => {
                        const id = String(supplier.id);
                        if (event.target.checked) {
                          return prev.includes(id) ? prev : [...prev, id];
                        }
                        return prev.filter((value) => value !== id);
                      });
                    }}
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
                <td>{supplier.markup_percent}</td>
                <td>{supplier.markup_rule_set_name || '-'}</td>
                <td>
                  <div className="actions">
                    <button
                      className="btn"
                      onClick={() => {
                        setEditingSupplierId(String(supplier.id));
                        setSupplierDraft(toSupplierDraft(supplier));
                        setSupplierErrors({});
                        setSelectedSupplierId(String(supplier.id));
                      }}
                    >
                      Редагувати
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
        <div className="status-line">{suppliersStatus}</div>
      </Section>

      <Section title={editingSupplierId ? `Редагування #${editingSupplierId}` : 'Новий постачальник'}>
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
            <label>Націнка %</label>
            <input
              value={supplierDraft.markup_percent}
              onChange={(event) =>
                setSupplierDraft((prev) => ({ ...prev, markup_percent: event.target.value }))
              }
            />
            {supplierErrors.markup_percent ? <div className="field-error">{supplierErrors.markup_percent}</div> : null}
          </div>
        </div>
        <div className="form-row">
          <div>
            <label>Мінімальний прибуток</label>
            <input
              value={supplierDraft.min_profit_amount}
              onChange={(event) =>
                setSupplierDraft((prev) => ({ ...prev, min_profit_amount: event.target.value }))
              }
            />
            {supplierErrors.min_profit_amount ? (
              <div className="field-error">{supplierErrors.min_profit_amount}</div>
            ) : null}
          </div>
          <div>
            <label>ID rule set (опційно)</label>
            <input
              value={supplierDraft.markup_rule_set_id}
              onChange={(event) =>
                setSupplierDraft((prev) => ({ ...prev, markup_rule_set_id: event.target.value }))
              }
            />
            {supplierErrors.markup_rule_set_id ? (
              <div className="field-error">{supplierErrors.markup_rule_set_id}</div>
            ) : null}
          </div>
        </div>
        <div className="checkbox-row">
          <label>
            <input
              type="checkbox"
              checked={supplierDraft.min_profit_enabled}
              onChange={(event) =>
                setSupplierDraft((prev) => ({ ...prev, min_profit_enabled: event.target.checked }))
              }
            />
            Увімкнути мінімальний прибуток
          </label>
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
        <div className="actions" style={{ marginTop: 8 }}>
          <button className="btn primary" disabled={isReadOnly} onClick={saveSupplier}>
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
      </Section>

      <Section title="Масове оновлення" subtitle="Застосування полів до вибраних постачальників">
        <details className="details-block">
          <summary>Показати bulk-налаштування</summary>
          <div className="form-row" style={{ marginTop: 10 }}>
            <div>
              <label>
                <input
                  type="checkbox"
                  checked={bulkDraft.apply_markup_percent}
                  onChange={(event) =>
                    setBulkDraft((prev) => ({ ...prev, apply_markup_percent: event.target.checked }))
                  }
                  style={{ width: 'auto', marginRight: 8 }}
                />
                Застосувати націнку %
              </label>
              <input
                value={bulkDraft.markup_percent}
                onChange={(event) =>
                  setBulkDraft((prev) => ({ ...prev, markup_percent: event.target.value }))
                }
              />
            </div>
            <div>
              <label>
                <input
                  type="checkbox"
                  checked={bulkDraft.apply_min_profit}
                  onChange={(event) =>
                    setBulkDraft((prev) => ({ ...prev, apply_min_profit: event.target.checked }))
                  }
                  style={{ width: 'auto', marginRight: 8 }}
                />
                Застосувати мінімальний прибуток
              </label>
              <input
                value={bulkDraft.min_profit_amount}
                onChange={(event) =>
                  setBulkDraft((prev) => ({ ...prev, min_profit_amount: event.target.value }))
                }
              />
            </div>
          </div>
          <label style={{ marginTop: 8 }}>
            <input
              type="checkbox"
              checked={bulkDraft.min_profit_enabled}
              onChange={(event) =>
                setBulkDraft((prev) => ({ ...prev, min_profit_enabled: event.target.checked }))
              }
              style={{ width: 'auto', marginRight: 8 }}
            />
            Мінімальний прибуток увімкнено
          </label>
          <div className="actions" style={{ marginTop: 8 }}>
            <button className="btn primary" disabled={isReadOnly} onClick={saveSupplierBulk}>
              Виконати bulk update
            </button>
            <button className="btn" onClick={() => setSelectedSupplierIds([])}>
              Очистити вибір
            </button>
            <span className="muted">Вибрано: {selectedSupplierIds.length}</span>
          </div>
        </details>
        <div className="status-line">{bulkStatus}</div>
      </Section>
    </div>
  );
}
