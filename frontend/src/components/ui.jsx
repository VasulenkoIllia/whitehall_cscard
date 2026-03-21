import React from 'react';

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
