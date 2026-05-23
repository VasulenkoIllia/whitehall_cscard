import React, { useEffect, useMemo, useState } from 'react';

/**
 * AiMappingWizard — підказка адміну з 3 кроків:
 *   1) Знайти tabs у файлі через AI.
 *   2) Запропонувати mapping для обраного tab.
 *   3) Apply → заповнює mappingFields + header_row у батьківському стані.
 *
 * Props:
 *   - selectedSupplierId, selectedSourceId
 *   - sources: список sources поточного постачальника (для вибору існуючого source).
 *   - sourceDraft, setSourceDraft: при відсутності source даємо створити "на льоту".
 *   - apiFetch: helper для GET/POST з base URL та auth.
 *   - onApplyMapping({ mapping, headerRow, sheetName }): викликає батьківські setMappingFields/setMappingHeaderRow/setSelectedSheetName.
 *   - extendedMappingKeys: всі ключі (base 6 + master fields).
 *   - baseMappingKeys: тільки 6 базових (article/size/quantity/price/extra/comment).
 *   - mappingColumnOptions: список доступних колонок (для display).
 */
export function AiMappingWizard({
  selectedSupplierId,
  selectedSourceId,
  sources,
  apiFetch,
  onApplyMapping,
  extendedMappingKeys,
  baseMappingKeys
}) {
  const [aiStatus, setAiStatus] = useState(null);
  const [sheetUrl, setSheetUrl] = useState('');
  const [step, setStep] = useState('idle'); // idle | analyzing | tab-picker | suggesting | review
  const [tabs, setTabs] = useState([]);
  const [chosenTab, setChosenTab] = useState(null);
  const [suggestion, setSuggestion] = useState(null);
  const [error, setError] = useState('');
  const [editsLocal, setEditsLocal] = useState({}); // {fieldKey: {type, col_index, value, ...}}
  const [unmappedAccepted, setUnmappedAccepted] = useState(new Set());
  const [busy, setBusy] = useState(false);

  // 1. Status — чи доступне AI взагалі.
  useEffect(() => {
    let cancelled = false;
    apiFetch('/ai-mapping/status')
      .then((r) => !cancelled && setAiStatus(r))
      .catch(() => !cancelled && setAiStatus({ enabled: false }));
    return () => {
      cancelled = true;
    };
  }, [apiFetch]);

  // Підставити URL з вибраного source автоматично.
  useEffect(() => {
    if (!selectedSourceId) return;
    const src = sources.find((s) => String(s.id) === String(selectedSourceId));
    if (src) {
      const u = src?.config?.url || src?.url || '';
      if (u && !sheetUrl) setSheetUrl(u);
    }
  }, [selectedSourceId, sources]);

  const baseKeySet = useMemo(() => new Set(baseMappingKeys || []), [baseMappingKeys]);

  const reset = () => {
    setStep('idle');
    setTabs([]);
    setChosenTab(null);
    setSuggestion(null);
    setEditsLocal({});
    setUnmappedAccepted(new Set());
    setError('');
  };

  const analyzeTabs = async () => {
    setError('');
    if (!selectedSupplierId) { setError('Оберіть постачальника'); return; }
    if (!sheetUrl) { setError('Введіть Google Sheet URL'); return; }
    setBusy(true);
    setStep('analyzing');
    try {
      const result = await apiFetch('/ai-mapping/analyze-tabs', {
        method: 'POST',
        body: JSON.stringify({ supplierId: Number(selectedSupplierId), sheetUrl })
      });
      setTabs(result?.result?.tabs || []);
      setStep('tab-picker');
    } catch (e) {
      setError(e?.message || 'analyze_tabs_error');
      setStep('idle');
    } finally {
      setBusy(false);
    }
  };

  const suggestForTab = async (tabName) => {
    setError('');
    setBusy(true);
    setChosenTab(tabName);
    setStep('suggesting');
    try {
      const result = await apiFetch('/ai-mapping/suggest', {
        method: 'POST',
        body: JSON.stringify({
          supplierId: Number(selectedSupplierId),
          sheetUrl,
          tabName,
          sourceId: selectedSourceId ? Number(selectedSourceId) : undefined
        })
      });
      setSuggestion(result);
      // Seed editsLocal з proposed_mapping (щоб admin міг правити).
      const initial = {};
      const m = result?.result?.mapping || {};
      for (const [k, v] of Object.entries(m)) initial[k] = v;
      setEditsLocal(initial);
      setUnmappedAccepted(new Set());
      setStep('review');
    } catch (e) {
      setError(e?.message || 'suggest_mapping_error');
      setStep('tab-picker');
    } finally {
      setBusy(false);
    }
  };

  // Конвертація AI-формату {type, col_index | value | col_indexes} у формат mappingFields {mode, value}.
  const toMappingFields = (aiMapping) => {
    const out = {};
    for (const [k, v] of Object.entries(aiMapping || {})) {
      if (!v || !v.type) continue;
      if (v.type === 'static') {
        out[k] = { mode: 'static', value: String(v.value ?? ''), allowEmpty: false };
      } else if (v.type === 'column' && Number.isFinite(v.col_index)) {
        // AI повертає col_index 0-based; ми у mappingFields використовуємо 1-based номер колонки.
        out[k] = { mode: 'column', value: Number(v.col_index) + 1, allowEmpty: false };
      } else if (v.type === 'columns' && Array.isArray(v.col_indexes) && v.col_indexes.length > 0) {
        // Multi-column (для photo тощо) — наша поточна схема mapping не підтримує масиви напряму,
        // тому беремо першу як основну. У warning буде ремарка.
        out[k] = { mode: 'column', value: Number(v.col_indexes[0]) + 1, allowEmpty: false };
      }
    }
    return out;
  };

  const applyToParent = () => {
    if (!suggestion) return;
    const mappingFields = toMappingFields(editsLocal);
    onApplyMapping({
      mapping: mappingFields,
      headerRow: suggestion?.result?.header_row || 1,
      sheetName: chosenTab,
      suggestionId: suggestion?.suggestionId
    });
    // Reset wizard.
    reset();
  };

  const rejectSuggestion = async () => {
    if (!suggestion?.suggestionId) { reset(); return; }
    try {
      await apiFetch(`/ai-mapping/suggestions/${suggestion.suggestionId}/review`, {
        method: 'POST',
        body: JSON.stringify({ status: 'rejected' })
      });
    } catch (_e) { /* ignore */ }
    reset();
  };

  // ─── UI ─────────────────────────────────────────────────────────────────
  if (!aiStatus) {
    return <div className="ai-wizard ai-wizard-loading">Перевіряю стан AI…</div>;
  }

  if (!aiStatus.enabled) {
    return (
      <div className="ai-wizard ai-wizard-disabled">
        <strong>AI-мапінг недоступний.</strong>
        <div>Задайте <code>ANTHROPIC_API_KEY</code> в .env щоб увімкнути.</div>
      </div>
    );
  }

  return (
    <div className="ai-wizard" style={{ border: '1px solid #4a90e2', borderRadius: 6, padding: 12, marginTop: 12, background: '#f6faff' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <strong>🤖 AI Mapping Wizard</strong>
        <span style={{ fontSize: 12, color: '#666' }}>
          mapping: {aiStatus.models?.mapping || '?'} · tabs: {aiStatus.models?.tabAnalyzer || '?'}
        </span>
      </div>

      {error && (
        <div style={{ background: '#fee', color: '#a00', padding: 6, borderRadius: 4, margin: '8px 0' }}>
          {error}
        </div>
      )}

      {step === 'idle' && (
        <div style={{ marginTop: 8 }}>
          <div style={{ marginBottom: 6 }}>1. Введіть Google Sheet URL постачальника. AI проаналізує всі tabs у файлі.</div>
          <input
            value={sheetUrl}
            onChange={(e) => setSheetUrl(e.target.value)}
            placeholder="https://docs.google.com/spreadsheets/d/..."
            style={{ width: '100%', padding: 6 }}
          />
          <button onClick={analyzeTabs} disabled={busy || !sheetUrl || !selectedSupplierId} style={{ marginTop: 8 }}>
            Знайти tabs через AI
          </button>
        </div>
      )}

      {step === 'analyzing' && <div>⏳ AI аналізує tabs… (Haiku, ~3-5с)</div>}

      {step === 'tab-picker' && (
        <div style={{ marginTop: 8 }}>
          <div style={{ marginBottom: 6 }}>2. AI знайшов наступні tabs. Оберіть який мапити:</div>
          <table style={{ width: '100%', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#eef' }}>
                <th style={{ textAlign: 'left' }}>Tab</th>
                <th>Каталог?</th>
                <th>Тип</th>
                <th>Confidence</th>
                <th>Reasoning</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {tabs.map((t) => (
                <tr key={t.name} style={{ background: t.is_catalog ? '#efe' : '#fee' }}>
                  <td><b>{t.name}</b></td>
                  <td style={{ textAlign: 'center' }}>{t.is_catalog ? '✓' : '✗'}</td>
                  <td>{t.product_type || '-'}</td>
                  <td style={{ textAlign: 'center' }}>{Math.round((t.confidence || 0) * 100)}%</td>
                  <td style={{ fontSize: 11, color: '#555' }}>{t.reasoning}</td>
                  <td>
                    <button onClick={() => suggestForTab(t.name)} disabled={busy}>
                      Аналізувати
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button onClick={reset} style={{ marginTop: 8 }}>Скасувати</button>
        </div>
      )}

      {step === 'suggesting' && <div>⏳ AI пропонує mapping для "{chosenTab}"… (Sonnet, ~10-20с)</div>}

      {step === 'review' && suggestion && (
        <ReviewPanel
          suggestion={suggestion}
          chosenTab={chosenTab}
          editsLocal={editsLocal}
          setEditsLocal={setEditsLocal}
          baseKeySet={baseKeySet}
          extendedMappingKeys={extendedMappingKeys}
          unmappedAccepted={unmappedAccepted}
          setUnmappedAccepted={setUnmappedAccepted}
          onApply={applyToParent}
          onReject={rejectSuggestion}
        />
      )}
    </div>
  );
}

// ─── Review panel ──────────────────────────────────────────────────────────
function ReviewPanel({ suggestion, chosenTab, editsLocal, setEditsLocal, baseKeySet, extendedMappingKeys, onApply, onReject }) {
  const r = suggestion.result || {};
  const warnings = r.warnings || [];
  const unmapped = r.unmapped_cols || [];

  const confBadge = (c) => {
    const pct = Math.round((c || 0) * 100);
    let color = '#a00';
    if (pct >= 85) color = '#1a8c1a';
    else if (pct >= 70) color = '#d28a00';
    else if (pct >= 50) color = '#c55500';
    return <span style={{ background: color, color: 'white', padding: '1px 6px', borderRadius: 3, fontSize: 11 }}>{pct}%</span>;
  };

  const removeMapping = (key) => {
    setEditsLocal((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  // Розділяємо ключі на base + master.
  const allKeys = extendedMappingKeys || [];
  const baseKeys = allKeys.filter((k) => baseKeySet.has(k));
  const masterKeys = allKeys.filter((k) => !baseKeySet.has(k));

  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ marginBottom: 8 }}>
        3. AI proposal для tab <b>"{chosenTab}"</b>
      </div>

      <div style={{ background: '#fff8e1', padding: 8, borderRadius: 4, marginBottom: 8 }}>
        <strong>Header row:</strong> {r.header_row} {confBadge(r.header_row_confidence)} ·
        <strong style={{ marginLeft: 8 }}>First data row:</strong> {r.first_data_row}
        <div style={{ fontSize: 11, color: '#666' }}>{r.header_row_reasoning}</div>
      </div>

      {warnings.length > 0 && (
        <div style={{ background: '#fee', padding: 8, borderRadius: 4, marginBottom: 8 }}>
          <strong>⚠ Warnings ({warnings.length})</strong>
          <ul style={{ margin: '4px 0 0 16px' }}>
            {warnings.map((w, i) => (
              <li key={i} style={{ fontSize: 12 }}>
                <code>{w.type}</code> {w.field ? `(${w.field})` : ''} — {w.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* BASE 6 — обов'язково. */}
      <details open style={{ marginTop: 8 }}>
        <summary><strong>Базові 6 полів</strong></summary>
        <FieldMappingTable keys={baseKeys} editsLocal={editsLocal} setEditsLocal={setEditsLocal} removeMapping={removeMapping} confBadge={confBadge} required />
      </details>

      {/* MASTER fields — необов'язково. */}
      <details style={{ marginTop: 8 }}>
        <summary><strong>Master fields ({masterKeys.length})</strong></summary>
        <FieldMappingTable keys={masterKeys} editsLocal={editsLocal} setEditsLocal={setEditsLocal} removeMapping={removeMapping} confBadge={confBadge} />
      </details>

      <details style={{ marginTop: 8 }}>
        <summary>Невикористані колонки ({unmapped.length})</summary>
        <ul style={{ fontSize: 12, margin: '4px 0 0 16px' }}>
          {unmapped.map((u, i) => (
            <li key={i}>
              col {u.col_letter || u.col_index} {u.header ? `"${u.header}"` : ''} — {u.reasoning}
            </li>
          ))}
        </ul>
      </details>

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button onClick={onApply} style={{ background: '#1a8c1a', color: 'white', padding: '6px 14px', borderRadius: 4 }}>
          ✓ Apply mapping (підставити у форму)
        </button>
        <button onClick={onReject} style={{ background: '#a00', color: 'white', padding: '6px 14px', borderRadius: 4 }}>
          ✗ Reject (відхилити пропозицію)
        </button>
        <span style={{ fontSize: 11, color: '#888', alignSelf: 'center' }}>
          Tokens in/out: {suggestion.inputTokens}/{suggestion.outputTokens} · {suggestion.durationMs}ms
        </span>
      </div>
    </div>
  );
}

function FieldMappingTable({ keys, editsLocal, setEditsLocal, removeMapping, confBadge, required }) {
  return (
    <table style={{ width: '100%', fontSize: 12, marginTop: 4 }}>
      <thead>
        <tr style={{ background: '#f3f3f3' }}>
          <th style={{ textAlign: 'left', padding: 4 }}>Field</th>
          <th>Type</th>
          <th>Col / Value</th>
          <th>Header</th>
          <th>Confidence</th>
          <th>Sample</th>
          <th>Reasoning</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {keys.map((k) => {
          const v = editsLocal[k];
          const missing = !v;
          return (
            <tr key={k} style={{ background: missing ? (required ? '#fee' : 'transparent') : (v.confidence >= 0.85 ? '#efe' : '#fff8e1') }}>
              <td style={{ padding: 4 }}>
                <code>{k}</code>{required ? ' *' : ''}
              </td>
              <td>{v?.type || '—'}</td>
              <td>
                {v?.type === 'column' && (
                  <input
                    type="number"
                    value={Number.isFinite(v.col_index) ? v.col_index : 0}
                    style={{ width: 60 }}
                    onChange={(e) => setEditsLocal((prev) => ({
                      ...prev,
                      [k]: { ...prev[k], col_index: Number(e.target.value) }
                    }))}
                  />
                )}
                {v?.type === 'static' && (
                  <input
                    value={String(v.value ?? '')}
                    style={{ width: 100 }}
                    onChange={(e) => setEditsLocal((prev) => ({
                      ...prev,
                      [k]: { ...prev[k], value: e.target.value }
                    }))}
                  />
                )}
                {v?.type === 'columns' && (
                  <span>{(v.col_indexes || []).join(', ')}</span>
                )}
                {!v && '—'}
              </td>
              <td>{v?.header || (v?.headers ? v.headers.join(' | ') : '')}</td>
              <td>{v ? confBadge(v.confidence) : ''}</td>
              <td style={{ fontSize: 10, color: '#666' }}>{(v?.sample_values || []).slice(0, 2).join(', ')}</td>
              <td style={{ fontSize: 10, color: '#666' }}>{v?.reasoning || ''}</td>
              <td>{v && <button onClick={() => removeMapping(k)}>×</button>}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
