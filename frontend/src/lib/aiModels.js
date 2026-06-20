// Спільний список AI-моделей для перемикача (Claude + DeepSeek).
// provider визначає, який ключ і шлях використовується на бекенді
// (роутинг там — за префіксом назви моделі).

export const AI_MODELS = [
  { value: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 — швидко, дешево', provider: 'anthropic' },
  { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 — точніше, дорожче', provider: 'anthropic' },
  { value: 'deepseek-chat', label: 'DeepSeek Chat — дуже дешево', provider: 'deepseek' },
  { value: 'deepseek-reasoner', label: 'DeepSeek Reasoner — точніше', provider: 'deepseek' }
];

const PROVIDER_LABELS = { anthropic: 'Claude (Anthropic)', deepseek: 'DeepSeek' };

export function isDeepseek(model) {
  return typeof model === 'string' && model.trim().toLowerCase().startsWith('deepseek');
}

export function modelProvider(model) {
  return isDeepseek(model) ? 'deepseek' : 'anthropic';
}

/** Групи моделей за провайдером — для рендеру <optgroup>. */
export function modelGroups() {
  const order = ['anthropic', 'deepseek'];
  return order.map((p) => ({
    provider: p,
    label: PROVIDER_LABELS[p],
    models: AI_MODELS.filter((m) => m.provider === p)
  }));
}
