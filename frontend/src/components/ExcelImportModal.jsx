import React, { useState } from 'react';
import { Tag } from './ui';
import { apiUpload } from '../lib/api';

// Людські назви полів каталогу для таблиці мапінгу.
const FIELD_LABELS = {
  name_uk: 'Назва (UA)', brand: 'Бренд', category_uk: 'Категорія',
  photo: 'Фото', description_full_uk: 'Опис', old_price: 'Стара ціна',
  product_kind: 'Вид товару', product_type: 'Тип', color_uk: 'Колір',
  model_name: 'Модель', gender: 'Стать', style: 'Стиль', material: 'Матеріал',
  material_top: 'Матеріал верху', material_inner: 'Матеріал всередині',
  material_sole: 'Матеріал підошви', toe_shape: 'Вид носка', fastening: 'Застібка',
  purpose: 'Призначення', season: 'Сезон', season_year: 'Сезон за роками',
  country: 'Країна', gtin: 'GTIN'
};
const ALL_FIELDS = Object.keys(FIELD_LABELS);
// Поля-ідентифікатори: беруться з «чистого» файлу, не перезаписуються другим імпортом.
const IDENTITY_FIELDS = ['name_uk', 'brand', 'category_uk'];

/**
 * ExcelImportModal — імпорт товарів з Excel у master_catalog.
 *
 * Флоу: вибір файлу → preview (аркуші, заголовки, перші очищені рядки,
 * підказки SKU/виключених колонок) → користувач коригує → імпорт → підсумок.
 * Файл тримається у state браузера і відправляється двічі (preview + import) —
 * сервер нічого не зберігає на диску.
 */
