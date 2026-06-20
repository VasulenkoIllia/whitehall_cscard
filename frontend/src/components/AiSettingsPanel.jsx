import React, { useEffect, useState, useCallback } from 'react';
import { Tag } from './ui';

// Провайдери AI-ключів (узгоджено з бекендом /settings/ai-key/:provider).
const KEY_PROVIDERS = [
  { id: 'anthropic', label: 'Anthropic (Claude)', icon: '🟣', prefix: 'sk-ant-...' },
  { id: 'deepseek', label: 'DeepSeek', icon: '🔵', prefix: 'sk-...' }
];

/**
 * AiSettingsPanel — налаштування AI enrichment:
 *   1. Редагований system prompt (зберігається в app_settings, fallback = вбудований).
 *   2. API ключі провайдерів (Anthropic + DeepSeek), write-only: у форму ніколи
 *      не повертаються, сервер віддає тільки маску + джерело db/env.
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

  // API keys state (per provider): {anthropic:{configured,source,masked}, deepseek:{...}}
  const [keys, setKeys] = useState({});
  const [keyInputs, setKeyInputs] = useState({}); // {anthropic:'', deepseek:''}
  const [keySaving, setKeySaving] = useState(''); // provider id, що зберігається
  const [keyStatuses, setKeyStatuses] = useState({}); // {provider: 'текст'}

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
      const k = await apiFetch('/settings/ai-keys');
      setKeys(k || {});
    } catch {
      // viewer без admin-прав отримає 403 — ключі просто не показуємо
      setKeys({});
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

  const setKeyStatus = (provider, text) =>
    setKeyStatuses((prev) => ({ ...prev, [provider]: text }));

  const saveKey = async (provider) => {
    const input = (keyInputs[provider] || '').trim();
    if (keySaving || !input) return;
    setKeySaving(provider);
    setKeyStatus(provider, '');
    try {
      const result = await apiFetch(`/settings/ai-key/${provider}`, {
        method: 'PUT',
        body: JSON.stringify({ apiKey: input })
      });
      setKeys((prev) => ({ ...prev, [provider]: result }));
      setKeyInputs((prev) => ({ ...prev, [provider]: '' }));
      setKeyStatus(provider, '✓ Ключ збережено');
      if (onSettingsChanged) onSettingsChanged();
    } catch (err) {
      setKeyStatus(provider, `Помилка: ${err?.message || 'unknown'}`);
    } finally {
      setKeySaving('');
    }
  };

  const deleteKey = async (provider) => {
    if (keySaving) return;
    if (!window.confirm('Видалити власний ключ і повернутись до серверного (env)?')) return;
    setKeySaving(provider);
    setKeyStatus(provider, '');
    try {
      const result = await apiFetch(`/settings/ai-key/${provider}`, { method: 'DELETE' });
      setKeys((prev) => ({ ...prev, [provider]: result }));
      setKeyStatus(provider, result.configured ? '✓ Повернулись до env ключа' : '⚠ Ключа немає');
      if (onSettingsChanged) onSettingsChanged();
    } catch (err) {
      setKeyStatus(provider, `Помилка: ${err?.message || 'unknown'}`);
    } finally {
      setKeySaving('');
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
        {KEY_PROVIDERS.map((p) => {
          const info = keys[p.id];
          if (!info) return null;
          return (
            <Tag key={p.id} tone={info.configured ? 'ok' : 'error'}>
              {p.icon} {info.configured ? `${info.masked} (${info.source})` : 'нема ключа'}
            </Tag>
          );
        })}
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

          {/* ─── API keys (Anthropic + DeepSeek) ───────────────────────── */}
          <div>
            <strong style={{ fontSize: 13 }}>🔑 API ключі провайдерів</strong>
            {KEY_PROVIDERS.map((p) => {
              const info = keys[p.id] || null;
              const input = keyInputs[p.id] || '';
              const status = keyStatuses[p.id] || '';
              const saving = keySaving === p.id;
              return (
                <div key={p.id} style={{ marginTop: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 12, fontWeight: 600 }}>{p.icon} {p.label}</span>
                    {info?.configured ? (
                      <Tag tone="ok">{info.masked} · {info.source === 'db' ? 'власний (БД)' : 'серверний (env)'}</Tag>
                    ) : (
                      <Tag tone="error">не задано</Tag>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <input
                      type="password"
                      value={input}
                      onChange={(e) => setKeyInputs((prev) => ({ ...prev, [p.id]: e.target.value }))}
                      disabled={isReadOnly}
                      placeholder={p.prefix}
                      autoComplete="new-password"
                      style={{ width: 300, fontFamily: 'monospace', fontSize: 12, padding: 6 }}
                    />
                    <button className="btn btn-sm primary" disabled={isReadOnly || !!keySaving || !input.trim()} onClick={() => saveKey(p.id)}>
                      {saving ? '⏳...' : '💾 Зберегти'}
                    </button>
                    <button
                      className="btn btn-sm"
                      disabled={isReadOnly || !!keySaving || info?.source !== 'db'}
                      onClick={() => deleteKey(p.id)}
                      title="Видалити власний ключ — повернутись до серверного env"
                    >
                      🗑 → env
                    </button>
                    {status ? <span style={{ fontSize: 12, color: status.startsWith('✓') ? '#1a7f37' : '#a00' }}>{status}</span> : null}
                  </div>
                </div>
              );
            })}
            <div style={{ fontSize: 11, color: '#888', marginTop: 6 }}>
              Власний ключ має пріоритет над серверним (env) і діє одразу. Модель обирається у
              списку/деталях SKU — за назвою (claude-* / deepseek-*) система сама бере потрібний ключ.
              Ключ ніколи не показується повністю — тільки останні 4 символи.
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
