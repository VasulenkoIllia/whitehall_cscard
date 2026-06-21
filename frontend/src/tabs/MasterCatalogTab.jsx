import React, { useEffect, useState, useCallback } from 'react';
import { Section, Tag } from '../components/ui';
import { AiSettingsPanel } from '../components/AiSettingsPanel';
import { ExcelImportModal } from '../components/ExcelImportModal';
import { PromptPreviewModal } from '../components/PromptPreviewModal';
import { MasterDrillIn } from '../components/MasterDrillIn';
import { ModelSelect } from '../components/ModelSelect';
import { isDeepseek, enrichPageSize } from '../lib/aiModels';
import { TOTAL_FIELDS } from '../lib/masterFields';

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
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchSummary, setBatchSummary] = useState(null);
  const [batchSize, setBatchSize] = useState(10);
  const [aiModel, setAiModel] = useState('claude-haiku-4-5');
  // Set of master_catalog.id обраних чекбоксами:
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  // Cost summary з /ai/usage:
  const [usageSummary, setUsageSummary] = useState(null);
  // Prompt preview modal:
  const [promptPreview, setPromptPreview] = useState(null);
  const [asyncBatches, setAsyncBatches] = useState([]);
  const [asyncSubmitting, setAsyncSubmitting] = useState(false);
  const [excelModalOpen, setExcelModalOpen] = useState(false);
  // "Обрати перші N за фільтром" (10/50/100):
  const [selectCount, setSelectCount] = useState(100);
  const [selectingFirstN, setSelectingFirstN] = useState(false);
  // Глобальний прогрес каталогу (всього / AI / у черзі / лишилось):
  const [catalogStats, setCatalogStats] = useState(null);

  // Спільні параметри фільтра (для списку І для вибору) — щоб «що бачу, те й
  // обираю». hasAi: 'true'=опрацьовані, 'false'=не опрацьовані, 'pending'=у черзі.
  const filterParams = useCallback(() => {
    const p = new URLSearchParams({ sort });
    if (search.trim()) p.set('search', search.trim());
    if (hasFeed) p.set('hasFeed', hasFeed);
    if (hasAi === 'true' || hasAi === 'false') p.set('hasAi', hasAi);
    if (hasAi === 'pending') p.set('pendingBatch', 'true');
    return p;
  }, [search, hasFeed, hasAi, sort]);

  const loadList = useCallback(async () => {
    setStatus('Завантаження...');
    try {
      const params = filterParams();
      params.set('page', String(page));
      params.set('pageSize', String(pageSize));
      const data = await apiFetch(`/master-catalog?${params.toString()}`);
      setRows(Array.isArray(data?.rows) ? data.rows : []);
      setTotal(Number(data?.total || 0));
      setStatus('');
      // Прогрес оновлюємо разом зі списком (loadList викликається після
      // імпорту/enrich/poll — статистика завжди актуальна).
      apiFetch('/master-catalog/stats').then(setCatalogStats).catch(() => undefined);
    } catch (err) {
      setStatus(`Помилка: ${err?.message || 'unknown'}`);
    }
  }, [apiFetch, filterParams, page, pageSize]);

  useEffect(() => { void loadList(); }, [loadList]);

  const loadUsage = useCallback(async () => {
    try {
      const data = await apiFetch('/master-catalog/ai/usage');
      setUsageSummary(data);
    } catch {
      // ignore
    }
  }, [apiFetch]);

  useEffect(() => { void loadUsage(); }, [loadUsage]);

  const loadAsyncBatches = useCallback(async () => {
    try {
      const data = await apiFetch('/master-catalog/batches?limit=10');
      setAsyncBatches(Array.isArray(data?.rows) ? data.rows : []);
    } catch {
      // ignore
    }
  }, [apiFetch]);

  useEffect(() => { void loadAsyncBatches(); }, [loadAsyncBatches]);

  // Обрані id можуть бути поза видимою сторінкою (через "Обрати перші N" —
  // там сервер вже відфільтрував hasFeed=true). Для видимих перевіряємо
  // feed_matched_at, невидимим довіряємо; бекенд все одно skip-ає без feed_params.
  const feedCandidates = () => Array.from(selectedIds).filter((id) => {
    const row = rows.find((r) => Number(r.id) === id);
    return !row || Boolean(row.feed_matched_at);
  });

  const submitAsyncBatch = async () => {
    if (isReadOnly || asyncSubmitting) return;
    const candidates = feedCandidates();
    if (candidates.length === 0) {
      alert('Оберіть SKU з feed для async batch.');
      return;
    }
    const chunks = Math.ceil(candidates.length / 5000);
    if (!window.confirm(
      `Submit ${candidates.length} SKU у Anthropic Batch API (async)?\n` +
      (chunks > 1 ? `Розіб'ється на ${chunks} батчі (ліміт розміру).\n` : '') +
      `Результат через 1-24 години. Ціна -50% + кеш.`
    )) return;
    setAsyncSubmitting(true);
    try {
      const result = await apiFetch('/master-catalog/batch-submit', {
        method: 'POST',
        body: JSON.stringify({ masterIds: candidates, model: aiModel })
      });
      const skippedNote = result.skippedPending > 0
        ? `\n⚠ ${result.skippedPending} вже в черзі — пропущено (захист від подвійної оплати).`
        : '';
      const nB = (result.batches || []).length;
      alert(`Відправлено ${result.itemsCount} SKU у ${nB} батч${nB === 1 ? '' : 'і'}.${skippedNote}`);
      setSelectedIds(new Set());
      await loadAsyncBatches();
      await loadList();
    } catch (err) {
      alert('Помилка: ' + (err?.message || 'unknown'));
    } finally {
      setAsyncSubmitting(false);
    }
  };

  const pollAsyncBatch = async (batchId, overwrite = false) => {
    try {
      const updated = await apiFetch(`/master-catalog/batches/${batchId}/poll`, {
        method: 'POST',
        body: JSON.stringify({ overwrite })
      });
      await loadAsyncBatches();
      await loadUsage();
      await loadList();
      if (updated.status === 'ended') {
        alert(`Batch завершено! Записано: ${updated.succeeded_count}, помилок: ${updated.errored_count}, $: ${updated.cost_usd || 0}`);
      } else {
        alert(`Status: ${updated.status}, processed: ${updated.processed_count}/${updated.items_count}`);
      }
    } catch (err) {
      alert('Помилка: ' + (err?.message || 'unknown'));
    }
  };

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

  // Bulk enrich — використовує selectedIds (чекбокси). Якщо нічого не обрано —
  // підказка користувачу. Велику вибірку шлемо порціями (розмір — за моделлю:
  // синхронний запит має вкластися у ~100с ліміт шлюзу, інакше 524).
  const runBatchEnrich = async (overwrite = false) => {
    if (isReadOnly || batchRunning) return;
    const candidates = feedCandidates();
    if (candidates.length === 0) {
      setBatchSummary({
        error: 'Оберіть SKU чекбоксами. Тільки ті що мають feed (feed_matched_at) йдуть в AI.'
      });
      return;
    }
    setBatchRunning(true);
    const pageSize = enrichPageSize(aiModel);
    const pages = [];
    for (let i = 0; i < candidates.length; i += pageSize) pages.push(candidates.slice(i, i + pageSize));
    const agg = {
      itemsRequested: candidates.length, itemsEnriched: 0, itemsFailed: 0,
      totalFieldsWritten: 0, inputTokens: 0, outputTokens: 0, durationMs: 0, modelVersion: aiModel
    };
    try {
      for (let p = 0; p < pages.length; p++) {
        const done = agg.itemsEnriched + agg.itemsFailed;
        setBatchSummary({
          status: `Обробка ${done}/${candidates.length} SKU · порція ${p + 1}/${pages.length} (model: ${aiModel})...`
        });
        const r = await apiFetch('/master-catalog/enrich-batch', {
          method: 'POST',
          body: JSON.stringify({ masterIds: pages[p], batchSize, overwrite, model: aiModel })
        });
        agg.itemsEnriched += r.itemsEnriched || 0;
        agg.itemsFailed += r.itemsFailed || 0;
        agg.totalFieldsWritten += r.totalFieldsWritten || 0;
        agg.inputTokens += r.inputTokens || 0;
        agg.outputTokens += r.outputTokens || 0;
        agg.durationMs += r.durationMs || 0;
        agg.modelVersion = r.modelVersion || agg.modelVersion;
        await loadList(); // поступово оновлюємо прогрес у таблиці
      }
      setBatchSummary(agg);
      await loadUsage();
    } catch (err) {
      setBatchSummary({
        ...agg,
        error: `${err?.message || 'batch_error'} — опрацьовано ${agg.itemsEnriched}/${candidates.length} до помилки (вже збережені)`
      });
      await loadList();
      await loadUsage();
    } finally {
      setBatchRunning(false);
    }
  };

  // ─── Вибір SKU ─────────────────────────────────────────────────────────────
  const toggleOne = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const selectAllVisible = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const r of rows) next.add(Number(r.id));
      return next;
    });
  };
  const clearSelection = () => setSelectedIds(new Set());

  // Обрати id за ПОТОЧНИМ фільтром (limit=null → усі, що відповідають фільтру).
  // «Що бачу в таблиці, те й обираю» — без гортання сторінок.
  const selectByFilter = async (limit) => {
    if (selectingFirstN) return;
    setSelectingFirstN(true);
    try {
      const params = filterParams();
      params.set('limit', String(limit || 60000));
      const data = await apiFetch(`/master-catalog/ids?${params.toString()}`);
      const ids = Array.isArray(data?.ids) ? data.ids.map(Number) : [];
      setSelectedIds(new Set(ids));
      if (ids.length === 0) alert('За поточним фільтром SKU немає.');
    } catch (err) {
      alert('Помилка: ' + (err?.message || 'unknown'));
    } finally {
      setSelectingFirstN(false);
    }
  };

  // ─── Prompt preview ────────────────────────────────────────────────────────
  const openPromptPreview = async (masterId) => {
    setPromptPreview({ loading: true, masterId });
    try {
      const data = await apiFetch(`/master-catalog/${masterId}/enrich/preview`);
      setPromptPreview({ ...data, loading: false, masterId });
    } catch (err) {
      setPromptPreview({ loading: false, error: err?.message || 'preview_error', masterId });
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <Section
      title="Майстер-каталог"
      subtitle="Імпорт Excel → AI enrichment (SEO-опис + поля) → експорт для магазину."
    >
      <AiSettingsPanel apiFetch={apiFetch} isReadOnly={isReadOnly} onSettingsChanged={loadUsage} />

      {/* Cost ribbon */}
      {usageSummary?.summary ? (
        <div style={{
          border: '1px solid #d0d7e2', borderRadius: 6, padding: 8, marginBottom: 12,
          background: '#fcfdff', display: 'flex', gap: 12, alignItems: 'center', fontSize: 13, flexWrap: 'wrap'
        }}>
          <strong>💰 AI витрати</strong>
          <span>Всього: <b>${usageSummary.summary.totalCostUsd.toFixed(4)}</b></span>
          <span style={{ color: '#666' }}>· викликів: {usageSummary.summary.totalCalls}</span>
          <span style={{ color: '#666' }}>· SKU оброблено: {usageSummary.summary.totalItems}</span>
          <span style={{ color: '#666' }}>· tokens in/out: {usageSummary.summary.totalInputTokens}/{usageSummary.summary.totalOutputTokens}</span>
          <span style={{ marginLeft: 'auto', color: '#666' }}>
            24h: ${usageSummary.summary.last24h.costUsd.toFixed(4)} ({usageSummary.summary.last24h.calls} викликів)
          </span>
          <details style={{ width: '100%', marginTop: 4 }}>
            <summary style={{ cursor: 'pointer', fontSize: 11, color: '#4a90e2' }}>📊 Розбивка по моделях + recent log</summary>
            <div style={{ marginTop: 8, fontSize: 11 }}>
              <b>По моделях:</b>
              <ul style={{ margin: '4px 0 8px 16px' }}>
                {usageSummary.summary.byModel.map((m) => (
                  <li key={m.model}>
                    <code>{m.model}</code>: {m.calls} викликів, {m.items} SKU, <b>${Number(m.costUsd).toFixed(4)}</b>
                  </li>
                ))}
              </ul>
              <b>Recent log (20 останніх):</b>
              <table style={{ width: '100%', fontSize: 10, marginTop: 4, borderCollapse: 'collapse' }}>
                <thead><tr style={{ background: '#f5f5f5' }}>
                  <th style={{ textAlign: 'left', padding: 3 }}>Час</th>
                  <th>Operation</th>
                  <th>Модель</th>
                  <th>SKU</th>
                  <th>Tokens in/out</th>
                  <th>Cost $</th>
                  <th>Тривалість</th>
                </tr></thead>
                <tbody>
                  {(usageSummary.recent || []).map((r) => (
                    <tr key={r.id} style={{ borderBottom: '1px solid #eee' }}>
                      <td style={{ padding: 3 }}>{new Date(r.createdAt).toLocaleTimeString('uk-UA')}</td>
                      <td>{r.operation}</td>
                      <td><code>{r.modelVersion.replace(/-\d+$/, '')}</code></td>
                      <td>{r.itemsCount}</td>
                      <td>{r.inputTokens}/{r.outputTokens}</td>
                      <td><b>${r.costUsd.toFixed(4)}</b></td>
                      <td>{(r.durationMs / 1000).toFixed(1)}s</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </div>
      ) : null}

      {/* Top bar */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <button
          className="btn primary"
          onClick={triggerSync}
          disabled={isReadOnly || syncRunning}
        >
          {syncRunning ? '⏳ Sync...' : '🔄 Sync from finalize'}
        </button>
        <button
          className="btn"
          onClick={() => setExcelModalOpen(true)}
          disabled={isReadOnly}
          title="Завантажити Excel з товарами: SKU + параметри → feed_params"
        >
          📥 Імпорт Excel
        </button>
        <button
          className="btn"
          onClick={() => {
            // Експорт за поточними фільтрами. Звичайна навігація — cookie auth
            // працює для same-origin GET, браузер сам скачає attachment.
            const params = new URLSearchParams({ sort });
            if (search.trim()) params.set('search', search.trim());
            if (hasFeed) params.set('hasFeed', hasFeed);
            if (hasAi) params.set('hasAi', hasAi);
            window.location.assign(`/admin/api/master-catalog/export.xlsx?${params.toString()}`);
          }}
          title="Скачати .xlsx: sku + 23 AI-поля + метадані. Враховує поточні фільтри — постав AI=«Опрацьовано», щоб скачати тільки збагачені"
        >
          📤 Експорт XLSX
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

      {/* Прогрес AI-обробки: щоб не плутати, що вже пройшло через AI і що в черзі */}
      {catalogStats ? (
        <div style={{
          display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap',
          border: '1px solid #d0d7e2', borderRadius: 6, padding: '6px 10px',
          marginBottom: 12, background: '#fafcff', fontSize: 13
        }}>
          <strong>📊 Прогрес AI</strong>
          <span>Всього: <b>{catalogStats.total}</b></span>
          <span>З даними: <b>{catalogStats.withFeed}</b></span>
          <span style={{ color: '#1a7f37' }}>🤖 Опрацьовано: <b>{catalogStats.aiEnriched}</b></span>
          <span style={{ color: '#8e44ad' }}>⏳ У черзі (batch): <b>{catalogStats.pendingBatch}</b></span>
          <span style={{ color: '#b35900' }}>✨ Лишилось: <b>{catalogStats.fresh}</b></span>
          {catalogStats.withFeed > 0 ? (
            <span style={{ marginLeft: 'auto', color: '#666', fontSize: 12 }}>
              {Math.round((catalogStats.aiEnriched / catalogStats.withFeed) * 100)}% готово
            </span>
          ) : null}
        </div>
      ) : null}

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
          <label>Статус AI</label>
          <select value={hasAi} onChange={(e) => { setHasAi(e.target.value); setPage(1); }}>
            <option value="">Усі</option>
            <option value="false">✨ Не опрацьовані</option>
            <option value="true">🤖 Опрацьовані</option>
            <option value="pending">⏳ У черзі</option>
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

      {/* Batch AI enrich + selection controls */}
      <div style={{ border: '1px solid #4a90e2', borderRadius: 6, padding: 10, marginBottom: 12, background: '#f0f7ff' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
          <strong>🤖 Batch AI Enrichment</strong>
          <span style={{ fontSize: 12, color: '#333' }}>
            Обрано: <b>{selectedIds.size}</b> · за фільтром: <b>{total}</b>
          </span>
          <span style={{ color: '#bbb' }}>|</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
            Обрати перші
            <select value={selectCount} onChange={(e) => setSelectCount(Number(e.target.value))} style={{ fontSize: 12 }}>
              <option value={50}>50</option>
              <option value={100}>100</option>
              <option value={500}>500</option>
              <option value={1000}>1000</option>
            </select>
            <button className="btn btn-sm" onClick={() => selectByFilter(selectCount)} disabled={selectingFirstN}>
              {selectingFirstN ? '⏳' : 'Обрати'}
            </button>
          </span>
          <button
            className="btn btn-sm primary"
            onClick={() => selectByFilter(null)}
            disabled={selectingFirstN || total === 0}
            title="Обрати ВСІ SKU, що відповідають поточному фільтру (з усього каталогу, без гортання)"
          >
            ✓ Обрати ВСІ за фільтром ({total})
          </button>
          <button className="btn btn-sm" onClick={selectAllVisible} disabled={rows.length === 0} title="Лише видиму сторінку">
            Видимі
          </button>
          <button className="btn btn-sm" onClick={clearSelection} disabled={selectedIds.size === 0}>
            Очистити
          </button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <label style={{ fontSize: 12 }}>
            Модель:
            <ModelSelect value={aiModel} onChange={setAiModel} style={{ marginLeft: 4 }} />
          </label>
          <label style={{ fontSize: 12 }}>
            Batch size:
            <select value={batchSize} onChange={(e) => setBatchSize(Number(e.target.value))} style={{ marginLeft: 4 }}>
              <option value={5}>5</option>
              <option value={10}>10</option>
              <option value={15}>15</option>
              <option value={20}>20</option>
              <option value={25}>25</option>
            </select>
          </label>
          <button
            className="btn btn-sm primary"
            disabled={isReadOnly || batchRunning || selectedIds.size === 0}
            onClick={() => runBatchEnrich(false)}
            title="Тільки порожні поля у AI"
          >
            {batchRunning ? '⏳ AI працює...' : `✨ Enrich (${selectedIds.size}) — порожні`}
          </button>
          <button
            className="btn btn-sm"
            disabled={isReadOnly || batchRunning || selectedIds.size === 0}
            onClick={() => runBatchEnrich(true)}
            title="Переписати всі поля"
          >
            🔁 Enrich ({selectedIds.size}) — переписати
          </button>
          <button
            className="btn btn-sm"
            disabled={isReadOnly || asyncSubmitting || selectedIds.size === 0 || isDeepseek(aiModel)}
            onClick={submitAsyncBatch}
            title={isDeepseek(aiModel)
              ? 'DeepSeek не має async Batch API — використовуй ✨ Enrich (синхронно, і так дешево)'
              : 'Anthropic Batch API: async обробка, -50% ціна, 1-24 год'}
            style={{ background: isDeepseek(aiModel) ? '#bbb' : '#8e44ad', color: 'white' }}
          >
            🌙 Submit async batch{isDeepseek(aiModel) ? ' (лише Claude)' : ''}
          </button>
        </div>

        {batchSummary ? (
          <div style={{ marginTop: 8, fontSize: 12 }}>
            {batchSummary.error ? (
              <span style={{ color: '#a00' }}>❌ {batchSummary.error}</span>
            ) : batchSummary.status ? (
              <span>{batchSummary.status}</span>
            ) : (
              <>
                <Tag tone="ok">Enriched: {batchSummary.itemsEnriched} / {batchSummary.itemsRequested}</Tag>
                {batchSummary.itemsFailed > 0 ? <Tag tone="error">Failed: {batchSummary.itemsFailed}</Tag> : null}
                <span style={{ marginLeft: 8, color: '#666' }}>
                  Полів записано: <b>{batchSummary.totalFieldsWritten}</b> ·
                  Tokens in/out: {batchSummary.inputTokens}/{batchSummary.outputTokens} ·
                  Час: {(batchSummary.durationMs / 1000).toFixed(1)}с ·
                  Модель: {batchSummary.modelVersion}
                </span>
              </>
            )}
          </div>
        ) : null}

        {/* Async batches list */}
        {asyncBatches.length > 0 ? (
          <details style={{ marginTop: 8, fontSize: 12 }}>
            <summary style={{ cursor: 'pointer', color: '#8e44ad' }}>
              <strong>🌙 Anthropic Async Batches ({asyncBatches.length})</strong> — click to poll status / fetch results
            </summary>
            <table style={{ width: '100%', fontSize: 11, marginTop: 8 }}>
              <thead><tr style={{ background: '#f5f5f5' }}>
                <th style={{ textAlign: 'left', padding: 3 }}>ID</th>
                <th>External ID</th>
                <th>Status</th>
                <th>Items</th>
                <th>Progress</th>
                <th>Cost $</th>
                <th>Submitted</th>
                <th>Ended</th>
                <th></th>
              </tr></thead>
              <tbody>
                {asyncBatches.map((b) => (
                  <tr key={b.id} style={{ borderBottom: '1px solid #eee' }}>
                    <td style={{ padding: 3 }}>{b.id}</td>
                    <td style={{ fontFamily: 'monospace', fontSize: 10 }}>{b.external_id}</td>
                    <td>
                      <span style={{
                        background: b.status === 'ended' ? '#d4edda' :
                                    b.status === 'errored' ? '#f8d7da' : '#fff3cd',
                        padding: '1px 6px', borderRadius: 8, fontSize: 10
                      }}>{b.status}</span>
                    </td>
                    <td style={{ textAlign: 'center' }}>{b.items_count}</td>
                    <td style={{ textAlign: 'center' }}>
                      {b.succeeded_count}/{b.items_count}
                      {b.errored_count > 0 ? <span style={{ color: '#a00' }}> ({b.errored_count} err)</span> : null}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {b.cost_usd ? `$${Number(b.cost_usd).toFixed(4)}` : '—'}
                    </td>
                    <td style={{ fontSize: 10 }}>
                      {b.submitted_at ? new Date(b.submitted_at).toLocaleString('uk-UA') : '—'}
                    </td>
                    <td style={{ fontSize: 10 }}>
                      {b.ended_at ? new Date(b.ended_at).toLocaleString('uk-UA') : '—'}
                    </td>
                    <td>
                      <button
                        className="btn btn-sm"
                        onClick={() => pollAsyncBatch(b.id, false)}
                        title="Poll status + auto-write results якщо ended"
                      >
                        {b.results_fetched_at ? '✓ Done' :
                         b.status === 'ended' ? '⬇ Fetch' : '🔄 Poll'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        ) : null}
      </div>

      {/* Table */}
      <table style={{ width: '100%', fontSize: 13 }}>
        <thead>
          <tr style={{ background: '#f3f3f3' }}>
            <th style={{ width: 30, padding: 6 }}>
              <input
                type="checkbox"
                checked={rows.length > 0 && rows.every((r) => selectedIds.has(Number(r.id)))}
                onChange={(e) => {
                  if (e.target.checked) selectAllVisible();
                  else clearSelection();
                }}
                title="Обрати/зняти всі видимі"
              />
            </th>
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
            <tr><td colSpan={9} style={{ textAlign: 'center', padding: 20, color: '#888' }}>
              {status || 'Каталог порожній. Натисніть "Sync from finalize".'}
            </td></tr>
          ) : null}
          {rows.map((r) => (
            <tr key={r.id} style={{ borderBottom: '1px solid #eee', cursor: 'pointer' }}
              onClick={() => setSelected(r)}>
              <td style={{ padding: 6, textAlign: 'center' }} onClick={(e) => e.stopPropagation()}>
                <input
                  type="checkbox"
                  checked={selectedIds.has(Number(r.id))}
                  onChange={() => toggleOne(Number(r.id))}
                  disabled={!r.feed_matched_at}
                  title={!r.feed_matched_at ? 'Без feed — не можна enrich-ити' : ''}
                />
              </td>
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
                {r.ai_enriched_at ? '🤖' : r.pending_batch ? (
                  <span title="У черзі: відправлено в async batch, результати ще не записані">⏳</span>
                ) : '—'}
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
        <MasterDrillIn
          master={selected}
          apiFetch={apiFetch}
          onClose={() => setSelected(null)}
          onPreviewPrompt={() => openPromptPreview(selected.id)}
          onAfterEnrich={loadUsage}
        />
      ) : null}

      {promptPreview ? (
        <PromptPreviewModal preview={promptPreview} onClose={() => setPromptPreview(null)} />
      ) : null}

      {excelModalOpen ? (
        <ExcelImportModal
          apiFetch={apiFetch}
          onClose={() => setExcelModalOpen(false)}
          onAfterImport={loadList}
        />
      ) : null}
    </Section>
  );
}
