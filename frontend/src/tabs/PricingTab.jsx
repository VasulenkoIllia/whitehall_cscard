import React from 'react';
import { Section, Tag } from '../components/ui';

export function PricingTab({
  refreshMarkupRuleSets,
  pricingApplyRuleSetId,
  setPricingApplyRuleSetId,
  markupRuleSets,
  isReadOnly,
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
        title="Типи націнки (Rule Sets)"
        subtitle="Створіть правило, відредагуйте діапазони і задайте глобальний default"
        extra={
          <div className="actions">
            <button className="btn" onClick={refreshMarkupRuleSets}>Оновити список</button>
            <button className="btn primary" onClick={startCreateRuleSet}>Новий тип націнки</button>
          </div>
        }
      >
        <div className="form-row">
          <div>
            <label>Rule set для default</label>
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
            <label>&nbsp;</label>
            <div className="actions">
              <button
                className="btn"
                disabled={isReadOnly || !pricingApplyRuleSetId}
                onClick={() => setDefaultMarkupRuleSet(pricingApplyRuleSetId)}
              >
                Зробити default
              </button>
            </div>
          </div>
        </div>
        <div className="status-line">Поточний default rule set: #{globalRuleSetId || '-'}</div>
        <div className="status-line">{pricingStatus}</div>

        <table>
          <thead>
            <tr>
              <th>Rule set</th>
              <th>Стан</th>
              <th>Умов</th>
              <th>Дії</th>
            </tr>
          </thead>
          <tbody>
            {markupRuleSets.map((ruleSet) => (
              <tr key={ruleSet.id}>
                <td>
                  <div>
                    #{ruleSet.id} {ruleSet.name}
                    {Number(globalRuleSetId || 0) === Number(ruleSet.id) ? (
                      <span className="chip">default</span>
                    ) : null}
                  </div>
                </td>
                <td>
                  <Tag tone={ruleSet.is_active ? 'ok' : 'warn'}>
                    {ruleSet.is_active ? 'active' : 'paused'}
                  </Tag>
                </td>
                <td>{Array.isArray(ruleSet.conditions) ? ruleSet.conditions.length : 0}</td>
                <td>
                  <div className="actions">
                    <button className="btn" onClick={() => startEditRuleSet(ruleSet.id)}>
                      Редагувати
                    </button>
                    <button
                      className="btn"
                      disabled={isReadOnly}
                      onClick={() => setDefaultMarkupRuleSet(String(ruleSet.id))}
                    >
                      Зробити default
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section
        title={ruleSetDraft.id ? `Редактор rule set #${ruleSetDraft.id}` : 'Створення нового rule set'}
        subtitle="Налаштування діапазонів і дій націнки"
      >
        <div className="form-row">
          <div>
            <label>Назва</label>
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
              Rule set активний
            </label>
          </div>
        </div>

        <div className="conditions-list">
          {ruleSetDraft.conditions.map((condition, index) => (
            <div className="condition-card" key={`condition_${index}`}>
              <div className="condition-title">Умова #{index + 1}</div>
              {ruleSetErrors[`condition_${index}`] ? (
                <div className="field-error">{ruleSetErrors[`condition_${index}`]}</div>
              ) : null}
              <div className="form-row">
                <div>
                  <label>Пріоритет</label>
                  <input
                    value={condition.priority}
                    onChange={(event) => updateRuleCondition(index, { priority: event.target.value })}
                  />
                </div>
                <div>
                  <label>Ціна від</label>
                  <input
                    value={condition.price_from}
                    onChange={(event) => updateRuleCondition(index, { price_from: event.target.value })}
                  />
                </div>
                <div>
                  <label>Ціна до (опційно)</label>
                  <input
                    value={condition.price_to}
                    onChange={(event) => updateRuleCondition(index, { price_to: event.target.value })}
                  />
                </div>
                <div>
                  <label>Тип дії</label>
                  <select
                    value={condition.action_type}
                    onChange={(event) => updateRuleCondition(index, { action_type: event.target.value })}
                  >
                    <option value="percent">percent</option>
                    <option value="fixed_add">fixed_add</option>
                  </select>
                </div>
                <div>
                  <label>Значення дії</label>
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
                  Активна умова
                </label>
                <button
                  className="btn danger"
                  disabled={ruleSetDraft.conditions.length <= 1}
                  onClick={() => removeRuleCondition(index)}
                >
                  Видалити умову
                </button>
              </div>
            </div>
          ))}
        </div>

        <div className="actions" style={{ marginTop: 10 }}>
          <button className="btn" onClick={addRuleCondition}>Додати умову</button>
          <button className="btn primary" disabled={isReadOnly} onClick={saveRuleSet}>
            {ruleSetDraft.id ? 'Оновити rule set' : 'Створити rule set'}
          </button>
          <button className="btn" onClick={startCreateRuleSet}>Скинути редактор</button>
        </div>
        <div className={`status-line ${ruleSetStatus.includes('invalid') ? 'error' : ''}`}>
          {ruleSetStatus}
        </div>
      </Section>

      <Section title="Price overrides" subtitle="Ручне перевизначення фінальної ціни">
        <details className="details-block">
          <summary>Фільтри списку override</summary>
          <div className="form-row" style={{ marginTop: 10 }}>
            <div>
              <label>Пошук</label>
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
            <button className="btn" onClick={refreshPriceOverrides}>Оновити список override</button>
          </div>
        </details>

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
              Активний override
            </label>
          </div>
        </div>
        <div className="actions">
          <button className="btn primary" disabled={isReadOnly} onClick={savePriceOverride}>
            {priceOverrideDraft.id ? 'Оновити override' : 'Створити override'}
          </button>
          <button
            className="btn"
            onClick={() => {
              setPriceOverrideDraft(toPriceOverrideDraft(null));
              setPriceOverrideErrors({});
            }}
          >
            Скинути форму
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
              <th>Стан</th>
              <th>Notes</th>
              <th>Дія</th>
            </tr>
          </thead>
          <tbody>
            {priceOverrides.rows.map((row) => (
              <tr key={row.id}>
                <td>{row.id}</td>
                <td>{row.article}</td>
                <td>{row.size || '-'}</td>
                <td>{row.price_final}</td>
                <td>
                  <Tag tone={row.is_active ? 'ok' : 'warn'}>{row.is_active ? 'active' : 'paused'}</Tag>
                </td>
                <td>{row.notes || '-'}</td>
                <td>
                  <button className="btn" onClick={() => setPriceOverrideDraft(toPriceOverrideDraft(row))}>
                    Редагувати
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
