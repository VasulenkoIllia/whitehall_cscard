import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { Section, Tag } from '../components/ui';

// 23 атрибутні поля в порядку як у master_catalog.
const MASTER_FIELDS = [
  { key: 'name_uk', label: 'Назва (UA)', dataType: 'text' },
  { key: 'brand', label: 'Бренд', dataType: 'text' },
  { key: 'category_uk', label: 'Категорія', dataType: 'text' },
  { key: 'photo', label: 'Фото', dataType: 'long_text' },
  { key: 'description_full_uk', label: 'Опис', dataType: 'long_text' },
  { key: 'old_price', label: 'Стара ціна', dataType: 'number' },
  { key: 'product_kind', label: 'Вид товару', dataType: 'text' },
  { key: 'product_type', label: 'Тип', dataType: 'text' },
  { key: 'color_uk', label: 'Колір (UA)', dataType: 'text' },
  { key: 'model_name', label: 'Модель', dataType: 'text' },
  { key: 'gender', label: 'Стать', dataType: 'text' },
  { key: 'style', label: 'Стиль', dataType: 'text' },
  { key: 'material', label: 'Матеріал', dataType: 'text' },
  { key: 'material_top', label: 'Матеріал верху', dataType: 'text' },
  { key: 'material_inner', label: 'Матеріал всередині', dataType: 'text' },
  { key: 'material_sole', label: 'Матеріал підошви', dataType: 'text' },
  { key: 'toe_shape', label: 'Вид носка', dataType: 'text' },
  { key: 'fastening', label: 'Застібка', dataType: 'text' },
  { key: 'purpose', label: 'Призначення', dataType: 'text' },
  { key: 'season', label: 'Сезон', dataType: 'text' },
  { key: 'season_year', label: 'Сезон за роками', dataType: 'text' },
  { key: 'country', label: 'Країна', dataType: 'text' },
  { key: 'gtin', label: 'GTIN barcode', dataType: 'text' }
];

const TOTAL_FIELDS = MASTER_FIELDS.length;

