import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Section, Tag } from '../components/ui';

const toFiniteNumber = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const formatNumeric = (value) => {
  const numeric = toFiniteNumber(value);
  if (numeric === null) {
    return '-';
  }
  return Number.isInteger(numeric) ? String(numeric) : numeric.toFixed(2);
};

const formatRangeLabel = (condition) => {
  const from = toFiniteNumber(condition?.price_from);
  const to = toFiniteNumber(condition?.price_to);
  if (from === null && to === null) {
    return 'без діапазону';
  }
  if (from !== null && to !== null) {
    return `${formatNumeric(from)} - ${formatNumeric(to)}`;
  }
  if (from !== null) {
    return `від ${formatNumeric(from)}`;
  }
  return `до ${formatNumeric(to)}`;
};

const formatActionLabel = (condition) => {
  const actionType = String(condition?.action_type || '').trim();
  const actionValue = toFiniteNumber(condition?.action_value);
  if (actionValue === null) {
    return actionType || '-';
  }
  if (actionType === 'percent') {
    return `${actionValue >= 0 ? '+' : ''}${formatNumeric(actionValue)}%`;
  }
  if (actionType === 'fixed_add') {
    return `${actionValue >= 0 ? '+' : ''}${formatNumeric(actionValue)} грн`;
  }
  return `${actionType}: ${formatNumeric(actionValue)}`;
};

