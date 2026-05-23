import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch, formatError } from '../lib/api';
import { Tag } from '../components/ui';

/**
 * MasterCatalogTab — офлайн каталог товарів (catalog_masters), незалежно від CS-Cart.
 *
 * 1 master = 1 унікальний article (normalize_article). Розміри постачальника → variants.
 * Усі пропозиції постачальників — offers, з повним row_data + field_values (через mapping).
 *
 * Якщо адмін у MappingTab розширить мапінг (наприклад додасть `brand: 7`, `color_uk: 5`),
 * наступний запуск catalog-assemble заповнить field_values — і "Картка товару" покаже
 * AI-style suggestions у `mergedFieldValues`.
 */

const PAGE_SIZE_OPTIONS = [25, 50, 100, 200];

const SORT_OPTIONS = [
  { value: 'offer_count_desc', label: 'К-сть offers (спадає)' },
  { value: 'offer_count_asc', label: 'К-сть offers (зростає)' },
  { value: 'best_price_asc', label: 'Найменша ціна' },
  { value: 'best_price_desc', label: 'Найбільша ціна' },
  { value: 'variant_count_desc', label: 'К-сть розмірів' },
  { value: 'article_asc', label: 'Артикул A→Z' },
  { value: 'updated_at_desc', label: 'Нещодавно оновлені' }
];

function formatDateTime(value) {
  if (!value) return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString('uk-UA', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
  });
}
function formatDuration(ms) {
  if (!ms && ms !== 0) return '-';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  return `${min}m ${sec % 60}s`;
}
function formatPrice(value) {
  if (value === null || typeof value === 'undefined' || value === '') return '-';
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return n.toFixed(2);
}
function statusTone(s) {
  if (s === 'finished') return 'ok';
  if (s === 'failed') return 'err';
  return 'warn';
}