export function MasterCatalogTab({ apiFetch, isReadOnly }) {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [search, setSearch] = useState('');
  const [hasFeed, setHasFeed] = useState('');
  const [hasAi, setHasAi] = useState('');
  const [sort, setSort] = useState('newest');
  const [status, setStatus] = useState('');
  const [syncRunning, setSyncRunning] = useState(false);
  const [lastSyncSummary, setLastSyncSummary] = useState(null);
  const [selected, setSelected] = useState(null);

  const loadList = useCallback(async () => {
    setStatus('Завантаження...');
    try {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
        sort
      });
      if (search.trim()) params.set('search', search.trim());
      if (hasFeed) params.set('hasFeed', hasFeed);
      if (hasAi) params.set('hasAi', hasAi);
      const data = await apiFetch(`/master-catalog?${params.toString()}`);
      setRows(Array.isArray(data?.rows) ? data.rows : []);
      setTotal(Number(data?.total || 0));
      setStatus('');
    } catch (err) {
      setStatus(`Помилка: ${err?.message || 'unknown'}`);
    }
  }, [apiFetch, page, pageSize, search, hasFeed, hasAi, sort]);

  useEffect(() => { void loadList(); }, [loadList]);

  const triggerSync = async () => {
    if (isReadOnly || syncRunning) return;
    setSyncRunning(true);
    setStatus('Запускаю sync...');
    try {
      const result = await apiFetch('/jobs/master-catalog-sync', { method: 'POST' });
      setLastSyncSummary(result?.result || result);
      setStatus(`Sync OK: +${result?.result?.inserted ?? 0} нових SKU, всього у фіналі ${result?.result?.sourceSkuCount ?? 0}`);
      await loadList();
    } catch (err) {
      setStatus(`Помилка sync: ${err?.message || 'unknown'}`);
    } finally {
      setSyncRunning(false);
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <Section
      title="Майстер-каталог"
      subtitle="Phase 1 — SKU з фіналайзу. Phase 2 — імпорт фідів + matching. Phase 3 — AI enrichment."
    >
      <FeedsSection apiFetch={apiFetch} isReadOnly={isReadOnly} onAfterImport={loadList} />

      {/* Top bar */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <button
          className="btn primary"
          onClick={triggerSync}
          disabled={isReadOnly || syncRunning}
        >
          {syncRunning ? '⏳ Sync...' : '🔄 Sync from finalize'}
        </button>
        {lastSyncSummary ? (
          <Tag tone="ok">
            +{lastSyncSummary.inserted} нових, {lastSyncSummary.skipped} вже існували, {lastSyncSummary.durationMs}ms
          </Tag>
        ) : null}
        <div style={{ marginLeft: 'auto', color: '#666' }}>
          Всього у каталозі: <b>{total}</b>
        </div>
      </div>

      {/* Filters */}
      <div className="mapping-builder" style={{ marginBottom: 12 }}>
        <div>
          <label>Пошук</label>
          <input
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            placeholder="артикул / SKU"
          />
        </div>
        <div>
          <label>З фіда</label>
          <select value={hasFeed} onChange={(e) => { setHasFeed(e.target.value); setPage(1); }}>
            <option value="">Усі</option>
            <option value="true">З фіда ✓</option>
            <option value="false">Без фіда</option>
          </select>
        </div>
        <div>
          <label>AI</label>
          <select value={hasAi} onChange={(e) => { setHasAi(e.target.value); setPage(1); }}>
            <option value="">Усі</option>
            <option value="true">Опрацьовано AI ✓</option>
            <option value="false">Не опрацьовано</option>
          </select>
        </div>
        <div>
          <label>Сортування</label>
          <select value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="newest">Спочатку нові</option>
            <option value="oldest">Спочатку старі</option>
            <option value="sku_asc">SKU A→Я</option>
            <option value="sku_desc">SKU Я→A</option>
            <option value="filled_desc">Більше заповнено</option>
            <option value="filled_asc">Менше заповнено</option>
          </select>
        </div>
        <div>
          <label>На стор.</label>
          <select value={String(pageSize)} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}>
            <option value="20">20</option>
            <option value="50">50</option>
            <option value="100">100</option>
            <option value="200">200</option>
          </select>
        </div>
        <div style={{ alignSelf: 'flex-end' }}>
          <button className="btn" onClick={() => void loadList()}>Оновити</button>
        </div>
      </div>

      {status ? <div className="status-line" style={{ marginBottom: 8 }}>{status}</div> : null}

      {/* Table */}
      <table style={{ width: '100%', fontSize: 13 }}>
        <thead>
          <tr style={{ background: '#f3f3f3' }}>
            <th style={{ textAlign: 'left', padding: 6 }}>SKU</th>
            <th style={{ textAlign: 'left' }}>Назва</th>
            <th>Бренд</th>
            <th>Заповнено</th>
            <th>Feed</th>
            <th>AI</th>
            <th>Створено</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={8} style={{ textAlign: 'center', padding: 20, color: '#888' }}>
              {status || 'Каталог порожній. Натисніть "Sync from finalize".'}
            </td></tr>
          ) : null}
          {rows.map((r) => (
            <tr key={r.id} style={{ borderBottom: '1px solid #eee', cursor: 'pointer' }}
              onClick={() => setSelected(r)}>
              <td style={{ padding: 6, fontFamily: 'monospace' }}>{r.sku}</td>
              <td>{r.name_uk || <span style={{ color: '#aaa' }}>—</span>}</td>
              <td>{r.brand || <span style={{ color: '#aaa' }}>—</span>}</td>
              <td style={{ textAlign: 'center' }}>
                <span style={{
                  background: r.filled_count >= TOTAL_FIELDS * 0.8 ? '#d4edda' :
                              r.filled_count > 0 ? '#fff3cd' : '#f8d7da',
                  padding: '2px 8px',
                  borderRadius: 10,
                  fontSize: 11
                }}>
                  {r.filled_count}/{TOTAL_FIELDS}
                </span>
              </td>
              <td style={{ textAlign: 'center' }}>
                {r.feed_matched_at ? '✓' : '—'}
              </td>
              <td style={{ textAlign: 'center' }}>
                {r.ai_enriched_at ? '🤖' : '—'}
              </td>
              <td style={{ fontSize: 11, color: '#666' }}>
                {r.created_at ? new Date(r.created_at).toLocaleDateString('uk-UA') : ''}
              </td>
              <td>
                <button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); setSelected(r); }}>
                  Деталі
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Pagination */}
      {totalPages > 1 ? (
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 12 }}>
          <button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage(1)}>«</button>
          <button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>‹</button>
          <span style={{ alignSelf: 'center' }}>Стор. {page} / {totalPages}</span>
          <button className="btn btn-sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>›</button>
          <button className="btn btn-sm" disabled={page >= totalPages} onClick={() => setPage(totalPages)}>»</button>
        </div>
      ) : null}

      {selected ? (
        <DrillIn master={selected} apiFetch={apiFetch} onClose={() => setSelected(null)} />
      ) : null}
    </Section>
  );
}

