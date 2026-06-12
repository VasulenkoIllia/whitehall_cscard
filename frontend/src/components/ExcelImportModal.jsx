import React, { useState } from 'react';
import { Tag } from './ui';
import { apiUpload } from '../lib/api';

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

  const [sheetName, setSheetName] = useState('');
  const [skuColumn, setSkuColumn] = useState('');
  const [excludedSet, setExcludedSet] = useState(() => new Set());
  const [photoColumn, setPhotoColumn] = useState('');
  const [overwritePhoto, setOverwritePhoto] = useState(false);

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

  const runImport = async () => {
    if (!file || !skuColumn || importing) return;
    if (!window.confirm(
      `Імпортувати "${file.name}" (аркуш "${sheetName}", ~${preview?.totalRows} рядків)?\n` +
      `SKU: колонка "${skuColumn}". Виключено колонок: ${excludedSet.size}.\n` +
      `Існуючі SKU будуть оновлені, нові — створені.`
    )) return;
    setImporting(true);
    setError('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('skuColumn', skuColumn);
      fd.append('excludedColumns', JSON.stringify(Array.from(excludedSet)));
      if (sheetName) fd.append('sheetName', sheetName);
      if (photoColumn) fd.append('photoColumn', photoColumn);
      if (overwritePhoto) fd.append('overwritePhoto', 'true');
      const result = await apiUpload('/master-catalog/excel/import', fd);
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
              {importResult.dedupedSkus > 0 ? <Tag tone="warn">Дублікати SKU: {importResult.dedupedSkus}</Tag> : null}
              <Tag>Всього рядків: {importResult.totalRows}</Tag>
            </div>
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
              <label style={{ fontSize: 12 }}>
                Колонка фото (не йде в AI):
                <select value={photoColumn} onChange={(e) => setPhotoColumn(e.target.value)} style={{ marginLeft: 4 }}>
                  <option value="">— немає —</option>
                  {preview.headers.map((h) => (
                    <option key={h.letter} value={h.label}>{h.letter}: {h.label}</option>
                  ))}
                </select>
              </label>
              {photoColumn ? (
                <label style={{ fontSize: 12 }}>
                  <input type="checkbox" checked={overwritePhoto} onChange={(e) => setOverwritePhoto(e.target.checked)} />
                  {' '}перезаписувати існуюче фото
                </label>
              ) : null}
              <span style={{ fontSize: 12, color: '#666' }}>
                Рядків даних: <b>{preview.totalRows}</b> · Колонок: <b>{preview.headers.length}</b>
              </span>
            </div>

            {/* Виключені колонки */}
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

            {/* Preview рядків */}
            <details open style={{ marginBottom: 12 }}>
              <summary style={{ cursor: 'pointer', fontWeight: 600, color: '#4a90e2' }}>
                👁 Перші рядки після очистки (що реально піде в AI)
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
                disabled={!skuColumn || importing}
                onClick={runImport}
                title={!skuColumn ? 'Обери колонку SKU' : ''}
              >
                {importing ? '⏳ Імпортую…' : `📥 Імпортувати ${preview.totalRows} рядків`}
              </button>
              {importing ? <span style={{ fontSize: 12, color: '#666' }}>Великий файл може зайняти до хвилини…</span> : null}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
