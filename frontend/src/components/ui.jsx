import React, { useState } from 'react';

export function Tag({ tone = 'warn', children }) {
  return <span className={`tag ${tone}`}>{children}</span>;
}

export function Section({ title, subtitle, children, extra }) {
  return (
    <div className="panel">
      <div className="section-head">
        <div>
          <h3>{title}</h3>
          {subtitle ? <p className="muted">{subtitle}</p> : null}
        </div>
        {extra || null}
      </div>
      {children}
    </div>
  );
}

export function ConfirmKeywordModal({ title, details, onConfirm, onCancel }) {
  return (
    <div className="modal-backdrop confirm-modal-backdrop" onClick={onCancel}>
      <div className="modal-card confirm-modal-card" onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginBottom: 6 }}>{title}</h3>
        {details ? <p className="muted" style={{ marginBottom: 16 }}>{details}</p> : null}
        <div className="actions">
          <button className="btn danger" autoFocus onClick={onConfirm}>
            Так, видалити
          </button>
          <button className="btn" onClick={onCancel}>Скасувати</button>
        </div>
      </div>
    </div>
  );
}
