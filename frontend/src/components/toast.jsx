import React from 'react';

export function ToastViewport({ items, onDismiss }) {
  if (!Array.isArray(items) || items.length === 0) {
    return null;
  }

  return (
    <div className="toast-viewport" role="status" aria-live="polite">
      {items.map((item) => (
        <div key={item.id} className={`toast ${item.tone || 'info'}`}>
          <div className="toast-main">
            <div className="toast-title">{item.title}</div>
            {item.details ? <div className="toast-details">{item.details}</div> : null}
          </div>
          <button className="toast-close" onClick={() => onDismiss(item.id)} aria-label="Dismiss toast">
            x
          </button>
        </div>
      ))}
    </div>
  );
}
