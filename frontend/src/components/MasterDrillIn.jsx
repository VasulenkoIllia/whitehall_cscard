import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Tag } from './ui';
import { MASTER_FIELDS, TOTAL_FIELDS } from '../lib/masterFields';

/** Деталі одного SKU: картка 23 полів + AI enrichment (заповнити/переписати, preview). */
export function MasterDrillIn({ master, apiFetch, onClose, onPreviewPrompt, onAfterEnrich }) {
  const [full, setFull] = useState(null);
  const [loading, setLoading] = useState(true);
  const [aiStatus, setAiStatus] = useState(null);
  const [aiModel, setAiModel] = useState('claude-haiku-4-5');
  const [enriching, setEnriching] = useState(false);
  const [enrichResult, setEnrichResult] = useState(null);
  const [enrichError, setEnrichError] = useState('');

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch(`/master-catalog/${master.id}`);
      setFull(data);
    } catch {
      setFull(master);
    } finally {
      setLoading(false);
    }
  }, [apiFetch, master]);

  useEffect(() => { void reload(); }, [reload]);

  useEffect(() => {
    apiFetch('/master-catalog/ai/status')
      .then((r) => setAiStatus(r))
      .catch(() => setAiStatus({ enabled: false }));
  }, [apiFetch]);

  const runEnrich = async (overwrite = false) => {
    setEnriching(true);
    setEnrichError('');
    setEnrichResult(null);
    try {
      const result = await apiFetch(`/master-catalog/${master.id}/enrich`, {
        method: 'POST',
        body: JSON.stringify({ overwrite, model: aiModel })
      });
      setEnrichResult(result);
      await reload();
      if (onAfterEnrich) await onAfterEnrich();
    } catch (err) {
      setEnrichError(err?.message || 'enrich_error');
    } finally {
      setEnriching(false);
    }
  };

  const filledCount = useMemo(() => {
    if (!full) return 0;
    return MASTER_FIELDS.filter((f) => {
      const v = full[f.key];
      return v !== null && v !== undefined && String(v).trim() !== '';
    }).length;
  }, [full]);

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
      background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999
    }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: 'white', maxWidth: 800, width: '90%', maxHeight: '85vh',
        overflow: 'auto', borderRadius: 8, padding: 20, boxShadow: '0 4px 20px rgba(0,0,0,0.3)'
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>
            <code style={{ background: '#f3f3f3', padding: '2px 8px', borderRadius: 4 }}>{master.sku}</code>
          </h3>
          <button className="btn" onClick={onClose}>Закрити</button>
        </div>

        {loading ? <div>Завантаження...</div> : (
          <>
            <div style={{ marginBottom: 12 }}>
              <Tag tone={filledCount >= TOTAL_FIELDS * 0.8 ? 'ok' : 'warn'}>
                Заповнено: {filledCount}/{TOTAL_FIELDS} полів
              </Tag>
              {full?.feed_matched_at ? <Tag tone="ok">Дані: {new Date(full.feed_matched_at).toLocaleString('uk-UA')}</Tag> : <Tag tone="warn">Дані: не імпортовано</Tag>}
              {full?.ai_enriched_at ? <Tag tone="ok">AI: {new Date(full.ai_enriched_at).toLocaleString('uk-UA')}</Tag> : <Tag tone="warn">AI: не опрацьовано</Tag>}
            </div>

            {/* AI Enrich block */}
            <div style={{ marginBottom: 16, padding: 10, background: '#f0f7ff', borderRadius: 6, border: '1px solid #4a90e2' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <strong>🤖 AI Enrichment</strong>
                {!aiStatus?.enabled ? (
                  <span style={{ color: '#a00', fontSize: 12 }}>(недоступний — додай ключ у «⚙️ AI налаштування»)</span>
                ) : (
                  <>
                    <button
                      className="btn btn-sm primary"
                      disabled={enriching || !full?.feed_params}
                      onClick={() => runEnrich(false)}
                      title={!full?.feed_params ? 'Спершу імпортуй дані' : 'Заповнити порожні поля через AI'}
                    >
                      {enriching ? '⏳ Запит до AI...' : '✨ Заповнити через AI'}
                    </button>
                    <button
                      className="btn btn-sm"
                      disabled={enriching || !full?.feed_params}
                      onClick={() => runEnrich(true)}
                      title="Перезаписати ВСІ поля (навіть якщо вже заповнені)"
                    >
                      🔁 Переписати всі
                    </button>
                    <select value={aiModel} onChange={(e) => setAiModel(e.target.value)} style={{ fontSize: 12 }}>
                      <option value="claude-haiku-4-5">Haiku 4.5 (швидко, дешево)</option>
                      <option value="claude-sonnet-4-6">Sonnet 4.6 (точніше)</option>
                    </select>
                    {onPreviewPrompt ? (
                      <button
                        className="btn btn-sm"
                        onClick={onPreviewPrompt}
                        title="Подивитись який prompt відсилатимемо в AI"
                      >
                        🔍 Preview prompt
                      </button>
                    ) : null}
                  </>
                )}
              </div>
              {enrichError ? (
                <div style={{ marginTop: 6, background: '#fee', padding: 6, color: '#a00', fontSize: 12, borderRadius: 4 }}>
                  {enrichError}
                </div>
              ) : null}
              {enrichResult ? (
                <div style={{ marginTop: 6, fontSize: 12 }}>
                  <Tag tone="ok">Заповнено: {enrichResult.fieldsWritten}</Tag>
                  <Tag tone="warn">Пропущено: {enrichResult.fieldsSkipped}</Tag>
                  <span style={{ marginLeft: 8, color: '#666' }}>
                    Tokens in/out: {enrichResult.inputTokens}/{enrichResult.outputTokens} · {enrichResult.durationMs}ms
                  </span>
                  {enrichResult.warnings?.length > 0 ? (
                    <ul style={{ margin: '4px 0 0 16px', color: '#664d03' }}>
                      {enrichResult.warnings.map((w, i) => <li key={i}>{w}</li>)}
                    </ul>
                  ) : null}
                </div>
              ) : null}
            </div>

            <h4>Картка товару (23 поля)</h4>
            <table style={{ width: '100%', fontSize: 13 }}>
              <tbody>
                {MASTER_FIELDS.map((f) => {
                  const v = full?.[f.key];
                  const filled = v !== null && v !== undefined && String(v).trim() !== '';
                  return (
                    <tr key={f.key} style={{ borderBottom: '1px solid #f0f0f0' }}>
                      <td style={{ padding: 6, width: 180, color: '#555' }}>{f.label}</td>
                      <td style={{ padding: 6, color: filled ? '#000' : '#bbb', whiteSpace: 'pre-wrap' }}>
                        {filled ? String(v) : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {full?.feed_params ? (
              <details style={{ marginTop: 16 }}>
                <summary><b>Дані товару (raw feed_params)</b></summary>
                <pre style={{ background: '#f8f8f8', padding: 8, fontSize: 11, overflow: 'auto', maxHeight: 300 }}>
                  {JSON.stringify(full.feed_params, null, 2)}
                </pre>
              </details>
            ) : (
              <div style={{ marginTop: 16, padding: 12, background: '#fff3cd', borderRadius: 4, fontSize: 12, color: '#664d03' }}>
                ℹ Для цього SKU ще немає даних. Завантаж Excel, де цей SKU присутній.
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
