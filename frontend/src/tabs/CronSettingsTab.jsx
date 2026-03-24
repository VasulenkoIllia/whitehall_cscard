import React, { useMemo, useState } from 'react';
import { Section, Tag } from '../components/ui';

const TASK_META = {
  update_pipeline: {
    title: 'Оновлення каталогу',
    description: 'Імпорт джерел, фіналізація та підготовка даних до синхронізації'
  },
  store_mirror_sync: {
    title: 'Оновлення дзеркала магазину',
    description: 'Знімає актуальний стан товарів із CS-Cart у локальне дзеркало'
  },
  cleanup: {
    title: 'Очищення історії',
    description: 'Прибирає старі технічні записи, щоб база працювала швидко'
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
  if (!value) {
    return '-';
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return String(value);
  }
  return parsed.toLocaleString('uk-UA');
}

function parseHourList(valueRaw) {
  const source = String(valueRaw || '').trim();
  if (!source) {
    return [];
  }
  const unique = new Set();
  const parts = source.split(',');
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index].trim();
    const number = Number(part);
    if (!Number.isFinite(number)) {
      continue;
    }
    const normalized = Math.trunc(number);
    if (normalized >= 0 && normalized <= 23) {
      unique.add(normalized);
    }
  }
  return Array.from(unique).sort((left, right) => left - right);
}

function parseWeekDayList(valueRaw) {
  const source = String(valueRaw || '').trim();
  if (!source || source === '*') {
    return [];
  }
  const unique = new Set();
  const parts = source.split(',');
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index].trim();
    const number = Number(part);
    if (!Number.isFinite(number)) {
      continue;
    }
    const normalized = Math.trunc(number) === 7 ? 0 : Math.trunc(number);
    if (normalized >= 0 && normalized <= 6) {
      unique.add(normalized);
    }
  }
  return Array.from(unique).sort((left, right) => {
    const leftOrder = WEEK_DAY_ORDER.get(left) ?? 0;
    const rightOrder = WEEK_DAY_ORDER.get(right) ?? 0;
    return leftOrder - rightOrder;
  });
}

function parseSchedulePlan(task) {
  const cron = String(task?.cron || '').trim();
  const everyHours = cron.match(/^0\s+\*\/(\d+)\s+\*\s+\*\s+\*$/);
  if (everyHours) {
    const hours = Number(everyHours[1]);
    if (Number.isFinite(hours) && hours > 0) {
      return {
        mode: 'interval_hours',
        everyHours: Math.trunc(hours),
        hours: [],
        days: []
      };
    }
  }

  const dailyOrWeekly = cron.match(/^0\s+([0-9]{1,2}(?:,[0-9]{1,2})*)\s+\*\s+\*\s+(\*|[0-7](?:,[0-7])*)$/);
  if (dailyOrWeekly) {
    const hours = parseHourList(dailyOrWeekly[1]);
    const dayToken = String(dailyOrWeekly[2] || '*');
    if (hours.length > 0) {
      if (dayToken === '*') {
        return {
          mode: 'daily_hours',
          everyHours: 0,
          hours,
          days: []
        };
      }
      const days = parseWeekDayList(dayToken);
      if (days.length > 0) {
        return {
          mode: 'weekly_hours',
          everyHours: 0,
          hours,
          days
        };
      }
    }
  }

  const minutes = Math.max(1, Number(task?.interval_minutes || 60));
  const normalizedHours =
    minutes % 60 === 0 ? Math.max(1, Math.trunc(minutes / 60)) : Math.max(1, Math.ceil(minutes / 60));
  return {
    mode: 'interval_hours',
    everyHours: normalizedHours,
    hours: [],
    days: []
  };
}

function toHourLabel(hour) {
  return `${String(hour).padStart(2, '0')}:00`;
}

function formatScheduleSummary(plan) {
  if (plan.mode === 'interval_hours') {
    return `Запуск кожні ${plan.everyHours} год`;
  }
  if (plan.mode === 'daily_hours') {
    return `Щодня о ${plan.hours.map((hour) => toHourLabel(hour)).join(', ')}`;
  }
  if (plan.mode === 'weekly_hours') {
    const dayLabels = WEEK_DAYS.filter((day) => plan.days.includes(day.value))
      .map((day) => day.label)
      .join(', ');
    const hourLabels = plan.hours.map((hour) => toHourLabel(hour)).join(', ');
    return `${dayLabels}: ${hourLabels}`;
  }
  return 'Розклад не заданий';
}

