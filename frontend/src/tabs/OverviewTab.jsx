import React, { useMemo } from 'react';
import { toJsonString } from '../lib/api';
import { Section, Tag } from '../components/ui';

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
                    <td>{gate.key}</td>
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

      <Section title="Технічний знімок" subtitle="Readiness і Stats для діагностики">
        <details className="details-block">
          <summary>Детальний JSON (readiness + stats)</summary>
          <div className="grid" style={{ marginTop: 10 }}>
            <div>
              <h4 className="block-title">Readiness</h4>
              <pre>{toJsonString(readiness || {})}</pre>
            </div>
            <div>
              <h4 className="block-title">Stats</h4>
              <pre>{toJsonString(stats || {})}</pre>
            </div>
          </div>
        </details>
      </Section>
    </div>
  );
}
