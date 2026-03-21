import React from 'react';
import { Section } from '../components/ui';

export function PricingTab({
  refreshMarkupRuleSets,
  pricingApplyRuleSetId,
  setPricingApplyRuleSetId,
  markupRuleSets,
  pricingApplyScope,
  setPricingApplyScope,
  isReadOnly,
  applyMarkupRuleSet,
  setDefaultMarkupRuleSet,
  startCreateRuleSet,
  globalRuleSetId,
  pricingStatus,
  startEditRuleSet,
  ruleSetDraft,
  setRuleSetDraft,
  ruleSetErrors,
  updateRuleCondition,
  removeRuleCondition,
  addRuleCondition,
  saveRuleSet,
  ruleSetStatus,
  priceOverrideFilters,
  setPriceOverrideFilters,
  refreshPriceOverrides,
  priceOverrideDraft,
  setPriceOverrideDraft,
  priceOverrideErrors,
  savePriceOverride,
  toPriceOverrideDraft,
  priceOverrideStatus,
  priceOverrides
}) {
  return (
    <div className="grid">
      <Section
        title="Markup Rule Sets"
        subtitle="Огляд, default, apply по suppliers/all suppliers"
        extra={<button className="btn" onClick={refreshMarkupRuleSets}>Reload</button>}
      >
        <div className="form-row">
          <div>
            <label>Rule set</label>
            <select
              value={pricingApplyRuleSetId}
              onChange={(event) => setPricingApplyRuleSetId(event.target.value)}
            >
              <option value="">-- оберіть --</option>
              {markupRuleSets.map((ruleSet) => (
                <option key={ruleSet.id} value={ruleSet.id}>
                  #{ruleSet.id} {ruleSet.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label>Scope</label>
            <select value={pricingApplyScope} onChange={(event) => setPricingApplyScope(event.target.value)}>
              <option value="suppliers">suppliers (selected)</option>
              <option value="all_suppliers">all_suppliers</option>
            </select>
          </div>
          <div>
            <label>&nbsp;</label>
            <div className="actions">
              <button className="btn" disabled={isReadOnly} onClick={applyMarkupRuleSet}>
                Apply
              </button>
              <button
                className="btn"
                disabled={isReadOnly || !pricingApplyRuleSetId}
                onClick={() => setDefaultMarkupRuleSet(pricingApplyRuleSetId)}
              >
                Set default
              </button>
              <button className="btn" onClick={startCreateRuleSet}>
                New rule set
              </button>
            </div>
          </div>
        </div>
        <div className="status-line">global_rule_set_id: {globalRuleSetId || '-'}</div>
        {pricingApplyScope === 'all_suppliers' ? (
          <div className="preflight-warning">
            Scope `all_suppliers` запускає preflight keyword-підтвердження.
          </div>
        ) : null}
        <div className="status-line">{pricingStatus}</div>
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Name</th>
              <th>Active</th>
              <th>Conditions</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {markupRuleSets.map((ruleSet) => (
              <tr key={ruleSet.id}>
                <td>{ruleSet.id}</td>
                <td>
                  {ruleSet.name}
                  {Number(globalRuleSetId || 0) === Number(ruleSet.id) ? (
                    <span className="chip">default</span>
                  ) : null}
                </td>
                <td>{ruleSet.is_active ? 'true' : 'false'}</td>
                <td>{Array.isArray(ruleSet.conditions) ? ruleSet.conditions.length : 0}</td>
                <td>
                  <div className="actions">
                    <button className="btn" onClick={() => startEditRuleSet(ruleSet.id)}>
                      Edit in form
                    </button>
                    <button className="btn" onClick={() => setPricingApplyRuleSetId(String(ruleSet.id))}>
                      Select
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section
        title={ruleSetDraft.id ? `Rule Set #${ruleSetDraft.id}` : 'Створення Rule Set'}
        subtitle="Повний editor conditions для create/update"
      >
        <div className="form-row">
          <div>
            <label>Name</label>
            <input
              value={ruleSetDraft.name}
              onChange={(event) => setRuleSetDraft((prev) => ({ ...prev, name: event.target.value }))}
            />
            {ruleSetErrors.base ? <div className="field-error">{ruleSetErrors.base}</div> : null}
          </div>
          <div>
            <label>
              <input
                type="checkbox"
                checked={ruleSetDraft.is_active}
                onChange={(event) =>
                  setRuleSetDraft((prev) => ({ ...prev, is_active: event.target.checked }))
                }
                style={{ width: 'auto', marginRight: 8 }}
              />
              is_active
            </label>
          </div>
        </div>

        <div className="conditions-list">
          {ruleSetDraft.conditions.map((condition, index) => (
            <div className="condition-card" key={`condition_${index}`}>
              <div className="condition-title">Condition #{index + 1}</div>
              {ruleSetErrors[`condition_${index}`] ? (
                <div className="field-error">{ruleSetErrors[`condition_${index}`]}</div>
              ) : null}
              <div className="form-row">
                <div>
                  <label>priority</label>
                  <input
                    value={condition.priority}
                    onChange={(event) => updateRuleCondition(index, { priority: event.target.value })}
                  />
                </div>
                <div>
                  <label>price_from</label>
                  <input
                    value={condition.price_from}
                    onChange={(event) => updateRuleCondition(index, { price_from: event.target.value })}
                  />
                </div>
                <div>
                  <label>price_to (optional)</label>
                  <input
                    value={condition.price_to}
                    onChange={(event) => updateRuleCondition(index, { price_to: event.target.value })}
                  />
                </div>
                <div>
                  <label>action_type</label>
                  <select
                    value={condition.action_type}
                    onChange={(event) => updateRuleCondition(index, { action_type: event.target.value })}
                  >
                    <option value="percent">percent</option>
                    <option value="fixed_add">fixed_add</option>
                  </select>
                </div>
                <div>
                  <label>action_value</label>
                  <input
                    value={condition.action_value}
                    onChange={(event) => updateRuleCondition(index, { action_value: event.target.value })}
                  />
                </div>
              </div>
              <div className="actions">
                <label>
                  <input
                    type="checkbox"
                    checked={condition.is_active}
                    onChange={(event) => updateRuleCondition(index, { is_active: event.target.checked })}
                    style={{ width: 'auto', marginRight: 8 }}
                  />
                  is_active
                </label>
                <button
                  className="btn danger"
                  disabled={ruleSetDraft.conditions.length <= 1}
                  onClick={() => removeRuleCondition(index)}
                >
                  Remove condition
                </button>
              </div>
            </div>
          ))}
        </div>

        <div className="actions" style={{ marginTop: 10 }}>
          <button className="btn" onClick={addRuleCondition}>Add condition</button>
          <button className="btn primary" disabled={isReadOnly} onClick={saveRuleSet}>
            {ruleSetDraft.id ? 'Update rule set' : 'Create rule set'}
          </button>
          <button className="btn" onClick={startCreateRuleSet}>Reset editor</button>
        </div>
        <div className={`status-line ${ruleSetStatus.includes('invalid') ? 'error' : ''}`}>
          {ruleSetStatus}
        </div>
      </Section>

      <Section title="Price Overrides" subtitle="Upsert/update для фінальної ціни">
        <div className="form-row">
          <div>
            <label>search</label>
            <input
              value={priceOverrideFilters.search}
              onChange={(event) =>
                setPriceOverrideFilters((prev) => ({ ...prev, search: event.target.value }))
              }
            />
          </div>
          <div>
            <label>limit</label>
            <input
              value={priceOverrideFilters.limit}
              onChange={(event) =>
                setPriceOverrideFilters((prev) => ({ ...prev, limit: event.target.value }))
              }
            />
          </div>
          <div>
            <label>offset</label>
            <input
              value={priceOverrideFilters.offset}
              onChange={(event) =>
                setPriceOverrideFilters((prev) => ({ ...prev, offset: event.target.value }))
              }
            />
          </div>
        </div>
        <div className="actions">
          <button className="btn" onClick={refreshPriceOverrides}>Reload overrides</button>
        </div>

        <div className="form-row" style={{ marginTop: 10 }}>
          <div>
            <label>article</label>
            <input
              value={priceOverrideDraft.article}
              onChange={(event) =>
                setPriceOverrideDraft((prev) => ({ ...prev, article: event.target.value }))
              }
              disabled={Boolean(priceOverrideDraft.id)}
            />
            {priceOverrideErrors.article ? <div className="field-error">{priceOverrideErrors.article}</div> : null}
          </div>
          <div>
            <label>size</label>
            <input
              value={priceOverrideDraft.size}
              onChange={(event) => setPriceOverrideDraft((prev) => ({ ...prev, size: event.target.value }))}
              disabled={Boolean(priceOverrideDraft.id)}
            />
          </div>
          <div>
            <label>price_final</label>
            <input
              value={priceOverrideDraft.price_final}
              onChange={(event) =>
                setPriceOverrideDraft((prev) => ({ ...prev, price_final: event.target.value }))
              }
            />
            {priceOverrideErrors.price_final ? (
              <div className="field-error">{priceOverrideErrors.price_final}</div>
            ) : null}
          </div>
        </div>
        <div className="form-row">
          <div>
            <label>notes</label>
            <input
              value={priceOverrideDraft.notes}
              onChange={(event) => setPriceOverrideDraft((prev) => ({ ...prev, notes: event.target.value }))}
            />
          </div>
          <div>
            <label>
              <input
                type="checkbox"
                checked={priceOverrideDraft.is_active}
                onChange={(event) =>
                  setPriceOverrideDraft((prev) => ({ ...prev, is_active: event.target.checked }))
                }
                style={{ width: 'auto', marginRight: 8 }}
              />
              is_active
            </label>
          </div>
        </div>
        <div className="actions">
          <button className="btn primary" disabled={isReadOnly} onClick={savePriceOverride}>
            {priceOverrideDraft.id ? 'Update override' : 'Upsert override'}
          </button>
          <button
            className="btn"
            onClick={() => {
              setPriceOverrideDraft(toPriceOverrideDraft(null));
              setPriceOverrideErrors({});
            }}
          >
            Reset override form
          </button>
        </div>

        <div className="status-line">{priceOverrideStatus}</div>
        <div className="status-line">{priceOverrides.status}</div>

        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Article</th>
              <th>Size</th>
              <th>Price final</th>
              <th>Active</th>
              <th>Notes</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {priceOverrides.rows.map((row) => (
              <tr key={row.id}>
                <td>{row.id}</td>
                <td>{row.article}</td>
                <td>{row.size || '-'}</td>
                <td>{row.price_final}</td>
                <td>{row.is_active ? 'true' : 'false'}</td>
                <td>{row.notes || '-'}</td>
                <td>
                  <button
                    className="btn"
                    onClick={() => {
                      setPriceOverrideDraft(toPriceOverrideDraft(row));
                      setPriceOverrideErrors({});
                    }}
                  >
                    Edit
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
    </div>
  );
}
