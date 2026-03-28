import React, { useMemo, useState } from 'react';
import { Section, Tag } from '../components/ui';

const TASK_META = {
  update_pipeline: {
    title: 'Повне оновлення',
    description: 'Запускає повний цикл: знімок магазину → імпорт від постачальників → фіналізація цін → відправка змін у CS-Cart.',
    steps: ['① Знімок магазину', '② Імпорт', '③ Фіналізація', '④ Відправка']
  },
  cleanup: {
    title: 'Очищення старих даних',
    description: 'Видаляє старі технічні записи, щоб база працювала швидко. Не впливає на товари.',
    steps: null
  }
};

const WEEK_DAYS = [
  { value: 1, label: 'Пн' },
  { value: 2, label: 'Вт' },
  { value: 3, label: 'Ср' },
  { value: 4, label: 'Чт' },
  { value: 5, label: 'Пт' },
  { value: 6, label: 'Сб' },
  { value: 0, label: 'Нд' }
];

const WEEK_DAY_ORDER = new Map(WEEK_DAYS.map((item, index) => [item.value, index]));
const ALL_HOURS = Array.from({ length: 24 }, (_, index) => index);
const FIVE_RUNS_DEFAULT_HOURS = [9, 12, 15, 18, 21];

function formatDateTime(value) {
  if (!value) return '-';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleString('uk-UA');
}

function parseHourList(valueRaw) {
  const source = String(valueRaw || '').trim();
  if (!source) return [];
  const unique = new Set();
  for (const part of source.split(',')) {
    const n = Number(part.trim());
    if (Number.isFinite(n)) {
      const norm = Math.trunc(n);
      if (norm >= 0 && norm <= 23) unique.add(norm);
    }
  }
  return Array.from(unique).sort((a, b) => a - b);
}

function parseWeekDayList(valueRaw) {
  const source = String(valueRaw || '').trim();
  if (!source || source === '*') return [];
  const unique = new Set();
  for (const part of source.split(',')) {
    const n = Number(part.trim());
    if (Number.isFinite(n)) {
      const norm = Math.trunc(n) === 7 ? 0 : Math.trunc(n);
      if (norm >= 0 && norm <= 6) unique.add(norm);
    }
  }
  return Array.from(unique).sort((a, b) => {
    return (WEEK_DAY_ORDER.get(a) ?? 0) - (WEEK_DAY_ORDER.get(b) ?? 0);
  });
}

function parseSchedulePlan(task) {
  const cron = String(task?.cron || '').trim();

  const everyHours = cron.match(/^0\s+\*\/(\d+)\s+\*\s+\*\s+\*$/);
  if (everyHours) {
    const hours = Number(everyHours[1]);
    if (Number.isFinite(hours) && hours > 0) {
      return { mode: 'interval_hours', everyHours: Math.trunc(hours), hours: [], days: [] };
    }
  }

  const dailyOrWeekly = cron.match(/^0\s+([0-9]{1,2}(?:,[0-9]{1,2})*)\s+\*\s+\*\s+(\*|[0-7](?:,[0-7])*)$/);
  if (dailyOrWeekly) {
    const hours = parseHourList(dailyOrWeekly[1]);
    const dayToken = String(dailyOrWeekly[2] || '*');
    if (hours.length > 0) {
      if (dayToken === '*') return { mode: 'daily_hours', everyHours: 0, hours, days: [] };
      const days = parseWeekDayList(dayToken);
      if (days.length > 0) return { mode: 'weekly_hours', everyHours: 0, hours, days };
    }
  }

  const minutes = Math.max(1, Number(task?.interval_minutes || 60));
  const normalizedHours = minutes % 60 === 0
    ? Math.max(1, Math.trunc(minutes / 60))
    : Math.max(1, Math.ceil(minutes / 60));
  return { mode: 'interval_hours', everyHours: normalizedHours, hours: [], days: [] };
}

function toHourLabel(hour) {
  return `${String(hour).padStart(2, '0')}:00`;
}

function formatScheduleSummary(plan) {
  if (plan.mode === 'interval_hours') return `Кожні ${plan.everyHours} год`;
  if (plan.mode === 'daily_hours') return `Щодня о ${plan.hours.map(toHourLabel).join(', ')}`;
  if (plan.mode === 'weekly_hours') {
    const dayLabels = WEEK_DAYS.filter((d) => plan.days.includes(d.value)).map((d) => d.label).join(', ');
    return `${dayLabels}: ${plan.hours.map(toHourLabel).join(', ')}`;
  }
  return 'Розклад не заданий';
}

function buildCronByPlan(plan) {
  if (plan.mode === 'interval_hours') {
    const h = Math.max(1, Math.min(24, Math.trunc(Number(plan.everyHours) || 1)));
    return h === 24 ? '0 0 * * *' : `0 */${h} * * *`;
  }
  if (plan.mode === 'daily_hours') {
    const hours = parseHourList(plan.hours.join(','));
    return `0 ${(hours.length > 0 ? hours : [9]).join(',')} * * *`;
  }
  if (plan.mode === 'weekly_hours') {
    const hours = parseHourList(plan.hours.join(','));
    const days = parseWeekDayList(plan.days.join(','));
    return `0 ${(hours.length > 0 ? hours : [9]).join(',')} * * ${(days.length > 0 ? days : [1, 2, 3, 4, 5]).join(',')}`;
  }
  return '0 */3 * * *';
}