function DrillIn({ master, apiFetch, onClose }) {
  const [full, setFull] = useState(null);
  const [loading, setLoading] = useState(true);
  const [aiStatus, setAiStatus] = useState(null);
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
        body: JSON.stringify({ overwrite })
      });
      setEnrichResult(result);
      await reload();
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
              {full?.feed_matched_at ? <Tag tone="ok">Feed: {new Date(full.feed_matched_at).toLocaleString('uk-UA')}</Tag> : <Tag tone="warn">Feed: не імпортовано</Tag>}
              {full?.ai_enriched_at ? <Tag tone="ok">AI: {new Date(full.ai_enriched_at).toLocaleString('uk-UA')}</Tag> : <Tag tone="warn">AI: не опрацьовано</Tag>}
            </div>

            {/* AI Enrich block */}
            <div style={{ marginBottom: 16, padding: 10, background: '#f0f7ff', borderRadius: 6, border: '1px solid #4a90e2' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <strong>🤖 AI Enrichment</strong>
                {!aiStatus?.enabled ? (
                  <span style={{ color: '#a00', fontSize: 12 }}>(недоступний — додай ANTHROPIC_API_KEY)</span>
                ) : (
                  <>
                    <button
                      className="btn btn-sm primary"
                      disabled={enriching || !full?.feed_params}
                      onClick={() => runEnrich(false)}
                      title={!full?.feed_params ? 'Спершу імпортуй feed' : 'Заповнити порожні поля через AI'}
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
                    <span style={{ fontSize: 11, color: '#666' }}>
                      Модель: {aiStatus?.model || '—'}
                    </span>
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
                      <td style={{ padding: 6, color: filled ? '#000' : '#bbb' }}>
                        {filled ? String(v) : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {full?.feed_params ? (
              <details style={{ marginTop: 16 }}>
                <summary><b>Параметри з фіда (raw JSONB)</b></summary>
                <pre style={{ background: '#f8f8f8', padding: 8, fontSize: 11, overflow: 'auto', maxHeight: 300 }}>
                  {JSON.stringify(full.feed_params, null, 2)}
                </pre>
              </details>
            ) : (
              <div style={{ marginTop: 16, padding: 12, background: '#fff3cd', borderRadius: 4, fontSize: 12, color: '#664d03' }}>
                ℹ Для цього SKU ще немає feed_params. Створи та запусти імпорт фіда вище, де SKU присутній.
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}


// ─── Feeds section ────────────────────────────────────────────────────────────
function FeedsSection({ apiFetch, isReadOnly, onAfterImport }) {
  const [feeds, setFeeds] = React.useState([]);
  const [status, setStatus] = React.useState("");
  const [showForm, setShowForm] = React.useState(false);
  const [editingFeed, setEditingFeed] = React.useState(null);
  const [runningId, setRunningId] = React.useState(null);

  const load = React.useCallback(async () => {
    try {
      const data = await apiFetch("/feeds");
      setFeeds(Array.isArray(data?.rows) ? data.rows : []);
    } catch (err) {
      setStatus("Помилка завантаження: " + (err?.message || "unknown"));
    }
  }, [apiFetch]);

  React.useEffect(() => { void load(); }, [load]);

  const triggerImport = async (feedId) => {
    if (isReadOnly || runningId) return;
    setRunningId(feedId);
    setStatus("Імпорт запущено...");
    try {
      const result = await apiFetch("/jobs/feed-import", {
        method: "POST",
        body: JSON.stringify({ feedId })
      });
      const r = result?.result || result;
      setStatus(`Імпорт OK: ${r.itemsCount} items, matched ${r.matchedCount}, unmatched ${r.unmatchedCount}, ${r.durationMs}ms`);
      await load();
      if (onAfterImport) await onAfterImport();
    } catch (err) {
      setStatus("Помилка імпорту: " + (err?.message || "unknown"));
    } finally {
      setRunningId(null);
    }
  };

  const deleteFeed = async (feedId, name) => {
    if (isReadOnly) return;
    if (!window.confirm(`Видалити фід "${name}"? (master_catalog.feed_params НЕ зачіпається)`)) return;
    try {
      await apiFetch(`/feeds/${feedId}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setStatus("Помилка видалення: " + (err?.message || "unknown"));
    }
  };

  const startEdit = (feed) => { setEditingFeed(feed); setShowForm(true); };
  const startCreate = () => { setEditingFeed(null); setShowForm(true); };
  const closeForm = () => { setEditingFeed(null); setShowForm(false); };

  const onSaved = async () => { closeForm(); await load(); };

  return (
    <div style={{ border: "1px solid #d0d7e2", borderRadius: 6, padding: 12, marginBottom: 16, background: "#fafbfc" }}>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 8 }}>
        <strong>📦 Фіди магазинів (Phase 2)</strong>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button className="btn btn-sm primary" disabled={isReadOnly} onClick={startCreate}>+ Додати фід</button>
        </div>
      </div>

      {status ? <div className="status-line" style={{ marginBottom: 8 }}>{status}</div> : null}

      <table style={{ width: "100%", fontSize: 12 }}>
        <thead>
          <tr style={{ background: "#eef" }}>
            <th style={{ textAlign: "left", padding: 4 }}>Назва</th>
            <th style={{ textAlign: "left" }}>URL</th>
            <th>Формат</th>
            <th>SKU field</th>
            <th>Останній імпорт</th>
            <th>Items / Matched</th>
            <th>Статус</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {feeds.length === 0 ? (
            <tr><td colSpan={8} style={{ textAlign: "center", padding: 12, color: "#888" }}>
              Жодного фіда. Натисніть "+ Додати фід"
            </td></tr>
          ) : null}
          {feeds.map((f) => (
            <tr key={f.id} style={{ borderBottom: "1px solid #eee" }}>
              <td style={{ padding: 4, fontWeight: 600 }}>{f.name}</td>
              <td style={{ fontSize: 10, color: "#555", maxWidth: 250, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={f.url}>{f.url}</td>
              <td style={{ textAlign: "center" }}><code>{f.format}</code></td>
              <td style={{ textAlign: "center" }}><code>{f.sku_field}</code></td>
              <td style={{ fontSize: 11, color: "#666" }}>
                {f.last_imported_at ? new Date(f.last_imported_at).toLocaleString("uk-UA") : "—"}
              </td>
              <td style={{ textAlign: "center" }}>
                {f.last_items_count !== null ? `${f.last_items_count} / ${f.last_matched_count || 0}` : "—"}
              </td>
              <td style={{ textAlign: "center" }}>
                {f.last_status === "success" ? <span style={{ color: "#1a8c1a" }}>✓</span> :
                 f.last_status === "failed" ? <span style={{ color: "#a00" }} title={f.last_error || ""}>✗</span> : "—"}
              </td>
              <td>
                <div className="actions" style={{ justifyContent: "flex-end" }}>
                  <button className="btn btn-sm primary" disabled={isReadOnly || runningId === Number(f.id)} onClick={() => triggerImport(Number(f.id))}>
                    {runningId === Number(f.id) ? "⏳" : "Імпорт"}
                  </button>
                  <button className="btn btn-sm" onClick={() => startEdit(f)}>Ред.</button>
                  <button className="btn btn-sm danger" disabled={isReadOnly} onClick={() => deleteFeed(Number(f.id), f.name)}>×</button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {showForm ? (
        <FeedForm
          apiFetch={apiFetch}
          existing={editingFeed}
          onSaved={onSaved}
          onCancel={closeForm}
        />
      ) : null}
    </div>
  );
}

function FeedForm({ apiFetch, existing, onSaved, onCancel }) {
  const [name, setName] = React.useState(existing?.name || "");
  const [url, setUrl] = React.useState(existing?.url || "");
  const [format, setFormat] = React.useState(existing?.format || "yml");
  const [skuField, setSkuField] = React.useState(existing?.sku_field || "vendorCode");

  // Виокремлюємо excluded_fields з options у окремий state — UI зручніше.
  const initialOptions = existing?.options || {};
  const initialExcluded = Array.isArray(initialOptions.excluded_fields)
    ? initialOptions.excluded_fields.join(", ")
    : "";
  // Решта options без excluded_fields — як JSON.
  const restInitial = { ...initialOptions };
  delete restInitial.excluded_fields;

  const [excludedFields, setExcludedFields] = React.useState(initialExcluded);
  const [optionsText, setOptionsText] = React.useState(
    Object.keys(restInitial).length > 0 ? JSON.stringify(restInitial, null, 2) : ""
  );
  const [error, setError] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  const save = async () => {
    setError("");
    let extraOptions;
    try {
      extraOptions = optionsText.trim() ? JSON.parse(optionsText) : {};
    } catch (err) {
      setError("Невалідний JSON у Додаткові options: " + err.message);
      return;
    }
    const excludedArr = excludedFields
      .split(/[,\n]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const options = { ...extraOptions };
    if (excludedArr.length > 0) options.excluded_fields = excludedArr;

    setSaving(true);
    try {
      const payload = { name: name.trim(), url: url.trim(), format, sku_field: skuField.trim(), options };
      if (existing?.id) {
        await apiFetch(`/feeds/${existing.id}`, { method: "PUT", body: JSON.stringify(payload) });
      } else {
        await apiFetch("/feeds", { method: "POST", body: JSON.stringify(payload) });
      }
      await onSaved();
    } catch (err) {
      setError(err?.message || "save_error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ marginTop: 12, padding: 12, border: "1px solid #aaa", borderRadius: 4, background: "#fff" }}>
      <h4 style={{ marginTop: 0 }}>{existing ? `Редагувати фід "${existing.name}"` : "Новий фід"}</h4>
      {error ? <div style={{ background: "#fee", padding: 6, marginBottom: 8, color: "#a00", borderRadius: 4 }}>{error}</div> : null}
      <div style={{ display: "grid", gridTemplateColumns: "180px 1fr", gap: 6, alignItems: "start", marginBottom: 8 }}>
        <label style={{ paddingTop: 6 }}>Назва</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="shopua / europasport / markshop" />
        <label style={{ paddingTop: 6 }}>URL</label>
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://..." />
        <label style={{ paddingTop: 6 }}>Формат</label>
        <select value={format} onChange={(e) => setFormat(e.target.value)}>
          <option value="yml">YML (Yandex Market)</option>
          <option value="xml">XML (custom)</option>
          <option value="xlsx">XLSX (Excel)</option>
        </select>
        <label style={{ paddingTop: 6 }}>SKU field</label>
        <input value={skuField} onChange={(e) => setSkuField(e.target.value)} placeholder="vendorCode / article / A / id" />

        <label style={{ paddingTop: 6 }}>
          Виключити поля при AI<br/>
          <span style={{ fontSize: 10, color: "#888" }}>(через кому)</span>
        </label>
        <div>
          <textarea
            value={excludedFields}
            onChange={(e) => setExcludedFields(e.target.value)}
            rows={2}
            placeholder="description, url, categoryId"
            style={{ width: "100%", fontFamily: "monospace", fontSize: 12 }}
          />
          <div style={{ fontSize: 11, color: "#888", marginTop: 2 }}>
            Ці поля НЕ потраплять у AI prompt (економія токенів). Дані зберігаються у БД як були.
          </div>
        </div>

        <label style={{ paddingTop: 6 }}>
          Додаткові options<br/>
          <span style={{ fontSize: 10, color: "#888" }}>(JSON, опційно)</span>
        </label>
        <textarea
          value={optionsText}
          onChange={(e) => setOptionsText(e.target.value)}
          rows={3}
          style={{ fontFamily: "monospace", fontSize: 11 }}
          placeholder={'{ "sheet_name": "Sheet1", "header_row": 2 }'}
        />
      </div>
      <div style={{ fontSize: 11, color: "#666", marginBottom: 8 }}>
        <b>Підказки:</b><br/>
        • <b>sku_field:</b> YML — <code>vendorCode</code> / <code>article</code> / <code>id</code>;
        XLSX — літера колонки (<code>A</code>) або header (<code>Артикул</code>);
        XML — dot (<code>product.code</code>).<br/>
        • <b>Виключити поля:</b> найкорисніше виключити <code>description</code> якщо він великий —
        економить 1-3K токенів на запит.
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn primary" disabled={saving} onClick={save}>Зберегти</button>
        <button className="btn" disabled={saving} onClick={onCancel}>Скасувати</button>
      </div>
    </div>
  );
}

