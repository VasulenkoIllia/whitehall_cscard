import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Section, Tag } from '../components/ui';

const toFiniteNumber = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const formatNumeric = (value) => {
  const numeric = toFiniteNumber(value);
  if (numeric === null) return '-';
  return Number.isInteger(numeric) ? String(numeric) : numeric.toFixed(2);
};

const formatRangeLabel = (condition) => {
  const from = toFiniteNumber(condition?.price_from);
  const to = toFiniteNumber(condition?.price_to);
  if (from === null && to === null) return 'без діапазону';
  if (from !== null && to !== null) return `${formatNumeric(from)} - ${formatNumeric(to)}`;
  if (from !== null) return `від ${formatNumeric(from)}`;
  return `до ${formatNumeric(to)}`;
};

const formatActionLabel = (condition) => {
  const actionType = String(condition?.action_type || '').trim();
  const actionValue = toFiniteNumber(condition?.action_value);
  if (actionValue === null) return actionType || '-';
  if (actionType === 'percent') return `${actionValue >= 0 ? '+' : ''}${formatNumeric(actionValue)}%`;
  if (actionType === 'fixed_add') return `${actionValue >= 0 ? '+' : ''}${formatNumeric(actionValue)} грн`;
  return `${actionType}: ${formatNumeric(actionValue)}`;
};

const formatIntervalLabel = (priceFrom, priceTo) => {
  if (!Number.isFinite(priceFrom)) return '[?; ?)';
  if (priceTo === null || !Number.isFinite(priceTo)) return `[${formatNumeric(priceFrom)}; +∞)`;
  return `[${formatNumeric(priceFrom)}; ${formatNumeric(priceTo)})`;
};

const detectRuleSetDraftConflicts = (draftConditions) => {
  if (!Array.isArray(draftConditions) || draftConditions.length === 0) {
    return { duplicatePriorities: [], overlaps: [] };
  }
  const activeRows = draftConditions
    .map((condition, index) => {
      const priority = Number(condition?.priority);
      const priceFrom = Number(condition?.price_from);
      const priceToRaw = String(condition?.price_to ?? '').trim();
      const priceTo = priceToRaw === '' ? null : Number(priceToRaw);
      return {
        row: index + 1,
        priority,
        priceFrom,
        priceTo,
        active: condition?.is_active !== false,
        valid:
          Number.isFinite(priority) &&
          Number.isFinite(priceFrom) && priceFrom >= 0 &&
          (priceTo === null || (Number.isFinite(priceTo) && priceTo >= priceFrom))
      };
    })
    .filter((item) => item.active && item.valid);

  const duplicatePriorities = [];
  const priorityMap = new Map();
  for (const item of activeRows) {
    const key = Math.trunc(item.priority);
    if (!priorityMap.has(key)) { priorityMap.set(key, [item.row]); }
    else { priorityMap.get(key).push(item.row); }
  }
  for (const [priority, rows] of priorityMap.entries()) {
    if (rows.length > 1) duplicatePriorities.push({ priority, rows });
  }

  const overlaps = [];
  for (let l = 0; l < activeRows.length; l += 1) {
    for (let r = l + 1; r < activeRows.length; r += 1) {
      const left = activeRows[l];
      const right = activeRows[r];
      const leftTo = left.priceTo === null ? Number.POSITIVE_INFINITY : left.priceTo;
      const rightTo = right.priceTo === null ? Number.POSITIVE_INFINITY : right.priceTo;
      if (left.priceFrom < rightTo && right.priceFrom < leftTo) {
        overlaps.push({
          leftRow: left.row, rightRow: right.row,
          leftRange: formatIntervalLabel(left.priceFrom, left.priceTo),
          rightRange: formatIntervalLabel(right.priceFrom, right.priceTo)
        });
      }
    }
  }

  return { duplicatePriorities, overlaps };
};

