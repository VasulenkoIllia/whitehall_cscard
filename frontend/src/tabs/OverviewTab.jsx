import React, { useMemo } from 'react';
import { Section, Tag } from '../components/ui';

const GATE_LABELS = {
  ready_for_store_import: 'Готово до імпорту в магазин',
  ready_for_continuous_runs: 'Готово до безперервних запусків',
  no_running_blocking_jobs: 'Немає активних блокуючих джобів',
  mirror_is_fresh: 'Дзеркало актуальне',
  mirror_freshness: 'Свіжість дзеркала',
  cleanup_scheduled: 'Очищення заплановане',
  scheduler_active: 'Планувальник активний',
  has_suppliers: 'Є постачальники',
  has_sources: 'Є джерела',
  has_final_products: 'Є фінальні товари'
};

export function OverviewTab({
  readiness,
  stats
}) {
  const gateEntries = useMemo(() => {
    const gates = readiness?.gates && typeof readiness.gates === 'object' ? readiness.gates : {};
    return Object.entries(gates).map(([key, value]) => ({
      key,
      value,
      isOk: value === true
    }));
  }, [readiness]);

  const metricCards = [
    { label: 'Постачальники', value: Number(stats?.suppliers || 0) },
    { label: 'Джерела', value: Number(stats?.sources || 0) },
    { label: 'Сирі рядки', value: Number(stats?.products_raw || 0) },
    { label: 'Фінальні товари', value: Number(stats?.products_final || 0) },
    { label: 'Активні джоби', value: (readiness?.jobs?.running_blocking_jobs || []).length }
  ];

  return (
    <div className="grid">
      <Section title="Стан системи" subtitle="Ключові показники та готовність до імпорту в магазин">
        <div className="kpi-grid">
          {metricCards.map((card) => (
            <div className="kpi-card" key={card.label}>
              <div className="kpi-label">{card.label}</div>
              <div className="kpi-value">{card.value}</div>
            </div>
          ))}
        </div>

        <div className="actions" style={{ marginBottom: 8 }}>
          <Tag tone={readiness?.gates?.ready_for_store_import === true ? 'ok' : 'warn'}>
            Імпорт у магазин: {readiness?.gates?.ready_for_store_import === true ? 'дозволено' : 'перевірити гейти'}
          </Tag>
          <Tag tone={readiness?.mirror?.is_fresh ? 'ok' : 'warn'}>
            Дзеркало: {readiness?.mirror?.is_fresh ? 'актуальне' : 'застаріле'}
          </Tag>
        </div>

        {gateEntries.length > 0 ? (
          <div className="preview-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Гейт</th>
                  <th>Стан</th>
                </tr>
              </thead>
              <tbody>
                {gateEntries.map((gate) => (
                  <tr key={gate.key}>
                    <td>{GATE_LABELS[gate.key] || gate.key}</td>
                    <td>
                      <Tag tone={gate.isOk ? 'ok' : 'warn'}>
                        {gate.isOk ? 'ok' : String(gate.value)}
                      </Tag>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-preview">Гейти readiness поки не отримані</div>
        )}
      </Section>

    </div>
  );
}