const formatIntervalLabel = (priceFrom, priceTo) => {
  if (!Number.isFinite(priceFrom)) {
    return '[?; ?)';
  }
  if (priceTo === null || !Number.isFinite(priceTo)) {
    return `[${formatNumeric(priceFrom)}; +∞)`;
  }
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
      const hasValidPriority = Number.isFinite(priority);
      const hasValidFrom = Number.isFinite(priceFrom) && priceFrom >= 0;
      const hasValidTo =
        priceTo === null || (Number.isFinite(priceTo) && priceTo >= priceFrom);
      return {
        row: index + 1,
        priority,
        priceFrom,
        priceTo,
        active: condition?.is_active !== false,
        valid: hasValidPriority && hasValidFrom && hasValidTo
      };
    })
    .filter((item) => item.active && item.valid);

  const duplicatePriorities = [];
  const priorityMap = new Map();
  for (let index = 0; index < activeRows.length; index += 1) {
    const item = activeRows[index];
    const key = Math.trunc(item.priority);
    if (!priorityMap.has(key)) {
      priorityMap.set(key, [item.row]);
    } else {
      priorityMap.get(key).push(item.row);
    }
  }
  for (const [priority, rows] of priorityMap.entries()) {
    if (rows.length > 1) {
      duplicatePriorities.push({
        priority,
        rows
      });
    }
  }

  const overlaps = [];
  for (let leftIndex = 0; leftIndex < activeRows.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < activeRows.length; rightIndex += 1) {
      const left = activeRows[leftIndex];
      const right = activeRows[rightIndex];
      const leftTo = left.priceTo === null ? Number.POSITIVE_INFINITY : left.priceTo;
      const rightTo = right.priceTo === null ? Number.POSITIVE_INFINITY : right.priceTo;
      const intersects = left.priceFrom < rightTo && right.priceFrom < leftTo;
      if (!intersects) {
        continue;
      }
      overlaps.push({
        leftRow: left.row,
        rightRow: right.row,
        leftRange: formatIntervalLabel(left.priceFrom, left.priceTo),
        rightRange: formatIntervalLabel(right.priceFrom, right.priceTo)
      });
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
    () =>
      normalizedRuleSets.find((ruleSet) => Number(ruleSet?.id || 0) === Number(globalRuleSetId || 0)) ||
      null,
    [normalizedRuleSets, globalRuleSetId]
  );
  const defaultRuleSetConditions = useMemo(() => {
    if (!defaultRuleSet || !Array.isArray(defaultRuleSet.conditions)) {
      return [];
    }
    return [...defaultRuleSet.conditions].sort(
      (left, right) => Number(left?.priority || 0) - Number(right?.priority || 0)
    );
  }, [defaultRuleSet]);
  const activeDefaultConditions = useMemo(
    () => defaultRuleSetConditions.filter((condition) => condition?.is_active !== false),
    [defaultRuleSetConditions]
  );

  const filteredRuleSets = useMemo(() => {
    let rows = [...normalizedRuleSets];
    const normalizedSearch = String(ruleSetSearch || '').trim().toLowerCase();
    if (normalizedSearch) {
      rows = rows.filter((ruleSet) =>
        `${String(ruleSet?.name || '')} ${String(ruleSet?.id || '')}`
          .toLowerCase()
          .includes(normalizedSearch)
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

  const openCreateRuleSetModal = () => {
    startCreateRuleSet();
    setRuleSetModalOpen(true);
  };

  const openEditRuleSetModal = (ruleSetId) => {
    startEditRuleSet(ruleSetId);
    setRuleSetModalOpen(true);
  };

  const closeRuleSetModal = () => {
    setRuleSetModalOpen(false);
  };

  useEffect(() => {
    const normalized = String(ruleSetStatus || '').toLowerCase();
    const wasSaved = previousRuleSetStatusRef.current.includes('rule set збережено');
    const isSavedNow = normalized.includes('rule set збережено');
    if (isRuleSetModalOpen && isSavedNow && !wasSaved) {
      setRuleSetModalOpen(false);
    }
    previousRuleSetStatusRef.current = normalized;
  }, [isRuleSetModalOpen, ruleSetStatus]);

  return (
    <div className="data-grid">
      <Section title="Типи націнки (Rule Sets)" subtitle="Список типів націнки та керування default">
        <div className="pricing-kpi-grid">
          <div className="pricing-kpi-card">
            <div className="pricing-kpi-label">Поточний default rule set</div>
            <div className="pricing-kpi-value">
              {defaultRuleSet ? `#${defaultRuleSet.id} ${defaultRuleSet.name}` : `#${globalRuleSetId || '-'}`}
            </div>
            <div className="pricing-kpi-meta">
              {defaultRuleSet ? (
                <>
                  <Tag tone={defaultRuleSet.is_active ? 'ok' : 'warn'}>
                    {defaultRuleSet.is_active ? 'active' : 'paused'}
                  </Tag>
                  <span className="muted">
                    Умов: {activeDefaultConditions.length}/{defaultRuleSetConditions.length}
                  </span>
                </>
              ) : (
                'Rule set не знайдено в списку'
              )}
            </div>
          </div>

          <div className="pricing-kpi-card pricing-kpi-rules-card">
            <div className="pricing-kpi-label">Як формується ціна по default</div>
            {activeDefaultConditions.length === 0 ? (
              <div className="muted pricing-kpi-empty">Немає активних умов для відображення</div>
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

        <div className="pricing-toolbar">
          <div className="pricing-toolbar-search">
            <input
              placeholder="Пошук типу націнки..."
              value={ruleSetSearch}
              onChange={(event) => setRuleSetSearch(event.target.value)}
            />
          </div>
          <div className="actions pricing-toolbar-actions">
            <button className="btn" onClick={refreshMarkupRuleSets}>Оновити список</button>
            <button className="btn primary" disabled={isReadOnly} onClick={openCreateRuleSetModal}>
              Новий тип націнки
            </button>
          </div>
        </div>

        <div className="pricing-table-wrap">
          <table className="pricing-table">
            <thead>
              <tr>
                <th>Rule set</th>
                <th>Стан</th>
                <th>Умов</th>
                <th>Дії</th>
              </tr>
            </thead>
            <tbody>
              {filteredRuleSets.length === 0 ? (
                <tr>
                  <td colSpan={4} className="supplier-empty-row">
                    Нічого не знайдено
                  </td>
                </tr>
              ) : (
                filteredRuleSets.map((ruleSet) => {
                  const isCurrentDefault = Number(globalRuleSetId || 0) === Number(ruleSet.id);
                  return (
                    <tr key={ruleSet.id}>
                      <td>
                        <div className="supplier-name-cell">
                          <div className="supplier-name-title">
                            #{ruleSet.id} {ruleSet.name}
                          </div>
                          {isCurrentDefault ? (
                            <div>
                              <span className="chip">default</span>
                            </div>
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
                          <button className="btn" onClick={() => openEditRuleSetModal(ruleSet.id)}>
                            Редагувати
                          </button>
                          {!isCurrentDefault ? (
                            <button
                              className="btn"
                              disabled={isReadOnly}
                              onClick={() => setDefaultMarkupRuleSet(String(ruleSet.id))}
                            >
                              Зробити default
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

        <div className="status-line">Показано: {filteredRuleSets.length}</div>
        <div className={`status-line ${/(error|invalid|failed|помилка)/i.test(String(pricingStatus || '')) ? 'error' : ''}`}>
          {pricingStatus}
        </div>
      </Section>

      {isRuleSetModalOpen ? (
        <div className="modal-backdrop" onClick={closeRuleSetModal}>
          <div className="modal-card modal-card-wide pricing-modal-card" onClick={(event) => event.stopPropagation()}>
            <div className="section-head">
              <div>
                <h3>{ruleSetDraft.id ? `Редагування rule set #${ruleSetDraft.id}` : 'Новий тип націнки'}</h3>
                <p className="muted">Налаштування діапазонів і дій націнки</p>
              </div>
              <button className="btn" onClick={closeRuleSetModal}>Закрити</button>
            </div>

            <div className="pricing-rule-guidelines">
              Формат діапазону: <strong>[Ціна від; Ціна до)</strong>. Межа <strong>Ціна до</strong> не включається.
              Приклад: <strong>500-1000</strong> і <strong>1000-2000</strong> не перетинаються.
            </div>

            <div className="form-row pricing-modal-head-grid">
              <div>
                <label>Назва</label>
                <input
                  value={ruleSetDraft.name}
                  onChange={(event) => setRuleSetDraft((prev) => ({ ...prev, name: event.target.value }))}
                />
                {ruleSetErrors.base ? <div className="field-error">{ruleSetErrors.base}</div> : null}
              </div>
              <div className="pricing-modal-rule-set-active">
                <label className="inline-checkbox">
                  <input
                    type="checkbox"
                    checked={ruleSetDraft.is_active}
                    onChange={(event) =>
                      setRuleSetDraft((prev) => ({ ...prev, is_active: event.target.checked }))
                    }
                  />
                  Rule set активний
                </label>
              </div>
            </div>

            {hasBlockingDraftConflicts ? (
              <div className="pricing-conflicts-box">
                {ruleSetDraftConflicts.duplicatePriorities.map((item, index) => (
                  <div key={`priority_conflict_${index}`} className="field-error">
                    Дубль priority {item.priority} в умовах #{item.rows.join(', #')}. Для активних умов priority має бути унікальним.
                  </div>
                ))}
                {ruleSetDraftConflicts.overlaps.map((item, index) => (
                  <div key={`range_conflict_${index}`} className="field-error">
                    Перетин діапазонів: умова #{item.leftRow} {item.leftRange} і умова #{item.rightRow} {item.rightRange}.
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
                  <div>Ціна до (не вкл.)</div>
                  <div>Тип дії</div>
                  <div>Значення дії</div>
                  <div>Активна</div>
                  <div>Дія</div>
                </div>

                {ruleSetDraft.conditions.map((condition, index) => (
                  <div className="pricing-conditions-row" key={`pricing_condition_${index}`}>
                    <div className="pricing-conditions-row-grid">
                      <div className="pricing-condition-index">#{index + 1}</div>
                      <input
                        value={condition.priority}
                        onChange={(event) => updateRuleCondition(index, { priority: event.target.value })}
                      />
                      <input
                        value={condition.price_from}
                        onChange={(event) => updateRuleCondition(index, { price_from: event.target.value })}
                      />
                      <input
                        value={condition.price_to}
                        onChange={(event) => updateRuleCondition(index, { price_to: event.target.value })}
                        placeholder="порожньо = +∞"
                      />
                      <select
                        value={condition.action_type}
                        onChange={(event) => updateRuleCondition(index, { action_type: event.target.value })}
                      >
                        <option value="percent">percent</option>
                        <option value="fixed_add">fixed_add</option>
                      </select>
                      <input
                        value={condition.action_value}
                        onChange={(event) => updateRuleCondition(index, { action_value: event.target.value })}
                      />
                      <label className="inline-checkbox pricing-condition-active-toggle">
                        <input
                          type="checkbox"
                          checked={condition.is_active}
                          onChange={(event) => updateRuleCondition(index, { is_active: event.target.checked })}
                        />
                        active
                      </label>
                      <button
                        className="btn danger"
                        disabled={ruleSetDraft.conditions.length <= 1}
                        onClick={() => removeRuleCondition(index)}
                      >
                        Видалити
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
              <button className="btn" onClick={addRuleCondition}>Додати правило</button>
              <button className="btn primary" disabled={isReadOnly || hasBlockingDraftConflicts} onClick={saveRuleSet}>
                {ruleSetDraft.id ? 'Оновити rule set' : 'Створити rule set'}
              </button>
              <button className="btn" onClick={startCreateRuleSet}>Скинути редактор</button>
            </div>

            <div className={`status-line ${/(error|invalid|failed|помилка)/i.test(String(ruleSetStatus || '')) ? 'error' : ''}`}>
              {ruleSetStatus}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