export function PricingTab({
  refreshMarkupRuleSets,
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
  ruleSetStatus
}) {
  const [ruleSetSearch, setRuleSetSearch] = useState('');
  const [isRuleSetModalOpen, setRuleSetModalOpen] = useState(false);
  const previousRuleSetStatusRef = useRef('');

  const normalizedRuleSets = Array.isArray(markupRuleSets) ? markupRuleSets : [];
  const defaultRuleSet = useMemo(
    () => normalizedRuleSets.find((rs) => Number(rs?.id || 0) === Number(globalRuleSetId || 0)) || null,
    [normalizedRuleSets, globalRuleSetId]
  );
  const defaultRuleSetConditions = useMemo(() => {
    if (!defaultRuleSet || !Array.isArray(defaultRuleSet.conditions)) return [];
    return [...defaultRuleSet.conditions].sort((a, b) => Number(a?.priority || 0) - Number(b?.priority || 0));
  }, [defaultRuleSet]);
  const activeDefaultConditions = useMemo(
    () => defaultRuleSetConditions.filter((c) => c?.is_active !== false),
    [defaultRuleSetConditions]
  );

  const filteredRuleSets = useMemo(() => {
    let rows = [...normalizedRuleSets];
    const q = String(ruleSetSearch || '').trim().toLowerCase();
    if (q) {
      rows = rows.filter((rs) =>
        `${String(rs?.name || '')} ${String(rs?.id || '')}`.toLowerCase().includes(q)
      );
    }
    return rows;
  }, [normalizedRuleSets, ruleSetSearch]);

  const ruleSetDraftConflicts = useMemo(
    () => detectRuleSetDraftConflicts(ruleSetDraft?.conditions),
    [ruleSetDraft?.conditions]
  );
  const hasBlockingDraftConflicts =
    ruleSetDraftConflicts.duplicatePriorities.length > 0 ||
    ruleSetDraftConflicts.overlaps.length > 0;

  const openCreateRuleSetModal = () => { startCreateRuleSet(); setRuleSetModalOpen(true); };
  const openEditRuleSetModal = (id) => { startEditRuleSet(id); setRuleSetModalOpen(true); };
  const closeRuleSetModal = () => setRuleSetModalOpen(false);

  useEffect(() => {
    const status = String(ruleSetStatus || '').toLowerCase();
    const wasSaved = previousRuleSetStatusRef.current.includes('rule set збережено');
    if (isRuleSetModalOpen && status.includes('rule set збережено') && !wasSaved) closeRuleSetModal();
    previousRuleSetStatusRef.current = status;
  }, [isRuleSetModalOpen, ruleSetStatus]);

  const isErrorStatus = (value) => /(error|invalid|failed|помилка)/i.test(String(value || ''));

  return (
    <div className="data-grid">
      <Section title="Типи націнки">

        {/* Default rule set preview */}
        <div className="pricing-kpi-grid">
          <div className="pricing-kpi-card">
            <div className="pricing-kpi-label">Основний тип</div>
            <div className="pricing-kpi-value">
              {defaultRuleSet ? `#${defaultRuleSet.id} ${defaultRuleSet.name}` : `#${globalRuleSetId || '—'}`}
            </div>
            <div className="pricing-kpi-meta">
              {defaultRuleSet ? (
                <>
                  <Tag tone={defaultRuleSet.is_active ? 'ok' : 'warn'}>
                    {defaultRuleSet.is_active ? 'Активний' : 'Призупинено'}
                  </Tag>
                  <span className="muted">Умов: {activeDefaultConditions.length}/{defaultRuleSetConditions.length}</span>
                </>
              ) : (
                <span className="muted">Тип не знайдено в списку</span>
              )}
            </div>
          </div>

          <div className="pricing-kpi-card pricing-kpi-rules-card">
            <div className="pricing-kpi-label">Як формується ціна</div>
            {activeDefaultConditions.length === 0 ? (
              <div className="muted pricing-kpi-empty">Немає активних умов</div>
            ) : (
              <div className="pricing-default-rules">
                {activeDefaultConditions.map((condition, index) => (
                  <div key={`default_condition_${condition.id || index}`} className="pricing-default-rule">
                    <span className="pricing-default-rule-priority">#{Number(condition.priority || 0)}</span>
                    <span>{formatRangeLabel(condition)} → {formatActionLabel(condition)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Toolbar */}
        <div className="pricing-toolbar">
          <div className="pricing-toolbar-search">
            <input
              placeholder="Пошук типу націнки..."
              value={ruleSetSearch}
              onChange={(e) => setRuleSetSearch(e.target.value)}
            />
          </div>
          <div className="actions pricing-toolbar-actions">
            <button className="btn" onClick={refreshMarkupRuleSets}>Оновити</button>
            <button className="btn primary" disabled={isReadOnly} onClick={openCreateRuleSetModal}>
              + Новий тип
            </button>
          </div>
        </div>

        {/* Table */}
        <div className="pricing-table-wrap">
          <table className="pricing-table">
            <thead>
              <tr>
                <th>Тип націнки</th>
                <th>Стан</th>
                <th>Умов</th>
                <th style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>Дії</th>
              </tr>
            </thead>
            <tbody>
              {filteredRuleSets.length === 0 ? (
                <tr>
                  <td colSpan={4} className="supplier-empty-row">Нічого не знайдено</td>
                </tr>
              ) : (
                filteredRuleSets.map((rs) => {
                  const isDefault = Number(globalRuleSetId || 0) === Number(rs.id);
                  return (
                    <tr key={rs.id}>
                      <td>
                        <div className="supplier-name-cell">
                          <div className="supplier-name-title">#{rs.id} {rs.name}</div>
                          {isDefault ? <span className="rule-set-pill">основний</span> : null}
                        </div>
                      </td>
                      <td>
                        <Tag tone={rs.is_active ? 'ok' : 'warn'}>
                          {rs.is_active ? 'Активний' : 'Призупинено'}
                        </Tag>
                      </td>
                      <td>{Array.isArray(rs.conditions) ? rs.conditions.length : 0}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <div className="actions" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                          <button className="btn btn-sm" onClick={() => openEditRuleSetModal(rs.id)}>
                            Редагувати
                          </button>
                          {!isDefault ? (
                            <button
                              className="btn btn-sm"
                              disabled={isReadOnly}
                              onClick={() => setDefaultMarkupRuleSet(String(rs.id))}
                            >
                              Зробити основним
                            </button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <div className={`status-line ${isErrorStatus(pricingStatus) ? 'error' : ''}`}>
          Показано: {filteredRuleSets.length}
          {pricingStatus ? ` · ${pricingStatus}` : ''}
        </div>
      </Section>

      {/* Rule set editor modal */}
      {isRuleSetModalOpen ? (
        <div className="modal-backdrop" onClick={closeRuleSetModal}>
          <div className="modal-card modal-card-wide pricing-modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="section-head">
              <div>
                <h3>{ruleSetDraft.id ? `Редагування типу #${ruleSetDraft.id}` : 'Новий тип націнки'}</h3>
                <p className="muted">
                  Діапазон: <strong>[Ціна від; Ціна до)</strong> — права межа не включається.
                  Приклад: 500–1000 і 1000–2000 не перетинаються.
                </p>
              </div>
              <button className="btn" onClick={closeRuleSetModal}>Закрити</button>
            </div>

            <div className="form-row pricing-modal-head-grid">
              <div>
                <label>Назва</label>
                <input
                  value={ruleSetDraft.name}
                  onChange={(e) => setRuleSetDraft((prev) => ({ ...prev, name: e.target.value }))}
                />
                {ruleSetErrors.base ? <div className="field-error">{ruleSetErrors.base}</div> : null}
              </div>
              <div className="pricing-modal-rule-set-active">
                <label className="inline-checkbox">
                  <input
                    type="checkbox"
                    checked={ruleSetDraft.is_active}
                    onChange={(e) => setRuleSetDraft((prev) => ({ ...prev, is_active: e.target.checked }))}
                  />
                  Тип активний
                </label>
              </div>
            </div>

            {hasBlockingDraftConflicts ? (
              <div className="pricing-conflicts-box">
                {ruleSetDraftConflicts.duplicatePriorities.map((item, index) => (
                  <div key={`priority_conflict_${index}`} className="field-error">
                    Дубль пріоритету {item.priority} в умовах #{item.rows.join(', #')}
                  </div>
                ))}
                {ruleSetDraftConflicts.overlaps.map((item, index) => (
                  <div key={`range_conflict_${index}`} className="field-error">
                    Перетин: умова #{item.leftRow} {item.leftRange} і #{item.rightRow} {item.rightRange}
                  </div>
                ))}
              </div>
            ) : null}

            <div className="pricing-conditions-scroll">
              <div className="pricing-conditions-table">
                <div className="pricing-conditions-header">
                  <div>#</div>
                  <div>Пріоритет</div>
                  <div>Ціна від</div>
                  <div>Ціна до</div>
                  <div>Тип дії</div>
                  <div>Значення</div>
                  <div>Активна</div>
                  <div></div>
                </div>

                {ruleSetDraft.conditions.map((condition, index) => (
                  <div className="pricing-conditions-row" key={`pricing_condition_${index}`}>
                    <div className="pricing-conditions-row-grid">
                      <div className="pricing-condition-index">#{index + 1}</div>
                      <input
                        value={condition.priority}
                        onChange={(e) => updateRuleCondition(index, { priority: e.target.value })}
                      />
                      <input
                        value={condition.price_from}
                        onChange={(e) => updateRuleCondition(index, { price_from: e.target.value })}
                      />
                      <input
                        value={condition.price_to}
                        onChange={(e) => updateRuleCondition(index, { price_to: e.target.value })}
                        placeholder="∞"
                      />
                      <select
                        value={condition.action_type}
                        onChange={(e) => updateRuleCondition(index, { action_type: e.target.value })}
                      >
                        <option value="percent">Відсоток (%)</option>
                        <option value="fixed_add">Фіксована (грн)</option>
                      </select>
                      <input
                        value={condition.action_value}
                        onChange={(e) => updateRuleCondition(index, { action_value: e.target.value })}
                      />
                      <label className="inline-checkbox pricing-condition-active-toggle">
                        <input
                          type="checkbox"
                          checked={condition.is_active}
                          onChange={(e) => updateRuleCondition(index, { is_active: e.target.checked })}
                        />
                        Так
                      </label>
                      <button
                        className="btn btn-sm danger"
                        disabled={ruleSetDraft.conditions.length <= 1}
                        onClick={() => removeRuleCondition(index)}
                      >
                        ×
                      </button>
                    </div>
                    {ruleSetErrors[`condition_${index}`] ? (
                      <div className="field-error pricing-condition-error">
                        {ruleSetErrors[`condition_${index}`]}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>

            <div className="actions pricing-modal-actions">
              <button className="btn" onClick={addRuleCondition}>+ Додати умову</button>
              <button className="btn primary" disabled={isReadOnly || hasBlockingDraftConflicts} onClick={saveRuleSet}>
                {ruleSetDraft.id ? 'Зберегти' : 'Створити'}
              </button>
            </div>

            <div className={`status-line ${isErrorStatus(ruleSetStatus) ? 'error' : ''}`}>
              {ruleSetStatus}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
