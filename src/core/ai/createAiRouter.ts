/**
 * createAiRouter — диспетчер між провайдерами за назвою моделі.
 *
 *   model починається з 'deepseek' → DeepSeek
 *   інакше                          → Anthropic (Claude)
 *
 * Повертає об'єкт того ж типу AnthropicClient, тому EnrichmentService та решта
 * коду працюють без змін — просто отримують роутер замість одного клієнта.
 */

import type {
  AnthropicClient,
  AnthropicMessageParams,
  AnthropicMessageResult
} from './AnthropicClient';

export function isDeepseekModel(model: string): boolean {
  return typeof model === 'string' && model.trim().toLowerCase().startsWith('deepseek');
}

export function createAiRouter(clients: {
  anthropic: AnthropicClient;
  deepseek: AnthropicClient;
}): AnthropicClient {
  const pick = (model: string): AnthropicClient =>
    isDeepseekModel(model) ? clients.deepseek : clients.anthropic;

  return {
    isEnabled: () => clients.anthropic.isEnabled() || clients.deepseek.isEnabled(),
    send<T = unknown>(params: AnthropicMessageParams): Promise<AnthropicMessageResult<T>> {
      return pick(params.model).send<T>(params);
    }
  };
}
