import React from 'react';
import { Tag } from './ui';

/** Модалка перегляду промпта, який піде в AI для конкретного SKU (без виклику AI). */
export function PromptPreviewModal({ preview, onClose }) {
  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
      background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999
    }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: 'white', maxWidth: 1000, width: '95%', maxHeight: '90vh',
        overflow: 'auto', borderRadius: 8, padding: 20, boxShadow: '0 4px 20px rgba(0,0,0,0.3)'
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>🔍 Preview prompt (master #{preview.masterId})</h3>
          <button className="btn" onClick={onClose}>Закрити</button>
        </div>
        {preview.loading ? <div>Завантаження...</div> : preview.error ? (
          <div style={{ background: '#fee', color: '#a00', padding: 8, borderRadius: 4 }}>{preview.error}</div>
        ) : (
          <>
            <div style={{ marginBottom: 12, fontSize: 12 }}>
              <Tag tone="warn">Estimated tokens: {preview.estimatedTokens}</Tag>
              <span style={{ marginLeft: 8, color: '#666' }}>
                ⚠ Наближена оцінка. Системний промпт кешується — реальний input у рази менший.
              </span>
            </div>

            <details open style={{ marginBottom: 12 }}>
              <summary style={{ cursor: 'pointer', fontWeight: 600, color: '#4a90e2' }}>
                📜 System prompt ({preview.systemPrompt.length} символів, кешується)
              </summary>
              <pre style={{ background: '#f8f8f8', padding: 8, fontSize: 11, overflow: 'auto', maxHeight: 300, whiteSpace: 'pre-wrap' }}>
                {preview.systemPrompt}
              </pre>
            </details>

            <details open>
              <summary style={{ cursor: 'pointer', fontWeight: 600, color: '#4a90e2' }}>
                💬 User message ({preview.userMessage.length} символів)
              </summary>
              <pre style={{ background: '#f8f8f8', padding: 8, fontSize: 11, overflow: 'auto', maxHeight: 400, whiteSpace: 'pre-wrap' }}>
                {preview.userMessage}
              </pre>
            </details>

            {preview.feedParams ? (
              <details>
                <summary style={{ cursor: 'pointer', fontWeight: 600, color: '#4a90e2' }}>
                  🗂 feed_params (дані товару, які бачить AI)
                </summary>
                <pre style={{ background: '#f8f8f8', padding: 8, fontSize: 11, overflow: 'auto', maxHeight: 300 }}>
                  {JSON.stringify(preview.feedParams, null, 2)}
                </pre>
              </details>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