export function MasterCatalogTab({ isReadOnly, suppliers, pushToast }) {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');

  const [filters, setFilters] = useState({
    search: '',
    hasOffers: '',
    minOffers: '',
    supplierId: '',
    sort: 'offer_count_desc'
  });
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const searchTimerRef = useRef(null);

  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);

  const [latestRun, setLatestRun] = useState(null);
  const [assembleBusy, setAssembleBusy] = useState(false);
  // Опції збірки: ''=всі, або конкретний supplier_id; force=true пропускає skip-detection.
  const [assembleSupplier, setAssembleSupplier] = useState('');
  const [assembleForce, setAssembleForce] = useState(false);

  const [selectedId, setSelectedId] = useState(null);

  useEffect(() => {
    if (searchTimerRef.current) window.clearTimeout(searchTimerRef.current);
    searchTimerRef.current = window.setTimeout(() => setDebouncedSearch(filters.search), 350);
    return () => { if (searchTimerRef.current) window.clearTimeout(searchTimerRef.current); };
  }, [filters.search]);

  useEffect(() => {
    setPage(0);
  }, [debouncedSearch, filters.hasOffers, filters.minOffers, filters.supplierId, filters.sort, pageSize]);

  const loadRows = useCallback(async () => {
    setLoading(true);
    setStatus('Завантаження каталогу...');
    try {
      const params = new URLSearchParams();
      if (debouncedSearch.trim()) params.set('search', debouncedSearch.trim());
      if (filters.hasOffers === 'true' || filters.hasOffers === 'false') params.set('hasOffers', filters.hasOffers);
      if (filters.minOffers) params.set('minOffers', filters.minOffers);
      if (filters.supplierId) params.set('supplierId', filters.supplierId);
      if (filters.sort) params.set('sort', filters.sort);
      params.set('limit', String(pageSize));
      params.set('offset', String(page * pageSize));
      const data = await apiFetch(`/catalog/masters?${params.toString()}`);
      setRows(Array.isArray(data?.rows) ? data.rows : []);
      setTotal(Number(data?.total || 0));
      setStatus(`Знайдено: ${data?.total || 0}`);
    } catch (err) {
      setStatus(`Помилка: ${formatError(err)}`);
      setRows([]); setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, filters.hasOffers, filters.minOffers, filters.supplierId, filters.sort, page, pageSize]);

  const loadLatestRun = useCallback(async () => {
    try {
      const data = await apiFetch('/catalog/assembly-runs/latest');
      setLatestRun(data?.run || null);
    } catch (_e) { setLatestRun(null); }
  }, []);

  useEffect(() => { loadRows(); }, [loadRows]);
  useEffect(() => { loadLatestRun(); }, [loadLatestRun]);

  const onAssemble = async () => {
    if (isReadOnly || assembleBusy) return;
    setAssembleBusy(true);
    const body = {};
    if (assembleSupplier) body.supplierId = Number(assembleSupplier);
    if (assembleForce) body.force = true;
    const scopeLabel = assembleSupplier ? `постачальника #${assembleSupplier}` : 'усіх постачальників';
    setStatus(`Запуск catalog_assemble для ${scopeLabel}${assembleForce ? ' (force)' : ''}...`);
    try {
      const data = await apiFetch('/jobs/catalog-assemble', {
        method: 'POST',
        body: JSON.stringify(body)
      });
      const r = data?.result || {};
      if (r.skipped) {
        setStatus(`Пропущено: ${r.skipReason || 'без змін'}`);
        pushToast && pushToast('warn', 'Збірку пропущено', r.skipReason || 'немає нових даних');
      } else {
        setStatus(`Виконано (${r.scope}): ${r.offersInserted || 0} offers, ${r.affectedMasters || 0} masters`);
        pushToast && pushToast(
          'ok',
          `Збірку виконано (${r.scope})`,
          `Job #${data?.jobId}: ${r.mastersUpserted || 0} masters, ${r.variantsInserted || 0} variants, ${r.offersInserted || 0} offers, affected: ${r.affectedMasters || 0}`
        );
      }
      await Promise.all([loadRows(), loadLatestRun()]);
    } catch (err) {
      const msg = formatError(err);
      setStatus(`Помилка: ${msg}`);
      pushToast && pushToast('error', 'Збірка не вдалася', msg);
    } finally {
      setAssembleBusy(false);
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="panel">
      <div className="section-head">
        <div>
          <h3>Майстер-каталог</h3>
          <p className="muted">
            Офлайн база товарів — будується ВИКЛЮЧНО з даних постачальників.
            1 рядок = 1 унікальний "SKU (ефективний)" = "Колекція+модель (батьківський)".
            Розміри — variants. Постачальники — offers.
          </p>
        </div>
        <div className="actions" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'flex-end' }}>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <label className="muted" style={{ fontSize: 11 }}>Постачальник</label>
            <select
              value={assembleSupplier}
              onChange={(e) => setAssembleSupplier(e.target.value)}
              disabled={assembleBusy}
              style={{ minWidth: 200 }}
            >
              <option value="">Усі постачальники</option>
              {(suppliers || []).map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>
          <label
            style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}
            title="Пропустити skip-detection — зібрати, навіть якщо нових даних немає"
          >
            <input
              type="checkbox"
              checked={assembleForce}
              onChange={(e) => setAssembleForce(e.target.checked)}
              disabled={assembleBusy}
            />
            force
          </label>
          <button
            className="btn primary"
            onClick={onAssemble}
            disabled={isReadOnly || assembleBusy}
            title={assembleSupplier
              ? 'Зібрати тільки вибраного постачальника (швидко)'
              : 'Зібрати каталог для всіх 159 джерел'}
          >
            {assembleBusy ? 'Збірка...' : 'Зібрати каталог'}
          </button>
        </div>
      </div>

      {latestRun ? (
        <div className="status-line" style={{ marginBottom: 12, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <Tag tone={statusTone(latestRun.status)}>{latestRun.status}</Tag>
          <span>Останній запуск: {formatDateTime(latestRun.startedAt)}</span>
          {latestRun.status === 'finished' ? (
            <>
              <span>· {latestRun.mastersUpserted} masters</span>
              <span>· {latestRun.variantsInserted} variants</span>
              <span>· {latestRun.offersInserted} offers</span>
              <span>· {formatDuration(latestRun.durationMs)}</span>
            </>
          ) : null}
          {latestRun.status === 'failed' && latestRun.error
            ? <span style={{ color: '#c22727' }}>{latestRun.error}</span> : null}
        </div>
      ) : (
        <div className="status-line muted" style={{ marginBottom: 12 }}>
          Каталог ще не збирали. Натисніть "Зібрати каталог".
        </div>
      )}

      <div className="form-row" style={{ marginBottom: 12, alignItems: 'flex-end', flexWrap: 'wrap', gap: 10 }}>
        <div style={{ flex: '1 1 220px' }}>
          <label>Пошук</label>
          <input type="text" placeholder="артикул, значення merged_attributes / field_values"
            value={filters.search}
            onChange={(e) => setFilters((p) => ({ ...p, search: e.target.value }))} />
        </div>
        <div style={{ width: 'auto' }}>
          <label>Offers</label>
          <select value={filters.hasOffers}
            onChange={(e) => setFilters((p) => ({ ...p, hasOffers: e.target.value }))}>
            <option value="">Всі</option>
            <option value="true">Є offers</option>
            <option value="false">Без offers</option>
          </select>
        </div>
        <div style={{ width: 'auto' }}>
          <label>Мін. offers</label>
          <input type="number" min="0" style={{ width: 90 }} value={filters.minOffers}
            onChange={(e) => setFilters((p) => ({ ...p, minOffers: e.target.value }))} />
        </div>
        <div style={{ width: 'auto' }}>
          <label>Постачальник</label>
          <select value={filters.supplierId}
            onChange={(e) => setFilters((p) => ({ ...p, supplierId: e.target.value }))}>
            <option value="">Усі</option>
            {(suppliers || []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div style={{ width: 'auto' }}>
          <label>Сортування</label>
          <select value={filters.sort}
            onChange={(e) => setFilters((p) => ({ ...p, sort: e.target.value }))}>
            {SORT_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
          </select>
        </div>
        <div style={{ width: 'auto' }}>
          <label>На стор.</label>
          <select value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))}>
            {PAGE_SIZE_OPTIONS.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
        <button className="btn" onClick={loadRows} disabled={loading}>
          {loading ? 'Завантаження...' : 'Оновити'}
        </button>
      </div>

      <div className="status-line muted" style={{ marginBottom: 6 }}>{status}</div>

      <div style={{ overflowX: 'auto' }}>
        <table className="data-table">
          <thead>
            <tr>
              <th>SKU (ефективний)</th>
              <th>Розмірів</th>
              <th>Offers</th>
              <th>Постач.</th>
              <th>Best price</th>
              <th>Заг. кількість</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.id} style={{ cursor: 'pointer' }} onClick={() => setSelectedId(m.id)}>
                <td>
                  <strong>{m.displayArticle}</strong>
                  {m.displayArticle !== m.articleKey ? (
                    <div className="muted" style={{ fontSize: 11 }}>key: {m.articleKey}</div>
                  ) : null}
                </td>
                <td>{m.variantCount}</td>
                <td>{m.offerCount > 0 ? <Tag tone="ok">{m.offerCount}</Tag> : <Tag tone="warn">0</Tag>}</td>
                <td>{m.supplierCount}</td>
                <td>
                  {m.bestPrice && m.worstPrice && m.bestPrice !== m.worstPrice
                    ? `${formatPrice(m.bestPrice)}–${formatPrice(m.worstPrice)}`
                    : formatPrice(m.bestPrice)}
                </td>
                <td>{m.totalQty ?? '—'}</td>
                <td>
                  <button className="btn" onClick={(e) => { e.stopPropagation(); setSelectedId(m.id); }}>
                    Деталі
                  </button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && !loading ? (
              <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 20 }}>
                Каталог порожній. Натисніть "Зібрати каталог" або змініть фільтри.
              </td></tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div className="actions" style={{ marginTop: 12, justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <div className="muted">Стор. {page + 1} / {totalPages} · Записів: {total}</div>
        <div className="actions">
          <button className="btn" disabled={page <= 0 || loading} onClick={() => setPage(0)}>«</button>
          <button className="btn" disabled={page <= 0 || loading} onClick={() => setPage((p) => Math.max(0, p - 1))}>‹</button>
          <button className="btn" disabled={page + 1 >= totalPages || loading} onClick={() => setPage((p) => p + 1)}>›</button>
          <button className="btn" disabled={page + 1 >= totalPages || loading} onClick={() => setPage(totalPages - 1)}>»</button>
        </div>
      </div>

      {selectedId ? (
        <MasterDetailModal masterId={selectedId} onClose={() => setSelectedId(null)} />
      ) : null}
    </div>
  );
}

// ─── Master detail modal ─────────────────────────────────────────
// 4 вкладки: Картка / Розмір / Колір / Категорія. Offers + Merged attrs прибрано —
// усе потрібне для UI вже доступне у Картці (через мерджед-кандидатів та field_variations).
function MasterDetailModal({ masterId, onClose }) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState('card');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiFetch(`/catalog/masters/${masterId}`)
      .then((d) => { if (!cancelled) setDetail(d); })
      .catch((err) => { if (!cancelled) setError(formatError(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [masterId]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" style={{ maxWidth: 1100, width: '100%' }} onClick={(e) => e.stopPropagation()}>
        <div className="section-head" style={{ marginBottom: 12 }}>
          <div>
            <h3 style={{ margin: 0 }}>{detail?.master?.displayArticle || `Master #${masterId}`}</h3>
            {detail?.master ? (
              <>
                <p className="muted" style={{ margin: '2px 0 0', fontSize: 11 }}>
                  SKU (ефективний) = Колекція+модель (батьківський). Формується системою з
                  supplier_sku_prefix + supplier article.
                </p>
                <p className="muted" style={{ margin: '4px 0 0' }}>
                  {detail.master.variantCount} розмірів · {detail.master.offerCount} offers ·{' '}
                  {detail.master.supplierCount} постачальників · ціна:{' '}
                  {formatPrice(detail.master.bestPrice)}—{formatPrice(detail.master.worstPrice)}
                </p>
              </>
            ) : null}
          </div>
          <button className="btn" onClick={onClose}>Закрити</button>
        </div>

        {loading ? <div className="status-line">Завантаження...</div> : null}
        {error ? <div className="status-line error">{error}</div> : null}

        {detail ? (
          <>
            <div className="actions" style={{ marginBottom: 12, gap: 4 }}>
              <button className={`btn ${activeTab === 'card' ? 'primary' : ''}`}
                onClick={() => setActiveTab('card')}>Картка товару</button>
              <button className={`btn ${activeTab === 'variants' ? 'primary' : ''}`}
                onClick={() => setActiveTab('variants')}>Розмір ({detail.variants?.length || 0})</button>
              <button className={`btn ${activeTab === 'color' ? 'primary' : ''}`}
                onClick={() => setActiveTab('color')}>Колір</button>
              <button className={`btn ${activeTab === 'category' ? 'primary' : ''}`}
                onClick={() => setActiveTab('category')}>Категорія</button>
            </div>

            {activeTab === 'card' ? <CardEditor masterId={masterId} /> : null}

            {activeTab === 'variants' ? (
              <div style={{ maxHeight: '60vh', overflowY: 'auto' }}>
                <table className="data-table">
                  <thead><tr>
                    <th>Розмір (нормал.)</th>
                    <th>Розмір (raw)</th>
                    <th>Offers</th>
                    <th>Постач.</th>
                    <th>Ціна</th>
                    <th>Кількість</th>
                  </tr></thead>
                  <tbody>
                    {(detail.variants || []).map((v) => (
                      <tr key={v.id}>
                        <td><strong>{v.size || '—'}</strong></td>
                        <td className="muted">{v.sizeRaw || '—'}</td>
                        <td>{v.offerCount}</td>
                        <td>{v.supplierCount}</td>
                        <td>
                          {v.bestPrice && v.worstPrice && v.bestPrice !== v.worstPrice
                            ? `${formatPrice(v.bestPrice)}–${formatPrice(v.worstPrice)}`
                            : formatPrice(v.bestPrice)}
                        </td>
                        <td>{v.totalQty}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}

            {activeTab === 'color' ? <ColorTab detail={detail} /> : null}

            {activeTab === 'category' ? <CategoryTab detail={detail} /> : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

// ─── Generic normalization tab ──────────────────────────────────
// Показує значення-кандидати з merged_attributes (за hint-ключами master-поля)
// + поточні *_mappings правила (color_mappings / category_mappings / тощо).
//
// Параметри:
//   fieldKey           — master_field.key (наприклад 'color_uk', 'category_uk')
//   mappingsEndpoint   — '/catalog/color-mappings' | '/catalog/category-mappings'
//   fromKey            — як називається "from" поле у відповіді ('colorFrom', 'categoryFrom')
//   toKey              — ('colorTo', 'categoryTo')
//   noun               — слово в genitive ("кольорів", "категорій") для тексту
//   nounSing           — однина ("колір", "категорія")
//   mappingsTableName  — для тексту ("color_mappings", "category_mappings")
function NormalizationTab({
  detail, fieldKey, mappingsEndpoint, fromKey, toKey,
  noun, nounSing, mappingsTableName
}) {
  const [hintKeys, setHintKeys] = useState([]);
  const [mappings, setMappings] = useState([]);
  const [mappingsLoading, setMappingsLoading] = useState(false);
  const [mappingsError, setMappingsError] = useState('');
  // CRUD форма: drafts для add та edit.
  const [draftFrom, setDraftFrom] = useState('');
  const [draftTo, setDraftTo] = useState('');
  const [draftNotes, setDraftNotes] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [crudBusy, setCrudBusy] = useState(false);

  useEffect(() => {
    apiFetch('/catalog/fields')
      .then((data) => {
        const f = (data?.rows || []).find((x) => x.key === fieldKey);
        setHintKeys(f?.candidateHintKeys || []);
      })
      .catch(() => setHintKeys([]));
  }, [fieldKey]);

  const loadMappings = useCallback(() => {
    setMappingsLoading(true);
    apiFetch(mappingsEndpoint)
      .then((data) => {
        setMappings(Array.isArray(data?.rows) ? data.rows : []);
        setMappingsError('');
      })
      .catch((err) => setMappingsError(formatError(err)))
      .finally(() => setMappingsLoading(false));
  }, [mappingsEndpoint]);
  useEffect(() => { loadMappings(); }, [loadMappings]);

  const resetForm = () => {
    setDraftFrom(''); setDraftTo(''); setDraftNotes(''); setEditingId(null);
  };
  const startEdit = (m) => {
    setEditingId(m.id);
    setDraftFrom(m[fromKey] || '');
    setDraftTo(m[toKey] || '');
    setDraftNotes(m.notes || '');
  };

  const onSave = async () => {
    if (!draftFrom.trim() || !draftTo.trim()) return;
    setCrudBusy(true);
    try {
      const body = {
        [fromKey]: draftFrom.trim(),
        [toKey]:   draftTo.trim(),
        notes:     draftNotes.trim() || null
      };
      if (editingId) {
        await apiFetch(`${mappingsEndpoint}/${editingId}`, {
          method: 'PUT', body: JSON.stringify(body)
        });
      } else {
        await apiFetch(mappingsEndpoint, {
          method: 'POST', body: JSON.stringify(body)
        });
      }
      resetForm();
      loadMappings();
    } catch (err) {
      setMappingsError(formatError(err));
    } finally {
      setCrudBusy(false);
    }
  };

  const onDelete = async (id) => {
    if (!window.confirm(`Видалити правило?`)) return;
    setCrudBusy(true);
    try {
      await apiFetch(`${mappingsEndpoint}/${id}`, { method: 'DELETE' });
      if (editingId === id) resetForm();
      loadMappings();
    } catch (err) {
      setMappingsError(formatError(err));
    } finally {
      setCrudBusy(false);
    }
  };

  const onToggleActive = async (m) => {
    setCrudBusy(true);
    try {
      await apiFetch(`${mappingsEndpoint}/${m.id}`, {
        method: 'PUT',
        body: JSON.stringify({ isActive: !m.isActive })
      });
      loadMappings();
    } catch (err) {
      setMappingsError(formatError(err));
    } finally {
      setCrudBusy(false);
    }
  };

  const candidates = useMemo(() => {
    const lcHints = new Set(hintKeys.map((k) => String(k).toLowerCase().trim()));
    const result = [];
    Object.entries(detail.mergedAttributes || {}).forEach(([k, v]) => {
      if (lcHints.has(k.toLowerCase())) result.push({ key: k, value: String(v) });
    });
    return result;
  }, [detail.mergedAttributes, hintKeys]);

  return (
    <div style={{ maxHeight: '65vh', overflowY: 'auto' }}>
      <p className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
        {nounSing.charAt(0).toUpperCase() + nounSing.slice(1)} тут — це <strong>значення-кандидати</strong> з
        усіх постачальницьких <code>row_data</code> для майстер-поля <code>{fieldKey}</code>.
        Канонічне значення зберігається у Картці товару. Тут — допомога побачити усі варіанти написання
        і визначити правила нормалізації.
      </p>

      <div style={{ marginBottom: 18 }}>
        <h4 style={{ margin: '0 0 8px' }}>Кандидати {noun} з offers</h4>
        {candidates.length === 0 ? (
          <div className="muted">
            Жоден ключ row_data не зматчився з hint-ключами поля <code>{fieldKey}</code>.
            {hintKeys.length > 0 ? (
              <><br />Hint-ключі: <code>{hintKeys.join(', ')}</code></>
            ) : null}
          </div>
        ) : (
          <table className="data-table">
            <thead><tr>
              <th style={{ width: '40%' }}>Ключ постачальника</th>
              <th>Значення</th>
            </tr></thead>
            <tbody>
              {candidates.map((c, i) => (
                <tr key={`${c.key}-${i}`}>
                  <td><code>{c.key}</code></td>
                  <td>{c.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div>
        <h4 style={{ margin: '0 0 8px' }}>{mappingsTableName} (нормалізація)</h4>
        <p className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
          CatalogAssembler застосовує ці правила до <code>field_values[{fieldKey}]</code>
          при кожному запуску. Наприклад "navy" → "Синій".
        </p>

        {/* CRUD form */}
        <div style={{
          display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12,
          padding: 10, background: 'rgba(0,0,0,0.03)', borderRadius: 4
        }}>
          <div style={{ flex: '1 1 200px' }}>
            <label className="muted" style={{ fontSize: 11 }}>From (постачальницьке значення)</label>
            <input type="text" value={draftFrom}
              onChange={(e) => setDraftFrom(e.target.value)}
              placeholder="напр. navy"
              disabled={crudBusy} style={{ width: '100%' }} />
          </div>
          <div style={{ flex: '1 1 200px' }}>
            <label className="muted" style={{ fontSize: 11 }}>To (канонічне значення)</label>
            <input type="text" value={draftTo}
              onChange={(e) => setDraftTo(e.target.value)}
              placeholder="напр. Синій"
              disabled={crudBusy} style={{ width: '100%' }} />
          </div>
          <div style={{ flex: '1 1 160px' }}>
            <label className="muted" style={{ fontSize: 11 }}>Примітка (опц.)</label>
            <input type="text" value={draftNotes}
              onChange={(e) => setDraftNotes(e.target.value)}
              disabled={crudBusy} style={{ width: '100%' }} />
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4 }}>
            <button className="btn primary" onClick={onSave}
              disabled={crudBusy || !draftFrom.trim() || !draftTo.trim()}>
              {editingId ? 'Оновити' : 'Додати'}
            </button>
            {editingId ? (
              <button className="btn" onClick={resetForm} disabled={crudBusy}>Скасувати</button>
            ) : null}
          </div>
        </div>

        {mappingsLoading ? (
          <div className="muted">Завантаження...</div>
        ) : mappingsError ? (
          <div className="status-line error">{mappingsError}</div>
        ) : mappings.length === 0 ? (
          <div className="muted">
            <code>{mappingsTableName}</code> порожня. Додайте перше правило через форму вище.
          </div>
        ) : (
          <table className="data-table">
            <thead><tr>
              <th>{fromKey}</th>
              <th>{toKey}</th>
              <th>Активне</th>
              <th>Примітка</th>
              <th></th>
            </tr></thead>
            <tbody>
              {mappings.map((m) => (
                <tr key={m.id} style={{ opacity: m.isActive ? 1 : 0.5 }}>
                  <td><code>{m[fromKey]}</code></td>
                  <td><strong>{m[toKey]}</strong></td>
                  <td>
                    <input type="checkbox" checked={m.isActive}
                      onChange={() => onToggleActive(m)} disabled={crudBusy}
                      style={{ width: 'auto' }} />
                  </td>
                  <td className="muted">{m.notes || '—'}</td>
                  <td>
                    <button className="btn" onClick={() => startEdit(m)} disabled={crudBusy}
                      style={{ marginRight: 4 }}>✎</button>
                    <button className="btn danger" onClick={() => onDelete(m.id)} disabled={crudBusy}>✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// Thin wrappers — для readability у JSX вище.
function ColorTab({ detail }) {
  return <NormalizationTab
    detail={detail}
    fieldKey="color_uk"
    mappingsEndpoint="/catalog/color-mappings"
    fromKey="colorFrom"
    toKey="colorTo"
    noun="кольорів"
    nounSing="кольори"
    mappingsTableName="color_mappings" />;
}

function CategoryTab({ detail }) {
  return <NormalizationTab
    detail={detail}
    fieldKey="category_uk"
    mappingsEndpoint="/catalog/category-mappings"
    fromKey="categoryFrom"
    toKey="categoryTo"
    noun="категорій"
    nounSing="категорії"
    mappingsTableName="category_mappings" />;
}

// Групування master_fields за смисловими секціями для UX.
// Поля що не вказані тут — потраплять у "Інше" автоматично.
const FIELD_GROUPS = [
  { key: 'main',       label: 'Основне',             fieldKeys: ['name_uk', 'brand'] },
  { key: 'class',      label: 'Класифікація',         fieldKeys: ['category_uk', 'product_kind', 'product_type', 'model_name', 'gender', 'style'] },
  { key: 'specs',      label: 'Характеристики',       fieldKeys: ['color_uk', 'material', 'material_top', 'material_inner', 'material_sole', 'toe_shape', 'fastening'] },
  { key: 'context',    label: 'Призначення / Сезон',  fieldKeys: ['purpose', 'season', 'season_year', 'country'] },
  { key: 'marketing',  label: 'Маркетинг',            fieldKeys: ['old_price', 'gtin'] },
  { key: 'content',    label: 'Контент',              fieldKeys: ['photo', 'description_full_uk'] }
];

// ─── Card editor (master_fields with candidates) ─────────────────
function CardEditor({ masterId }) {
  const [card, setCard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState({});

  const reload = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const data = await apiFetch(`/catalog/masters/${masterId}/card`);
      setCard(data);
      setDirty({});
    } catch (err) { setError(formatError(err)); }
    finally { setLoading(false); }
  }, [masterId]);

  useEffect(() => { reload(); }, [reload]);

  const onChange = (fieldId, patch) => {
    setDirty((prev) => ({ ...prev, [fieldId]: { ...(prev[fieldId] || {}), ...patch } }));
  };
  const onClear = (fieldId) => onChange(fieldId, { value: '', sourceKey: null, sourceType: 'manual' });

  const onSave = async () => {
    const inputs = Object.entries(dirty).map(([fieldId, change]) => ({
      fieldId: Number(fieldId),
      value: change.value ?? null,
      source: change.sourceType || 'manual',
      sourceAttributeKey: change.sourceKey || null
    }));
    if (inputs.length === 0) return;
    setSaving(true); setError('');
    try {
      const data = await apiFetch(`/catalog/masters/${masterId}/card`, {
        method: 'PUT',
        body: JSON.stringify({ values: inputs })
      });
      setCard(data);
      setDirty({});
    } catch (err) { setError(formatError(err)); }
    finally { setSaving(false); }
  };

  const onApplySuggestions = () => {
    // Заповнити поля з mergedFieldValues для всіх field.key, де немає збереженого значення
    if (!card) return;
    const next = { ...dirty };
    card.fields.forEach((f) => {
      if (card.fieldValues[f.id]?.value) return;        // уже збережено
      if (next[f.id]?.value) return;                     // вже в dirty
      const suggestion = card.mergedFieldValues[f.key];
      if (suggestion) {
        next[f.id] = {
          value: suggestion,
          sourceKey: `merged:${f.key}`,
          sourceType: 'auto'
        };
      }
    });
    setDirty(next);
  };

  const [filter, setFilter] = useState('all');  // all | empty | filled
  // Які секції згорнуті (за замовч. усі розгорнуті).
  const [collapsedSections, setCollapsedSections] = useState({});

  if (loading) return <div className="status-line">Завантаження картки...</div>;
  if (error) return <div className="status-line error">{error}</div>;
  if (!card) return null;

  const dirtyCount = Object.keys(dirty).length;

  // Допоміжне: яке "поточне значення" поля (saved або dirty).
  const fieldEffectiveValue = (f) => {
    const dv = dirty[f.id]?.value;
    if (dv !== undefined && dv !== null) return dv;
    return card.fieldValues[f.id]?.value || '';
  };
  const isFieldFilled = (f) => String(fieldEffectiveValue(f) || '').trim().length > 0;

  // Розділяємо master_fields на групи + "Інше".
  const fieldsByKey = new Map(card.fields.map((f) => [f.key, f]));
  const usedKeys = new Set(FIELD_GROUPS.flatMap((g) => g.fieldKeys));
  const otherFields = card.fields.filter((f) => !usedKeys.has(f.key));
  const groups = FIELD_GROUPS
    .map((g) => ({
      ...g,
      fields: g.fieldKeys.map((k) => fieldsByKey.get(k)).filter(Boolean)
    }))
    .concat(otherFields.length > 0 ? [{ key: '_other', label: 'Інше', fields: otherFields }] : []);

  const filledTotal = card.fields.filter(isFieldFilled).length;
  const total = card.fields.length;
  const pct = total > 0 ? Math.round((filledTotal / total) * 100) : 0;

  const suggestionCount = card.fields.reduce((sum, f) => {
    const hasSaved = !!card.fieldValues[f.id]?.value;
    const hasDirty = !!dirty[f.id]?.value;
    const hasSuggestion = !!card.mergedFieldValues[f.key];
    return sum + (!hasSaved && !hasDirty && hasSuggestion ? 1 : 0);
  }, 0);

  const passesFilter = (f) => {
    if (filter === 'all') return true;
    const filled = isFieldFilled(f);
    return filter === 'filled' ? filled : !filled;
  };

  return (
    <div style={{ maxHeight: '65vh', overflowY: 'auto' }}>
      {/* Sticky header */}
      <div style={{
        position: 'sticky', top: 0, background: 'var(--panel-bg, #fff)', zIndex: 2,
        padding: '8px 0', marginBottom: 8,
        borderBottom: '1px solid rgba(0,0,0,0.08)'
      }}>
        <div className="actions" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
          <button className="btn primary" onClick={onSave} disabled={saving || dirtyCount === 0}>
            {saving ? 'Збереження...' : `Зберегти${dirtyCount ? ` (${dirtyCount})` : ''}`}
          </button>
          {suggestionCount > 0 ? (
            <button className="btn" onClick={onApplySuggestions} disabled={saving}
              title={`Заповнити ${suggestionCount} полів з даних постачальника (за пріоритетом)`}>
              Авто-заповнити ({suggestionCount})
            </button>
          ) : null}
          <button className="btn" onClick={reload} disabled={saving}>Скинути</button>
          <div style={{ flex: 1 }} />
          <div style={{ display: 'inline-flex', border: '1px solid rgba(0,0,0,0.15)', borderRadius: 4 }}>
            {[
              { v: 'all',    label: `Усі (${total})` },
              { v: 'filled', label: `Заповнені (${filledTotal})` },
              { v: 'empty',  label: `Порожні (${total - filledTotal})` }
            ].map((opt) => (
              <button
                key={opt.v}
                type="button"
                onClick={() => setFilter(opt.v)}
                style={{
                  padding: '4px 10px', fontSize: 12, border: 'none',
                  background: filter === opt.v ? '#3b82f6' : 'transparent',
                  color: filter === opt.v ? '#fff' : 'inherit',
                  cursor: 'pointer'
                }}
              >{opt.label}</button>
            ))}
          </div>
        </div>
        {/* Progress */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }} className="muted">
          <span>Заповнено: <strong>{filledTotal}/{total}</strong> ({pct}%)</span>
          <div style={{
            flex: 1, height: 4, background: 'rgba(0,0,0,0.08)', borderRadius: 2, overflow: 'hidden'
          }}>
            <div style={{
              width: `${pct}%`, height: '100%',
              background: pct >= 80 ? '#10b981' : pct >= 40 ? '#f59e0b' : '#94a3b8',
              transition: 'width 0.3s'
            }} />
          </div>
          {dirtyCount > 0 ? <span style={{ color: '#c2410c' }}>· Незбережено: {dirtyCount}</span> : null}
        </div>
      </div>

      {/* Sections */}
      {groups.map((g) => {
        const visibleFields = g.fields.filter(passesFilter);
        const filledInGroup = g.fields.filter(isFieldFilled).length;
        const isCollapsed = collapsedSections[g.key] === true;
        if (visibleFields.length === 0 && filter !== 'all') return null;

        return (
          <div key={g.key} style={{ marginBottom: 12 }}>
            <button
              type="button"
              onClick={() => setCollapsedSections((s) => ({ ...s, [g.key]: !isCollapsed }))}
              style={{
                width: '100%', textAlign: 'left',
                padding: '6px 0', background: 'transparent',
                border: 'none', borderBottom: '1px solid rgba(0,0,0,0.08)',
                cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8,
                fontSize: 13, fontWeight: 600
              }}
            >
              <span style={{ fontSize: 10 }}>{isCollapsed ? '▶' : '▼'}</span>
              <span>{g.label}</span>
              <span className="muted" style={{ fontWeight: 'normal', fontSize: 11 }}>
                {filledInGroup}/{g.fields.length}
              </span>
            </button>
            {!isCollapsed ? (
              <div style={{ paddingTop: 8 }}>
                {visibleFields.length === 0 ? (
                  <div className="muted" style={{ fontSize: 12, padding: 6 }}>
                    Немає полів за поточним фільтром
                  </div>
                ) : (
                  visibleFields.map((field) => (
                    <FieldRow key={field.id} field={field}
                      savedValue={card.fieldValues[field.id] || null}
                      dirty={dirty[field.id]}
                      variations={card.fieldVariations[field.key] || []}
                      mergedFieldValueSuggestion={card.mergedFieldValues[field.key]}
                      onChange={(patch) => onChange(field.id, patch)}
                      onClear={() => onClear(field.id)} />
                  ))
                )}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function FieldRow({ field, savedValue, dirty, variations, mergedFieldValueSuggestion, onChange, onClear }) {
  const currentValue = dirty?.value ?? savedValue?.value ?? '';
  const isLongText = field.dataType === 'long_text';
  const isPhoto = field.key === 'photo';
  const isDirty = !!dirty;
  const isFilled = String(currentValue || '').trim().length > 0;
  const hasVariations = variations.length > 0;

  // Status dot — швидке візуальне розрізнення стану.
  let statusColor = '#cbd5e1';   // gray — порожнє
  let statusTitle = 'Порожнє';
  if (isDirty)            { statusColor = '#f59e0b'; statusTitle = 'Незбережені зміни'; }
  else if (isFilled && savedValue?.source === 'manual')
                          { statusColor = '#10b981'; statusTitle = 'Збережено вручну'; }
  else if (isFilled)      { statusColor = '#3b82f6'; statusTitle = `Збережено (${savedValue?.source || 'auto'})`; }
  else if (field.isRequired) { statusColor = '#dc2626'; statusTitle = 'Обовʼязкове, порожнє'; }

  return (
    <div style={{ marginBottom: 10, paddingBottom: 8, borderBottom: '1px solid rgba(0,0,0,0.05)' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 3 }}>
        <span title={statusTitle} style={{
          width: 8, height: 8, borderRadius: '50%', background: statusColor, flexShrink: 0
        }} />
        <strong style={{ fontSize: 13 }}>
          {field.labelUk}{field.isRequired ? <span style={{ color: '#dc2626' }}>*</span> : null}
        </strong>
        <span className="muted" style={{ fontSize: 10, fontFamily: 'monospace' }}>{field.key}</span>
        {savedValue && !isDirty ? (
          <span className="muted" style={{ fontSize: 10 }}>
            {savedValue.source === 'manual' ? '✓ ручне' : '⚡ авто'}
            {savedValue.sourceAttributeKey ? ` · ${savedValue.sourceAttributeKey}` : ''}
          </span>
        ) : null}
        {isDirty ? <span style={{ fontSize: 10, color: '#c2410c', fontWeight: 600 }}>● змінено</span> : null}
      </div>

      <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
        {isPhoto ? (
          <div style={{ flex: 1 }}>
            <PhotoFieldEditor value={currentValue} onChange={onChange} onClear={onClear} />
          </div>
        ) : isLongText ? (
          <>
            <textarea
              style={{ flex: 1, minHeight: 60, fontFamily: 'inherit', fontSize: 13 }}
              value={currentValue}
              onChange={(e) => onChange({ value: e.target.value, sourceType: 'manual', sourceKey: null })}
              placeholder={hasVariations ? 'Введіть або оберіть варіацію' : 'Введіть значення'}
              title={field.descriptionUk || ''}
            />
            <button className="btn" onClick={onClear} title="Очистити" style={{ padding: '2px 8px' }}>✕</button>
          </>
        ) : (
          <>
            <input
              type="text" style={{ flex: 1, fontSize: 13 }}
              value={currentValue}
              onChange={(e) => onChange({ value: e.target.value, sourceType: 'manual', sourceKey: null })}
              placeholder={hasVariations ? 'Введіть або оберіть варіацію' : 'Введіть значення'}
              title={field.descriptionUk || ''}
            />
            <button className="btn" onClick={onClear} title="Очистити" style={{ padding: '2px 8px' }}>✕</button>
          </>
        )}
      </div>

      {hasVariations ? (
        <div style={{ marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: 3, alignItems: 'center' }}>
          {variations.slice(0, 5).map((v, i) => (
            <VariationChip key={`v-${v.value}`} v={v} selected={currentValue === v.value} isBest={i === 0}
              onPick={() => onChange({ value: v.value, sourceKey: `mapping:${field.key}`, sourceType: 'auto' })} />
          ))}
          {variations.length > 5 ? (
            <details style={{ display: 'inline' }}>
              <summary className="muted" style={{ fontSize: 11, cursor: 'pointer' }}>
                +{variations.length - 5}
              </summary>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, marginTop: 3 }}>
                {variations.slice(5).map((v) => (
                  <VariationChip key={`vr-${v.value}`} v={v} selected={currentValue === v.value} isBest={false}
                    onPick={() => onChange({ value: v.value, sourceKey: `mapping:${field.key}`, sourceType: 'auto' })} />
                ))}
              </div>
            </details>
          ) : null}
        </div>
      ) : (
        <span className="muted" title={`Жоден постачальник не мапить колонку на ${field.key}. Розширте мапінг у джерелах та перезберіть каталог.`}
          style={{ fontSize: 10, marginTop: 3, display: 'inline-block' }}>
          ⊘ не замапено
        </span>
      )}
    </div>
  );
}

// ─── PhotoFieldEditor ───────────────────────────────────────────
// Спеціальний редактор для поля photo: парсить URL зі значення (роздільники ';'
// або переніс рядка), малює мініатюри, дає видаляти/додавати окремі URL.
//
// Формат зберігання — string з URL через ';\n' (як зазвичай приходить від
// постачальника). Це сумісно з тим, що цей же текст іде в CS-Cart при пуш-і.
function PhotoFieldEditor({ value, onChange, onClear }) {
  const urls = useMemo(() => parsePhotoUrls(value), [value]);
  const [newUrl, setNewUrl] = useState('');

  const setUrls = (next) => {
    onChange({ value: serializePhotoUrls(next), sourceType: 'manual', sourceKey: null });
  };
  const removeUrl = (idx) => {
    const next = urls.filter((_, i) => i !== idx);
    setUrls(next);
  };
  const addUrl = () => {
    const trimmed = newUrl.trim();
    if (!trimmed) return;
    if (urls.includes(trimmed)) { setNewUrl(''); return; }
    setUrls([...urls, trimmed]);
    setNewUrl('');
  };
  const moveUrl = (from, to) => {
    if (to < 0 || to >= urls.length) return;
    const next = urls.slice();
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    setUrls(next);
  };

  return (
    <div>
      {urls.length === 0 ? (
        <div className="muted" style={{ fontSize: 12, padding: 8, border: '1px dashed rgba(0,0,0,0.15)', borderRadius: 4, marginBottom: 8 }}>
          Фото відсутні. Додайте URL нижче або клікніть варіацію з мапінгу.
        </div>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
          {urls.map((url, idx) => (
            <PhotoThumb
              key={`${idx}-${url}`}
              url={url}
              index={idx}
              total={urls.length}
              onRemove={() => removeUrl(idx)}
              onMoveLeft={() => moveUrl(idx, idx - 1)}
              onMoveRight={() => moveUrl(idx, idx + 1)}
            />
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        <input
          type="text"
          placeholder="https://... (Enter щоб додати)"
          value={newUrl}
          onChange={(e) => setNewUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); addUrl(); }
          }}
          style={{ flex: 1 }}
        />
        <button className="btn" onClick={addUrl} disabled={!newUrl.trim()}>+ Додати</button>
        {urls.length > 0 ? (
          <button className="btn" onClick={onClear} title="Очистити всі фото">✕ Усе</button>
        ) : null}
      </div>

      {urls.length > 0 ? (
        <details style={{ marginTop: 6 }}>
          <summary className="muted" style={{ fontSize: 11, cursor: 'pointer' }}>
            Сирий текст ({urls.length} URL)
          </summary>
          <textarea readOnly value={value || ''}
            style={{ width: '100%', minHeight: 50, marginTop: 4, fontSize: 11, fontFamily: 'monospace' }} />
        </details>
      ) : null}
    </div>
  );
}

function PhotoThumb({ url, index, total, onRemove, onMoveLeft, onMoveRight }) {
  const [errored, setErrored] = useState(false);
  return (
    <div style={{
      position: 'relative', width: 90, height: 90,
      border: '1px solid rgba(0,0,0,0.15)', borderRadius: 4, overflow: 'hidden',
      background: '#f8fafc'
    }}>
      {errored ? (
        <div style={{
          width: '100%', height: '100%',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 10, color: '#94a3b8', textAlign: 'center', padding: 6
        }}>
          ⚠ Не завантажено
        </div>
      ) : (
        <a href={url} target="_blank" rel="noopener noreferrer" title={url}>
          <img
            src={url}
            alt=""
            referrerPolicy="no-referrer"
            onError={() => setErrored(true)}
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        </a>
      )}
      {/* Reorder arrows */}
      {index > 0 ? (
        <button type="button" title="Лівіше"
          onClick={onMoveLeft}
          style={{
            position: 'absolute', left: 2, bottom: 2,
            width: 20, height: 20, padding: 0, fontSize: 11,
            background: 'rgba(255,255,255,0.9)', border: '1px solid rgba(0,0,0,0.15)',
            borderRadius: 2, cursor: 'pointer'
          }}>◀</button>
      ) : null}
      {index < total - 1 ? (
        <button type="button" title="Правіше"
          onClick={onMoveRight}
          style={{
            position: 'absolute', left: 24, bottom: 2,
            width: 20, height: 20, padding: 0, fontSize: 11,
            background: 'rgba(255,255,255,0.9)', border: '1px solid rgba(0,0,0,0.15)',
            borderRadius: 2, cursor: 'pointer'
          }}>▶</button>
      ) : null}
      <button type="button" title="Видалити" onClick={onRemove}
        style={{
          position: 'absolute', top: 2, right: 2,
          width: 20, height: 20, padding: 0, fontSize: 12,
          background: 'rgba(220,38,38,0.95)', color: '#fff',
          border: 'none', borderRadius: '50%', cursor: 'pointer', lineHeight: 1
        }}>✕</button>
      <div style={{
        position: 'absolute', top: 2, left: 2,
        background: 'rgba(0,0,0,0.55)', color: '#fff',
        padding: '1px 4px', borderRadius: 2, fontSize: 10
      }}>{index + 1}/{total}</div>
    </div>
  );
}

function parsePhotoUrls(value) {
  if (!value) return [];
  return String(value)
    .split(/[;\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function serializePhotoUrls(urls) {
  return (urls || []).filter((u) => String(u).trim()).join(';\n');
}

function VariationChip({ v, selected, isBest, onPick }) {
  const supplierLabel = v.supplierNames.length === 1
    ? v.supplierNames[0]
    : `${v.supplierNames.length} постач.`;
  const displayValue = v.value.length > 40 ? v.value.slice(0, 40) + '…' : v.value;
  return (
    <button type="button" onClick={onPick}
      title={`${v.value}\n\nПостачальники: ${v.supplierNames.join(', ')}\nOffers: ${v.offerCount}`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 6px',
        borderRadius: 3,
        border: '1px solid ' + (selected ? '#3b82f6' : isBest ? '#10b981' : 'rgba(0,0,0,0.15)'),
        background: selected ? '#dbeafe' : isBest ? '#ecfdf5' : '#fff',
        cursor: 'pointer', fontSize: 11, maxWidth: 340, textAlign: 'left', lineHeight: 1.3
      }}>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {displayValue}
      </span>
      <span style={{ color: '#94a3b8', fontSize: 9, whiteSpace: 'nowrap' }}>
        {supplierLabel}{v.offerCount > 1 ? `·${v.offerCount}×` : ''}
      </span>
    </button>
  );
}

