import React from 'react';
import { Section } from '../components/ui';

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
        subtitle="Пошук, сортування, CRUD"
        extra={<button className="btn" onClick={refreshSuppliers}>Оновити список</button>}
      >
        <div className="form-row">
          <div>
            <label>Пошук</label>
            <input value={supplierSearch} onChange={(event) => setSupplierSearch(event.target.value)} />
          </div>
          <div>
            <label>Сортування</label>
            <select value={supplierSort} onChange={(event) => setSupplierSort(event.target.value)}>
              <option value="id_asc">ID</option>
              <option value="name_asc">A-Я</option>
              <option value="name_desc">Я-A</option>
            </select>
          </div>
          <div>
            <label>Selected IDs</label>
            <input value={selectedSupplierIds.join(',')} readOnly />
          </div>
        </div>

        <table>
          <thead>
            <tr>
              <th>Select</th>
              <th>ID</th>
              <th>Назва</th>
              <th>Active</th>
              <th>Priority</th>
              <th>Markup %</th>
              <th>Rule set</th>
              <th>Actions</th>
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
                <td>{supplier.id}</td>
                <td>{supplier.name}</td>
                <td>{supplier.is_active ? 'true' : 'false'}</td>
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
                      Edit
                    </button>
                    <button
                      className="btn danger"
                      disabled={isReadOnly}
                      onClick={() => deleteSupplier(supplier.id)}
                    >
                      Delete
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
              value={supplierDraft.name}
              onChange={(event) =>
                setSupplierDraft((prev) => ({ ...prev, name: event.target.value }))
              }
            />
            {supplierErrors.name ? <div className="field-error">{supplierErrors.name}</div> : null}
          </div>
          <div>
            <label>Priority</label>
            <input
              value={supplierDraft.priority}
              onChange={(event) =>
                setSupplierDraft((prev) => ({ ...prev, priority: event.target.value }))
              }
            />
            {supplierErrors.priority ? <div className="field-error">{supplierErrors.priority}</div> : null}
          </div>
          <div>
            <label>Markup %</label>
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
            <label>Min profit amount</label>
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
            <label>Markup rule set id</label>
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
            min_profit_enabled
          </label>
          <label>
            <input
              type="checkbox"
              checked={supplierDraft.is_active}
              onChange={(event) =>
                setSupplierDraft((prev) => ({ ...prev, is_active: event.target.checked }))
              }
            />
            is_active
          </label>
        </div>
        <div className="actions" style={{ marginTop: 8 }}>
          <button className="btn primary" disabled={isReadOnly} onClick={saveSupplier}>
            {editingSupplierId ? 'Save supplier' : 'Create supplier'}
          </button>
          <button
            className="btn"
            onClick={() => {
              setEditingSupplierId('');
              setSupplierDraft(toSupplierDraft(null));
              setSupplierErrors({});
            }}
          >
            Reset form
          </button>
        </div>
        <div className="status-line">{supplierFormStatus}</div>
      </Section>

      <Section
        title="Bulk update suppliers"
        subtitle="Без зміни бізнес-логіки, лише масове оновлення полів"
      >
        <div className="form-row">
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
              Apply markup_percent
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
              Apply min_profit
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
          min_profit_enabled
        </label>
        <div className="actions" style={{ marginTop: 8 }}>
          <button className="btn primary" disabled={isReadOnly} onClick={saveSupplierBulk}>
            Run bulk update
          </button>
          <button className="btn" onClick={() => setSelectedSupplierIds([])}>
            Clear selection
          </button>
        </div>
        <div className="status-line">{bulkStatus}</div>
      </Section>
    </div>
  );
}
