import React, { useEffect, useState, useCallback } from 'react';
import { Tag } from './ui';

/**
 * AiSettingsPanel — налаштування AI enrichment:
 *   1. Редагований system prompt (зберігається в app_settings, fallback = вбудований).
 *   2. Власний Anthropic API ключ (write-only: у форму ніколи не повертається,
 *      сервер віддає тільки маску + джерело db/env).
 */
export function AiSettingsPanel({ apiFetch, isReadOnly, onSettingsChanged }) {
  const [open, setOpen] = useState(false);

  // Prompt state
  const [prompt, setPrompt] = useState('');
  const [promptMeta, setPromptMeta] = useState(null); // {isCustom, version, defaultPrompt}
  const [promptDirty, setPromptDirty] = useState(false);
  const [promptSaving, setPromptSaving] = useState(false);
  const [promptStatus, setPromptStatus] = useState('');
  const [showDefault, setShowDefault] = useState(false);

  // API key state
  const [keyInfo, setKeyInfo] = useState(null); // {configured, source, masked}
  const [keyInput, setKeyInput] = useState('');
  const [keySaving, setKeySaving] = useState(false);
  const [keyStatus, setKeyStatus] = useState('');

  const loadAll = useCallback(async () => {
    try {
      const p = await apiFetch('/settings/enrichment-prompt');
      setPrompt(p.prompt || '');
      setPromptMeta(p);
      setPromptDirty(false);
    } catch (err) {
      setPromptStatus(`Помилка завантаження промпта: ${err?.message || 'unknown'}`);
    }
    try {
      const k = await apiFetch('/settings/anthropic-key');
      setKeyInfo(k);
    } catch {
      // viewer без admin-прав отримає 403 — ключ просто не показуємо
      setKeyInfo(null);
    }
  }, [apiFetch]);

  useEffect(() => {
    if (open) void loadAll();
  }, [open, loadAll]);

  const savePrompt = async () => {
    if (promptSaving) return;
    setPromptSaving(true);
    setPromptStatus('');
    try {
      const result = await apiFetch('/settings/enrichment-prompt', {
        method: 'PUT',
        body: JSON.stringify({ prompt })
      });
      setPromptMeta((prev) => ({ ...prev, ...result }));
      setPrompt(result.prompt || '');
      setPromptDirty(false);
      setPromptStatus(result.isCustom ? `✓ Збережено (${result.version})` : '✓ Скинуто до стандартного');
      if (onSettingsChanged) onSettingsChanged();
    } catch (err) {
      setPromptStatus(`Помилка: ${err?.message || 'unknown'}`);
    } finally {
      setPromptSaving(false);
    }
  };

  const resetPrompt = async () => {
    if (promptSaving) return;
    if (!window.confirm('Скинути промпт до стандартного? Кастомний промпт буде видалено.')) return;
    setPromptSaving(true);
    setPromptStatus('');
    try {
      const result = await apiFetch('/settings/enrichment-prompt', {
        method: 'PUT',
        body: JSON.stringify({ prompt: '' })
      });
      setPrompt(result.prompt || '');
      setPromptMeta((prev) => ({ ...prev, ...result }));
      setPromptDirty(false);
      setPromptStatus('✓ Скинуто до стандартного');
      if (onSettingsChanged) onSettingsChanged();
    } catch (err) {
      setPromptStatus(`Помилка: ${err?.message || 'unknown'}`);
    } finally {
      setPromptSaving(false);
    }
  };

  const saveKey = async () => {
    if (keySaving || !keyInput.trim()) return;
    setKeySaving(true);
    setKeyStatus('');
    try {
      const result = await apiFetch('/settings/anthropic-key', {
        method: 'PUT',
        body: JSON.stringify({ apiKey: keyInput.trim() })
      });
      setKeyInfo(result);
      setKeyInput('');
      setKeyStatus('✓ Ключ збережено — використовується для всіх AI запитів');
      if (onSettingsChanged) onSettingsChanged();
    } catch (err) {
      setKeyStatus(`Помилка: ${err?.message || 'unknown'}`);
    } finally {
      setKeySaving(false);
    }
  };

  const deleteKey = async () => {
    if (keySaving) return;
    if (!window.confirm('Видалити власний ключ і повернутись до серверного (env)?')) return;
    setKeySaving(true);
    setKeyStatus('');
    try {
      const result = await apiFetch('/settings/anthropic-key', { method: 'DELETE' });
      setKeyInfo(result);
      setKeyStatus(result.configured ? '✓ Повернулись до env ключа' : '⚠ Ключів немає — AI недоступний');
      if (onSettingsChanged) onSettingsChanged();
    } catch (err) {
      setKeyStatus(`Помилка: ${err?.message || 'unknown'}`);
    } finally {
      setKeySaving(false);
    }
  };

  return (
    <div style={{ border: '1px solid #d0d7e2', borderRadius: 6, marginBottom: 12, background: '#fcfdff' }}>
      <div
        style={{ padding: '8px 10px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8 }}
        onClick={() => setOpen((v) => !v)}
      >
        <strong>⚙️ AI налаштування</strong>
        {promptMeta ? (
          <Tag tone={promptMeta.isCustom ? 'warn' : 'ok'}>
            промпт: {promptMeta.version || 'v1'}
          </Tag>
        ) : null}
        {keyInfo ? (
          <Tag tone={keyInfo.configured ? 'ok' : 'error'}>
            ключ: {keyInfo.configured ? `${keyInfo.masked} (${keyInfo.source})` : 'не задано'}
          </Tag>
        ) : null}
        <span style={{ marginLeft: 'auto', color: '#888', fontSize: 12 }}>{open ? '▲ згорнути' : '▼ розгорнути'}</span>
      </div>

      {open ? (
        <div style={{ padding: '0 10px 10px' }}>
          {/* ─── Prompt editor ─────────────────────────────────────────── */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
              <strong style={{ fontSize: 13 }}>📜 System prompt для enrichment</strong>
              {promptMeta?.isCustom ? <Tag tone="warn">кастомний ({promptMeta.version})</Tag> : <Tag tone="ok">стандартний (v1)</Tag>}
              {promptDirty ? <Tag tone="error">не збережено</Tag> : null}
            </div>
            <textarea
              value={prompt}
              onChange={(e) => { setPrompt(e.target.value); setPromptDirty(true); }}
              disabled={isReadOnly}
              rows={16}
              spellCheck={false}
              style={{
                width: '100%', fontFamily: 'monospace', fontSize: 11, padding: 8,
                border: '1px solid #ccc', borderRadius: 4, boxSizing: 'border-box', resize: 'vertical'
              }}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <button className="btn btn-sm primary" disabled={isReadOnly || promptSaving || !promptDirty} onClick={savePrompt}>
                {promptSaving ? '⏳...' : '💾 Зберегти промпт'}
              </button>
              <button className="btn btn-sm" disabled={isReadOnly || promptSaving || !promptMeta?.isCustom} onClick={resetPrompt}>
                ↩ Скинути до стандартного
              </button>
              <button className="btn btn-sm" onClick={() => setShowDefault((v) => !v)}>
                {showDefault ? 'Сховати стандартний' : '👁 Показати стандартний'}
              </button>
              {promptStatus ? <span style={{ fontSize: 12, color: promptStatus.startsWith('✓') ? '#1a7f37' : '#a00' }}>{promptStatus}</span> : null}
            </div>
            <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>
              ⚠ Вже збагачені рядки зберігають стару версію промпта. Щоб прогнати з новим промптом —
              використовуй «Enrich — переписати» (інакше заповнені поля будуть пропущені).
            </div>
            {showDefault && promptMeta?.defaultPrompt ? (
              <pre style={{
                background: '#f8f8f8', padding: 8, fontSize: 10, overflow: 'auto',
                maxHeight: 300, whiteSpace: 'pre-wrap', border: '1px solid #eee', borderRadius: 4, marginTop: 6
              }}>
                {promptMeta.defaultPrompt}
              </pre>
            ) : null}
          </div>

          {/* ─── API key ───────────────────────────────────────────────── */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
              <strong style={{ fontSize: 13 }}>🔑 Anthropic API ключ</strong>
              {keyInfo?.configured ? (
                <Tag tone="ok">{keyInfo.masked} · джерело: {keyInfo.source === 'db' ? 'власний (БД)' : 'серверний (env)'}</Tag>
              ) : (
                <Tag tone="error">не задано — AI недоступний</Tag>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                type="password"
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                disabled={isReadOnly}
                placeholder="sk-ant-..."
                autoComplete="new-password"
                style={{ width: 320, fontFamily: 'monospace', fontSize: 12, padding: 6 }}
              />
              <button className="btn btn-sm primary" disabled={isReadOnly || keySaving || !keyInput.trim()} onClick={saveKey}>
                {keySaving ? '⏳...' : '💾 Зберегти ключ'}
              </button>
              <button
                className="btn btn-sm"
                disabled={isReadOnly || keySaving || keyInfo?.source !== 'db'}
                onClick={deleteKey}
                title="Видалити власний ключ — повернутись до серверного env"
              >
                🗑 Видалити (→ env)
              </button>
              {keyStatus ? <span style={{ fontSize: 12, color: keyStatus.startsWith('✓') ? '#1a7f37' : '#a00' }}>{keyStatus}</span> : null}
            </div>
            <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>
              Власний ключ має пріоритет над серверним і застосовується одразу (sync і async batch).
              Збережений ключ ніколи не показується повністю — тільки останні 4 символи.
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