export function ExcelImportModal({ apiFetch, onClose, onAfterImport }) {
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // mode: 'feed_params' — дані в feed_params для AI; 'direct' — прямо в поля каталогу.
  const [mode, setMode] = useState('feed_params');
  const [sheetName, setSheetName] = useState('');
  const [skuColumn, setSkuColumn] = useState('');
  const [excludedSet, setExcludedSet] = useState(() => new Set());
  const [photoColumn, setPhotoColumn] = useState('');
  const [overwritePhoto, setOverwritePhoto] = useState(false);
  // Режим «прямо в поля»:
  const [fieldMapping, setFieldMapping] = useState({}); // {field: 'columnLabel' | ''}
  const [updateOnly, setUpdateOnly] = useState(false);
  const [overwriteFilled, setOverwriteFilled] = useState(false);

  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null);
  const [savingDefaults, setSavingDefaults] = useState(false);

  const runPreview = async (f, sheet) => {
    setLoading(true);
    setError('');
    setImportResult(null);
    try {
      const fd = new FormData();
      fd.append('file', f);
      if (sheet) fd.append('sheetName', sheet);
      const p = await apiUpload('/master-catalog/excel/preview', fd);
      setPreview(p);
      setSheetName(p.sheetName);
      setSkuColumn(p.suggestedSkuColumn || '');
      setExcludedSet(new Set(p.suggestedExcludedColumns || []));
      setPhotoColumn('');
      // Авто-мапінг полів: {field: перша запропонована колонка}.
      const mapObj = {};
      for (const e of p.suggestedFieldMapping || []) {
        if (e.columns && e.columns.length) mapObj[e.field] = e.columns[0];
      }
      setFieldMapping(mapObj);
    } catch (err) {
      setError(err?.message || 'preview_error');
      setPreview(null);
    } finally {
      setLoading(false);
    }
  };

  const onFileChange = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setFile(f);
    await runPreview(f, '');
  };

  const onSheetChange = async (name) => {
    setSheetName(name);
    if (file) await runPreview(file, name);
  };

  const toggleExcluded = (label) => {
    setExcludedSet((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  };

  const setFieldColumn = (field, column) => {
    setFieldMapping((prev) => {
      const next = { ...prev };
      if (column) next[field] = column;
      else delete next[field];
      return next;
    });
  };

  const mappedCount = Object.values(fieldMapping).filter(Boolean).length;

  const runImport = async () => {
    if (!file || !skuColumn || importing) return;
    setImporting(true);
    setError('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('skuColumn', skuColumn);
      if (sheetName) fd.append('sheetName', sheetName);

      let endpoint;
      if (mode === 'direct') {
        if (mappedCount === 0) {
          setError('Зістав хоча б одне поле з колонкою.');
          setImporting(false);
          return;
        }
        if (!window.confirm(
          `Імпорт «прямо в поля» з "${file.name}" (~${preview?.totalRows} рядків)?\n` +
          `Зіставлено полів: ${mappedCount}. ${updateOnly ? 'Тільки оновлення наявних SKU.' : 'Створення + оновлення.'}\n` +
          `${overwriteFilled ? 'Перезаписує заповнені поля.' : 'Заповнює лише порожні (захищає вже заповнене).'}`
        )) { setImporting(false); return; }
        const fieldMappingArr = Object.entries(fieldMapping)
          .filter(([, col]) => col)
          .map(([field, col]) => ({ field, columns: [col] }));
        fd.append('fieldMapping', JSON.stringify(fieldMappingArr));
        fd.append('updateOnly', updateOnly ? 'true' : 'false');
        fd.append('overwriteFilled', overwriteFilled ? 'true' : 'false');
        endpoint = '/master-catalog/excel/import-direct';
      } else {
        if (!window.confirm(
          `Імпортувати "${file.name}" у feed_params (для AI, ~${preview?.totalRows} рядків)?\n` +
          `SKU: "${skuColumn}". Виключено колонок: ${excludedSet.size}.`
        )) { setImporting(false); return; }
        fd.append('excludedColumns', JSON.stringify(Array.from(excludedSet)));
        if (photoColumn) fd.append('photoColumn', photoColumn);
        if (overwritePhoto) fd.append('overwritePhoto', 'true');
        endpoint = '/master-catalog/excel/import';
      }

      const result = await apiUpload(endpoint, fd);
      setImportResult(result);
      if (onAfterImport) await onAfterImport();
    } catch (err) {
      setError(err?.message || 'import_error');
    } finally {
      setImporting(false);
    }
  };

  const saveExcludedAsDefault = async () => {
    if (savingDefaults) return;
    setSavingDefaults(true);
    try {
      await apiFetch('/settings/excel-excluded-columns', {
        method: 'PUT',
        body: JSON.stringify({ columns: Array.from(excludedSet) })
      });
      alert('Збережено як стандартний список виключень.');
    } catch (err) {
      alert('Помилка: ' + (err?.message || 'unknown'));
    } finally {
      setSavingDefaults(false);
    }
  };

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
      background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999
    }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: 'white', maxWidth: 1100, width: '95%', maxHeight: '92vh',
        overflow: 'auto', borderRadius: 8, padding: 20, boxShadow: '0 4px 20px rgba(0,0,0,0.3)'
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>📥 Імпорт товарів з Excel</h3>
          <button className="btn" onClick={onClose}>Закрити</button>
        </div>

        <div style={{ marginBottom: 12 }}>
          <input type="file" accept=".xlsx,.xls" onChange={onFileChange} disabled={loading || importing} />
          {file ? <span style={{ marginLeft: 8, fontSize: 12, color: '#666' }}>{file.name} ({(file.size / 1024 / 1024).toFixed(1)} MB)</span> : null}
        </div>

        {loading ? <div style={{ padding: 20, textAlign: 'center' }}>⏳ Аналізую файл…</div> : null}
        {error ? <div style={{ background: '#fee', color: '#a00', padding: 8, borderRadius: 4, marginBottom: 12 }}>{error}</div> : null}

        {importResult ? (
          <div style={{ background: '#d4edda', padding: 12, borderRadius: 6, marginBottom: 12 }}>
            <strong>✅ Імпорт завершено</strong> (аркуш "{importResult.sheetName}", {(importResult.durationMs / 1000).toFixed(1)}с)
            <div style={{ marginTop: 6, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Tag tone="ok">Створено: {importResult.created}</Tag>
              <Tag tone="ok">Оновлено: {importResult.updated}</Tag>
              {importResult.skippedNoSku > 0 ? <Tag tone="warn">Без SKU: {importResult.skippedNoSku}</Tag> : null}
              {importResult.skippedNoMatch > 0 ? <Tag tone="warn">SKU не знайдено: {importResult.skippedNoMatch}</Tag> : null}
              {importResult.dedupedSkus > 0 ? <Tag tone="warn">Дублікати SKU: {importResult.dedupedSkus}</Tag> : null}
              {typeof importResult.fieldsWritten === 'number' ? <Tag tone="ok">Полів записано: {importResult.fieldsWritten}</Tag> : null}
              <Tag>Всього рядків: {importResult.totalRows}</Tag>
            </div>
          </div>
        ) : null}

        {preview && !importResult ? (
          <div style={{ display: 'flex', gap: 6, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <strong style={{ fontSize: 12 }}>Режим:</strong>
            <button
              className={'btn btn-sm' + (mode === 'feed_params' ? ' primary' : '')}
              onClick={() => setMode('feed_params')}
              title="Усі колонки → feed_params, далі заповнення через AI"
            >
              🤖 Дані для AI (feed_params)
            </button>
            <button
              className={'btn btn-sm' + (mode === 'direct' ? ' primary' : '')}
              onClick={() => setMode('direct')}
              title="Колонки копіюються прямо в поля каталогу, без AI"
            >
              📋 Прямо в поля каталогу
            </button>
          </div>
        ) : null}

        {preview && !importResult ? (
          <>
            {/* Налаштування */}
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 12, alignItems: 'flex-end' }}>
              {preview.sheetNames.length > 1 ? (
                <label style={{ fontSize: 12 }}>
                  Аркуш:
                  <select value={sheetName} onChange={(e) => onSheetChange(e.target.value)} style={{ marginLeft: 4 }}>
                    {preview.sheetNames.map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                </label>
              ) : null}
              <label style={{ fontSize: 12 }}>
                Колонка SKU: <span style={{ color: '#a00' }}>*</span>
                <select value={skuColumn} onChange={(e) => setSkuColumn(e.target.value)} style={{ marginLeft: 4 }}>
                  <option value="">— обрати —</option>
                  {preview.headers.map((h) => (
                    <option key={h.letter} value={h.label}>{h.letter}: {h.label}</option>
                  ))}
                </select>
              </label>
              {mode === 'feed_params' ? (
                <label style={{ fontSize: 12 }}>
                  Колонка фото (не йде в AI):
                  <select value={photoColumn} onChange={(e) => setPhotoColumn(e.target.value)} style={{ marginLeft: 4 }}>
                    <option value="">— немає —</option>
                    {preview.headers.map((h) => (
                      <option key={h.letter} value={h.label}>{h.letter}: {h.label}</option>
                    ))}
                  </select>
                </label>
              ) : null}
              {mode === 'feed_params' && photoColumn ? (
                <label style={{ fontSize: 12 }}>
                  <input type="checkbox" checked={overwritePhoto} onChange={(e) => setOverwritePhoto(e.target.checked)} />
                  {' '}перезаписувати існуюче фото
                </label>
              ) : null}
              <span style={{ fontSize: 12, color: '#666' }}>
                Рядків даних: <b>{preview.totalRows}</b> · Колонок: <b>{preview.headers.length}</b>
              </span>
            </div>

            {/* ── Режим «прямо в поля»: таблиця мапінгу ── */}
            {mode === 'direct' ? (
              <div style={{ marginBottom: 12 }}>
                <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
                  <strong style={{ fontSize: 13 }}>📋 Зіставлення колонок → поля каталогу ({mappedCount})</strong>
                  <label style={{ fontSize: 12 }} title="Не створювати нові SKU — лише доповнювати наявні. Для другого файлу (доповнення).">
                    <input type="checkbox" checked={updateOnly} onChange={(e) => setUpdateOnly(e.target.checked)} />
                    {' '}тільки оновлювати наявні SKU
                  </label>
                  <label style={{ fontSize: 12 }} title="Якщо вимкнено — заповнює лише порожні поля, не чіпає вже заповнені (захищає name/brand/category).">
                    <input type="checkbox" checked={overwriteFilled} onChange={(e) => setOverwriteFilled(e.target.checked)} />
                    {' '}перезаписувати заповнені поля
                  </label>
                </div>
                <div style={{ fontSize: 11, color: '#888', marginBottom: 8 }}>
                  Кожне поле ← обрана колонка. Порожній вибір = поле не чіпається.
                  {!overwriteFilled ? ' Вже заповнені поля (name/brand/category з першого файлу) захищені.' : ''}
                </div>
                <div style={{
                  display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
                  gap: 4, maxHeight: 320, overflow: 'auto', border: '1px solid #eee', borderRadius: 4, padding: 8
                }}>
                  {ALL_FIELDS.map((field) => (
                    <label key={field} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 11 }}>
                      <span style={{
                        width: 130, flexShrink: 0,
                        fontWeight: IDENTITY_FIELDS.includes(field) ? 700 : 400,
                        color: IDENTITY_FIELDS.includes(field) ? '#1a7f37' : '#333'
                      }} title={field}>
                        {FIELD_LABELS[field]}{IDENTITY_FIELDS.includes(field) ? ' 🔒' : ''}
                      </span>
                      <select
                        value={fieldMapping[field] || ''}
                        onChange={(e) => setFieldColumn(field, e.target.value)}
                        style={{ flex: 1, fontSize: 11 }}
                      >
                        <option value="">— не чіпати —</option>
                        {preview.headers.map((h) => (
                          <option key={h.letter} value={h.label}>{h.label}</option>
                        ))}
                      </select>
                    </label>
                  ))}
                </div>
                <div style={{ fontSize: 11, color: '#888', marginTop: 6 }}>
                  🔒 = поле-ідентифікатор з «чистого» файлу. При доповненні (другий файл) лиши «перезаписувати» вимкненим, щоб їх не зачепити.
                </div>
              </div>
            ) : null}

            {/* Виключені колонки (тільки feed_params режим) */}
            {mode === 'feed_params' ? (
            <details style={{ marginBottom: 12 }} open={excludedSet.size === 0}>
              <summary style={{ cursor: 'pointer', fontWeight: 600, color: '#4a90e2' }}>
                🚫 Виключені колонки ({excludedSet.size} з {preview.headers.length}) — не підуть в AI (економія токенів)
              </summary>
              <div style={{
                display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
                gap: 2, marginTop: 8, maxHeight: 260, overflow: 'auto', fontSize: 11,
                border: '1px solid #eee', borderRadius: 4, padding: 8
              }}>
                {preview.headers.map((h) => (
                  <label key={h.letter} style={{ display: 'flex', gap: 4, alignItems: 'center', opacity: h.label === skuColumn ? 0.4 : 1 }}>
                    <input
                      type="checkbox"
                      checked={excludedSet.has(h.label)}
                      disabled={h.label === skuColumn}
                      onChange={() => toggleExcluded(h.label)}
                    />
                    <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={h.label}>
                      {h.letter}: {h.label}
                    </span>
                  </label>
                ))}
              </div>
              <button className="btn btn-sm" style={{ marginTop: 6 }} disabled={savingDefaults} onClick={saveExcludedAsDefault}>
                💾 Зберегти список як стандарт
              </button>
            </details>
            ) : null}

            {/* Preview рядків */}
            <details open style={{ marginBottom: 12 }}>
              <summary style={{ cursor: 'pointer', fontWeight: 600, color: '#4a90e2' }}>
                👁 Перші рядки після очистки
              </summary>
              <div style={{ maxHeight: 300, overflow: 'auto', marginTop: 8, fontSize: 11 }}>
                {preview.rows.map((r, i) => (
                  <pre key={i} style={{
                    background: '#f8f8f8', padding: 6, borderRadius: 4, margin: '4px 0',
                    whiteSpace: 'pre-wrap', maxHeight: 150, overflow: 'auto'
                  }}>
                    {JSON.stringify(r, null, 1)}
                  </pre>
                ))}
              </div>
            </details>

            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button
                className="btn primary"
                disabled={!skuColumn || importing || (mode === 'direct' && mappedCount === 0)}
                onClick={runImport}
                title={!skuColumn ? 'Обери колонку SKU' : ''}
              >
                {importing ? '⏳ Імпортую…'
                  : mode === 'direct'
                    ? `📋 Імпортувати в поля (${mappedCount}) — ${preview.totalRows} рядків`
                    : `📥 Імпортувати ${preview.totalRows} рядків`}
              </button>
              {importing ? <span style={{ fontSize: 12, color: '#666' }}>Великий файл може зайняти до хвилини…</span> : null}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
