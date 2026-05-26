import { XMLParser } from 'fast-xml-parser';
import type { FeedParser, FeedParseResult, FeedConfig, FeedItem } from './types';

/**
 * YmlFeedParser — Yandex Market YML/XML формат.
 *
 * Структура:
 *   <yml_catalog>
 *     <shop>
 *       <offers>
 *         <offer id="..." available="true">
 *           <name>...</name>
 *           <vendorCode>...</vendorCode>
 *           <picture>url1</picture>
 *           <picture>url2</picture>
 *           <param name="Бренд">Arena</param>
 *           <param name="Колір">чорний</param>
 *         </offer>
 *         ...
 *       </offers>
 *     </shop>
 *   </yml_catalog>
 *
 * Підтримує також `<offer>` поза `<offers>` (deep search).
 *
 * Кожен offer перетворюється у flat record:
 *   {
 *     id: '00000043353',           // з attribute
 *     available: true,
 *     name: 'Купальник...',
 *     vendorCode: '005755-550',
 *     picture: ['url1', 'url2', ...],   // масив якщо кілька
 *     param_Бренд: 'Arena',             // <param name="X">Y</param> → param_X: Y
 *     param_Колір: 'чорний',
 *     ...
 *   }
 */
export class YmlFeedParser implements FeedParser {
  readonly format = 'yml' as const;

  async parse(content: Buffer, _config: FeedConfig): Promise<FeedParseResult> {
    const startedAt = Date.now();
    const xml = content.toString('utf-8');

    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      // Для повторюваних тегів типу <picture> — завжди масив:
      isArray: (name) => ['picture', 'param', 'offer', 'category'].includes(name),
      // Декодуємо <![CDATA[...]]> як звичайний текст.
      cdataPropName: '__cdata',
      trimValues: true
    });

    const obj = parser.parse(xml);

    // Зазвичай шлях: yml_catalog.shop.offers.offer (массив)
    let offers: any[] = [];
    const fromPath = (root: any, path: string[]): any => {
      let cur = root;
      for (const p of path) {
        if (!cur || typeof cur !== 'object') return null;
        cur = cur[p];
      }
      return cur;
    };

    const standardPath = fromPath(obj, ['yml_catalog', 'shop', 'offers', 'offer']);
    if (Array.isArray(standardPath)) {
      offers = standardPath;
    } else if (standardPath && typeof standardPath === 'object') {
      offers = [standardPath];
    } else {
      // Fallback — recursive search for any 'offer' arrays.
      offers = collectOffers(obj);
    }

    const items: FeedItem[] = offers.map((raw) => flattenOffer(raw));
    return { items, parseMs: Date.now() - startedAt };
  }
}

function collectOffers(node: any): any[] {
  if (!node || typeof node !== 'object') return [];
  const result: any[] = [];
  if (Array.isArray(node)) {
    for (const item of node) result.push(...collectOffers(item));
    return result;
  }
  for (const [key, val] of Object.entries(node)) {
    if (key === 'offer' && Array.isArray(val)) {
      result.push(...val);
    } else if (key === 'offer' && val && typeof val === 'object') {
      result.push(val);
    } else if (val && typeof val === 'object') {
      result.push(...collectOffers(val));
    }
  }
  return result;
}

function flattenOffer(raw: any): FeedItem {
  const out: FeedItem = {};
  if (!raw || typeof raw !== 'object') return out;

  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith('@_')) {
      // Attribute (id, available, group_id, in_stock...)
      out[key.slice(2)] = simplifyValue(value);
      continue;
    }
    if (key === 'param' && Array.isArray(value)) {
      // <param name="X">Y</param> → param_X: Y
      for (const p of value) {
        if (p && typeof p === 'object') {
          const name = (p as any)['@_name'];
          const text = simplifyValue((p as any)['#text'] ?? (p as any)['__cdata'] ?? p);
          if (name) out[`param_${name}`] = text;
        }
      }
      continue;
    }
    if (key === 'picture' && Array.isArray(value)) {
      out.picture = value.map((v) => simplifyValue(v));
      continue;
    }
    out[key] = simplifyValue(value);
  }
  return out;
}

function simplifyValue(v: unknown): unknown {
  if (v === null || typeof v === 'undefined') return null;
  if (typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    // {#text: 'value'} → 'value'
    if ('#text' in obj && Object.keys(obj).length === 1) return obj['#text'];
    if ('__cdata' in obj && Object.keys(obj).length === 1) return obj['__cdata'];
    // {__cdata: '...', #text: ''} — преферуємо __cdata
    if ('__cdata' in obj) return obj['__cdata'];
    return obj;
  }
  return v;
}