function getIntervalMinutesByPlan(plan) {
  if (plan.mode === 'interval_hours') {
    return Math.max(1, Math.min(24, Math.trunc(Number(plan.everyHours) || 1))) * 60;
  }
  return 1440;
}

// Only these two tasks shown in the UI; store_mirror_sync is now a step inside update_pipeline
const VISIBLE_TASKS = ['update_pipeline', 'cleanup'];

export function CronSettingsTab({
  cronSettingsDraft,
  cronStatus,
  cronSaving,
  isReadOnly,
  suppliers,
  refreshCronSettings,
  updateCronDraftField,
  saveCronSettings
}) {
  const supplierOptions = Array.isArray(suppliers) ? suppliers : [];
  const [hourPickerByTask, setHourPickerByTask] = useState({});

  const visibleTasks = useMemo(
    () => cronSettingsDraft.filter((t) => VISIBLE_TASKS.includes(t.name)),
    [cronSettingsDraft]
  );

  const scheduleByTask = useMemo(() => {
    const output = {};
    for (const task of cronSettingsDraft) {
      output[task.name] = parseSchedulePlan(task);
    }
    return output;
  }, [cronSettingsDraft]);

  const applyPlanToTask = (taskName, plan) => {
    updateCronDraftField(taskName, 'cron', buildCronByPlan(plan));
    updateCronDraftField(taskName, 'interval_minutes', String(getIntervalMinutesByPlan(plan)));
  };

  const addHour = (task, plan) => {
    const candidate = Number(hourPickerByTask[task.name] ?? 9);
    if (!Number.isFinite(candidate)) return;
    applyPlanToTask(task.name, { ...plan, hours: parseHourList([...plan.hours, Math.trunc(candidate)].join(',')) });
  };

  const removeHour = (task, plan, hour) => {
    const next = plan.hours.filter((h) => h !== hour);
    applyPlanToTask(task.name, { ...plan, hours: next.length > 0 ? next : [9] });
  };

  const toggleDay = (task, plan, dayValue) => {
    const exists = plan.days.includes(dayValue);
    const next = exists ? plan.days.filter((d) => d !== dayValue) : [...plan.days, dayValue];
    applyPlanToTask(task.name, { ...plan, days: next.length > 0 ? next : [1] });
  };

  return (
    <div className="data-grid">
      <Section
        title="Автоматичний розклад"
        subtitle="Налаштуйте коли запускати пайплайни. Якщо дві задачі збіглись за часом — друга просто пропуститься без помилки."
        extra={(
          <div className="actions">
            <button className="btn" onClick={refreshCronSettings}>Оновити</button>
            <button className="btn primary" disabled={isReadOnly || cronSaving} onClick={saveCronSettings}>
              {cronSaving ? 'Збереження...' : 'Зберегти'}
            </button>
          </div>
        )}
      >
        {visibleTasks.length === 0 ? (
          <div className="empty-preview">Налаштування ще не завантажені</div>
        ) : (
          <div className="cron-grid">
            {visibleTasks.map((task) => {
              const meta = TASK_META[task.name];
              const plan = scheduleByTask[task.name] || parseSchedulePlan(task);
              return (
                <div className="cron-card" key={task.name}>
                  <div className="cron-card-head">
                    <div>
                      <h4 className="block-title">{meta?.title || task.name}</h4>
                      <p className="muted">{meta?.description || ''}</p>
                    </div>
                    <Tag tone={task.is_enabled ? 'ok' : 'warn'}>
                      {task.is_enabled ? 'Увімкнено' : 'Призупинено'}
                    </Tag>
                  </div>

                  {meta?.steps ? (
                    <div className="cron-steps">
                      {meta.steps.map((step) => (
                        <span key={step} className="cron-step-badge">{step}</span>
                      ))}
                    </div>
                  ) : null}

                  <div className="cron-mode-row">
                    <div style={{ flex: '1 1 160px', minWidth: 0 }}>
                      <label>Режим розкладу</label>
                      <select
                        value={plan.mode}
                        onChange={(event) => {
                          const mode = event.target.value;
                          if (mode === 'interval_hours') {
                            applyPlanToTask(task.name, { mode, everyHours: plan.everyHours || 3, hours: [], days: [] });
                          } else if (mode === 'daily_hours') {
                            applyPlanToTask(task.name, { mode, everyHours: 0, hours: plan.hours.length > 0 ? plan.hours : [9], days: [] });
                          } else {
                            applyPlanToTask(task.name, { mode: 'weekly_hours', everyHours: 0, hours: plan.hours.length > 0 ? plan.hours : [9], days: plan.days.length > 0 ? plan.days : [1, 2, 3, 4, 5] });
                          }
                        }}
                      >
                        <option value="interval_hours">Кожні N годин</option>
                        <option value="daily_hours">Щодня у вибрані години</option>
                        <option value="weekly_hours">По днях тижня і годинах</option>
                      </select>
                    </div>

                    {plan.mode === 'interval_hours' ? (
                      <div style={{ width: 'auto', flexShrink: 0 }}>
                        <label>Кожні (годин)</label>
                        <input
                          type="number"
                          min="1"
                          max="24"
                          style={{ width: 72 }}
                          value={String(plan.everyHours || 3)}
                          onChange={(event) =>
                            applyPlanToTask(task.name, {
                              ...plan,
                              everyHours: Math.max(1, Math.min(24, Number(event.target.value || 1)))
                            })
                          }
                        />
                      </div>
                    ) : null}
                  </div>

                  {plan.mode === 'daily_hours' || plan.mode === 'weekly_hours' ? (
                    <>
                      <div className="cron-hour-builder">
                        <label>Години запуску</label>
                        <div className="actions">
                          <select
                            style={{ width: 'auto' }}
                            value={String(hourPickerByTask[task.name] ?? 9)}
                            onChange={(event) =>
                              setHourPickerByTask((prev) => ({ ...prev, [task.name]: event.target.value }))
                            }
                          >
                            {ALL_HOURS.map((hour) => (
                              <option key={`${task.name}_h_${hour}`} value={hour}>{toHourLabel(hour)}</option>
                            ))}
                          </select>
                          <button className="btn" type="button" onClick={() => addHour(task, plan)}>
                            Додати
                          </button>
                          <button
                            className="btn"
                            type="button"
                            onClick={() => applyPlanToTask(task.name, { ...plan, hours: FIVE_RUNS_DEFAULT_HOURS })}
                          >
                            5 запусків / день
                          </button>
                        </div>
                        <div className="cron-hour-chip-list">
                          {plan.hours.length > 0 ? (
                            plan.hours.map((hour) => (
                              <button
                                key={`${task.name}_sel_${hour}`}
                                type="button"
                                className="cron-hour-chip"
                                onClick={() => removeHour(task, plan, hour)}
                              >
                                {toHourLabel(hour)} ×
                              </button>
                            ))
                          ) : (
                            <span className="muted">Години не обрані</span>
                          )}
                        </div>
                      </div>

                      {plan.mode === 'weekly_hours' ? (
                        <div className="cron-weekday-picker">
                          <label>Дні тижня</label>
                          <div className="cron-weekday-list">
                            {WEEK_DAYS.map((day) => (
                              <label key={`${task.name}_wd_${day.value}`} className="cron-weekday-item">
                                <input
                                  type="checkbox"
                                  checked={plan.days.includes(day.value)}
                                  onChange={() => toggleDay(task, plan, day.value)}
                                  style={{ width: 'auto' }}
                                />
                                {day.label}
                              </label>
                            ))}
                          </div>
                        </div>
                      ) : null}
                    </>
                  ) : null}

                  <div className="cron-interval-hint">{formatScheduleSummary(plan)}</div>

                  {task.name === 'update_pipeline' ? (
                    <div>
                      <label>Постачальник (опційно)</label>
                      <select
                        value={task.supplier || ''}
                        onChange={(event) => updateCronDraftField(task.name, 'supplier', event.target.value)}
                      >
                        <option value="">Усі постачальники</option>
                        {supplierOptions.map((s) => (
                          <option key={`cron_s_${s.id}`} value={s.name}>
                            {s.name}{s.sku_prefix ? ` (SKU: ${s.sku_prefix})` : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : null}

                  <div className="checkbox-row">
                    <label>
                      <input
                        type="checkbox"
                        checked={task.is_enabled === true}
                        onChange={(event) => updateCronDraftField(task.name, 'is_enabled', event.target.checked)}
                        style={{ width: 'auto' }}
                      />
                      Виконувати автоматично
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={task.run_on_startup === true}
                        onChange={(event) => updateCronDraftField(task.name, 'run_on_startup', event.target.checked)}
                        style={{ width: 'auto' }}
                      />
                      Запускати після рестарту сервера
                    </label>
                  </div>

                  <div className="status-line">
                    Оновлено: {formatDateTime(task.updated_at)}
                  </div>

                  <details className="details-block cron-technical">
                    <summary>Технічні деталі</summary>
                    <div className="cron-tech-grid">
                      <div><label>Системне імʼя</label><code>{task.name}</code></div>
                      <div><label>Cron вираз</label><code>{task.cron || '-'}</code></div>
                    </div>
                  </details>
                </div>
              );
            })}
          </div>
        )}

        <div className={`status-line ${/(error|invalid|failed|помилка)/i.test(String(cronStatus || '')) ? 'error' : ''}`}>
          {cronStatus}
        </div>
      </Section>
    </div>
  );
}