function buildCronByPlan(plan) {
  if (plan.mode === 'interval_hours') {
    const everyHours = Math.max(1, Math.min(24, Math.trunc(Number(plan.everyHours) || 1)));
    if (everyHours === 24) {
      return '0 0 * * *';
    }
    return `0 */${everyHours} * * *`;
  }
  if (plan.mode === 'daily_hours') {
    const hours = parseHourList(plan.hours.join(','));
    const target = hours.length > 0 ? hours : [9];
    return `0 ${target.join(',')} * * *`;
  }
  if (plan.mode === 'weekly_hours') {
    const hours = parseHourList(plan.hours.join(','));
    const days = parseWeekDayList(plan.days.join(','));
    const targetHours = hours.length > 0 ? hours : [9];
    const targetDays = days.length > 0 ? days : [1, 2, 3, 4, 5];
    return `0 ${targetHours.join(',')} * * ${targetDays.join(',')}`;
  }
  return '0 */3 * * *';
}

function getIntervalMinutesByPlan(plan) {
  if (plan.mode === 'interval_hours') {
    return Math.max(1, Math.min(24, Math.trunc(Number(plan.everyHours) || 1))) * 60;
  }
  return 1440;
}

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

  const scheduleByTask = useMemo(() => {
    const output = {};
    for (let index = 0; index < cronSettingsDraft.length; index += 1) {
      const task = cronSettingsDraft[index];
      output[task.name] = parseSchedulePlan(task);
    }
    return output;
  }, [cronSettingsDraft]);

  const applyPlanToTask = (taskName, plan) => {
    const cron = buildCronByPlan(plan);
    const intervalMinutes = getIntervalMinutesByPlan(plan);
    updateCronDraftField(taskName, 'cron', cron);
    updateCronDraftField(taskName, 'interval_minutes', String(intervalMinutes));
  };

  const addHourToTaskPlan = (task, plan) => {
    const candidate = Number(hourPickerByTask[task.name] ?? 9);
    if (!Number.isFinite(candidate)) {
      return;
    }
    const nextHours = parseHourList([...plan.hours, Math.trunc(candidate)].join(','));
    applyPlanToTask(task.name, {
      ...plan,
      hours: nextHours
    });
  };

  const removeHourFromTaskPlan = (task, plan, hour) => {
    const nextHours = plan.hours.filter((value) => value !== hour);
    applyPlanToTask(task.name, {
      ...plan,
      hours: nextHours.length > 0 ? nextHours : [9]
    });
  };

  const toggleWeekDayForTaskPlan = (task, plan, dayValue) => {
    const exists = plan.days.includes(dayValue);
    const nextDays = exists
      ? plan.days.filter((value) => value !== dayValue)
      : [...plan.days, dayValue];
    applyPlanToTask(task.name, {
      ...plan,
      days: nextDays.length > 0 ? nextDays : [1]
    });
  };

  return (
    <div className="data-grid">
      <Section
        title="Автоматичні задачі"
        subtitle="Вибирайте зручний розклад: по годинах, щодня або по днях тижня"
        extra={(
          <div className="actions">
            <button className="btn" onClick={refreshCronSettings}>Оновити дані</button>
            <button className="btn primary" disabled={isReadOnly || cronSaving} onClick={saveCronSettings}>
              {cronSaving ? 'Збереження...' : 'Зберегти зміни'}
            </button>
          </div>
        )}
      >
        <div className="cron-intro">
          Підтримується сценарій “5 запусків на день” з вибором конкретних годин.
        </div>

        {cronSettingsDraft.length === 0 ? (
          <div className="empty-preview">Налаштування ще не завантажені</div>
        ) : (
          <div className="cron-grid">
            {cronSettingsDraft.map((task) => {
              const plan = scheduleByTask[task.name] || parseSchedulePlan(task);
              return (
                <div className="cron-card" key={task.name}>
                  <div className="cron-card-head">
                    <div>
                      <h4 className="block-title">{TASK_META[task.name]?.title || task.name}</h4>
                      <p className="muted">{TASK_META[task.name]?.description || 'Системна задача'}</p>
                    </div>
                    <Tag tone={task.is_enabled ? 'ok' : 'warn'}>
                      {task.is_enabled ? 'Увімкнено' : 'Пауза'}
                    </Tag>
                  </div>

                  <div className="form-row cron-mode-row">
                    <div>
                      <label>Режим розкладу</label>
                      <select
                        value={plan.mode}
                        onChange={(event) => {
                          const mode = event.target.value;
                          if (mode === 'interval_hours') {
                            applyPlanToTask(task.name, {
                              mode,
                              everyHours: plan.everyHours || 3,
                              hours: [],
                              days: []
                            });
                            return;
                          }
                          if (mode === 'daily_hours') {
                            applyPlanToTask(task.name, {
                              mode,
                              everyHours: 0,
                              hours: plan.hours.length > 0 ? plan.hours : [9],
                              days: []
                            });
                            return;
                          }
                          applyPlanToTask(task.name, {
                            mode: 'weekly_hours',
                            everyHours: 0,
                            hours: plan.hours.length > 0 ? plan.hours : [9],
                            days: plan.days.length > 0 ? plan.days : [1, 2, 3, 4, 5]
                          });
                        }}
                      >
                        <option value="interval_hours">Кожні N годин</option>
                        <option value="daily_hours">Щодня у вибрані години</option>
                        <option value="weekly_hours">По днях тижня і годинах</option>
                      </select>
                    </div>
                  </div>

                  {plan.mode === 'interval_hours' ? (
                    <div className="form-row">
                      <div>
                        <label>Кожні (годин)</label>
                        <input
                          type="number"
                          min="1"
                          max="24"
                          value={String(plan.everyHours || 3)}
                          onChange={(event) =>
                            applyPlanToTask(task.name, {
                              ...plan,
                              everyHours: Math.max(1, Math.min(24, Number(event.target.value || 1)))
                            })
                          }
                        />
                      </div>
                    </div>
                  ) : null}

                  {plan.mode === 'daily_hours' || plan.mode === 'weekly_hours' ? (
                    <>
                      <div className="cron-hour-builder">
                        <label>Години запуску</label>
                        <div className="actions">
                          <select
                            value={String(hourPickerByTask[task.name] ?? 9)}
                            onChange={(event) =>
                              setHourPickerByTask((prev) => ({
                                ...prev,
                                [task.name]: event.target.value
                              }))
                            }
                          >
                            {ALL_HOURS.map((hour) => (
                              <option key={`${task.name}_hour_${hour}`} value={hour}>
                                {toHourLabel(hour)}
                              </option>
                            ))}
                          </select>
                          <button className="btn" type="button" onClick={() => addHourToTaskPlan(task, plan)}>
                            Додати годину
                          </button>
                          <button
                            className="btn"
                            type="button"
                            onClick={() =>
                              applyPlanToTask(task.name, {
                                ...plan,
                                hours: FIVE_RUNS_DEFAULT_HOURS
                              })
                            }
                          >
                            5 запусків / день
                          </button>
                        </div>

                        <div className="cron-hour-chip-list">
                          {plan.hours.length > 0 ? (
                            plan.hours.map((hour) => (
                              <button
                                key={`${task.name}_selected_hour_${hour}`}
                                type="button"
                                className="cron-hour-chip"
                                onClick={() => removeHourFromTaskPlan(task, plan, hour)}
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
                              <label key={`${task.name}_weekday_${day.value}`} className="cron-weekday-item">
                                <input
                                  type="checkbox"
                                  checked={plan.days.includes(day.value)}
                                  onChange={() => toggleWeekDayForTaskPlan(task, plan, day.value)}
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
                    <div className="form-row">
                      <div>
                        <label>Постачальник для автооновлення (опційно)</label>
                        <select
                          value={task.supplier || ''}
                          onChange={(event) =>
                            updateCronDraftField(task.name, 'supplier', event.target.value)
                          }
                        >
                          <option value="">Усі постачальники</option>
                          {supplierOptions.map((supplier) => (
                            <option key={`cron_supplier_${supplier.id}`} value={supplier.name}>
                              {supplier.name}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  ) : null}

                  <div className="checkbox-row">
                    <label>
                      <input
                        type="checkbox"
                        checked={task.is_enabled === true}
                        onChange={(event) =>
                          updateCronDraftField(task.name, 'is_enabled', event.target.checked)
                        }
                        style={{ width: 'auto' }}
                      />
                      Виконувати автоматично
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={task.run_on_startup === true}
                        onChange={(event) =>
                          updateCronDraftField(task.name, 'run_on_startup', event.target.checked)
                        }
                        style={{ width: 'auto' }}
                      />
                      Запускати після рестарту сервера
                    </label>
                  </div>

                  <div className="status-line">Оновлено: {formatDateTime(task.updated_at)}</div>

                  <details className="details-block cron-technical">
                    <summary>Технічні деталі</summary>
                    <div className="cron-tech-grid">
                      <div>
                        <label>Системне імʼя</label>
                        <code>{task.name}</code>
                      </div>
                      <div>
                        <label>Cron (авто)</label>
                        <code>{task.cron || '-'}</code>
                      </div>
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
