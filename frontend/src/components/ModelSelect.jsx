import React from 'react';
import { modelGroups } from '../lib/aiModels';

/**
 * ModelSelect — спільний дропдаун вибору AI-моделі (Claude / DeepSeek),
 * згрупований за провайдером. Використовується і в списку, і в drill-in.
 */
export function ModelSelect({ value, onChange, disabled = false, style }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      style={style}
    >
      {modelGroups().map((g) => (
        <optgroup key={g.provider} label={g.label}>
          {g.models.map((m) => (
            <option key={m.value} value={m.value}>{m.label}</option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
