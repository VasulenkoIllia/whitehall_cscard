# AI Mapping Wizard — autopre-mapping для постачальницьких Google Sheets

**Статус:** Phase 1 MVP, production-ready (тестується на staging).
**Дата:** 2026-05-24.
**Стек:** Anthropic Claude API (Sonnet 4.5 + Haiku 4.5), PostgreSQL, Express, Vite/React.

---

## Що це і навіщо

Підключення нового постачальника (Google Sheet → suppliers/sources/column_mappings) раніше вимагало від адміна **30-50 хвилин** ручної роботи: знайти header row, прочитати 30-67 колонок, кожну зіставити з канонічним полем нашого каталогу, не пропустити пастки (як "Количество=0 завжди — це псевдо-статус").

**AI Wizard скорочує процес до ~5 хвилин:**
1. Адмін вставляє URL → AI визначає які tabs у файлі є каталогом продуктів.
2. AI знаходить header_row + пропонує mapping для всіх колонок з confidence-score та reasoning.
3. Адмін переглядає (Apply all greens одним кліком, править yellows, мапить reds руками).
4. Click Save → готово.

---

## Архітектура

```
┌─────────────────────────────────────────────────────────────────┐
│ Frontend (React)                                                │
│  AiMappingWizard.jsx ── 3-step UI: analyze tabs / suggest / review
└──────────────────┬──────────────────────────────────────────────┘
                   │ /admin/api/ai-mapping/*
┌──────────────────▼──────────────────────────────────────────────┐
│ Express routes (aiMappingRoutes.ts)                             │
│   POST /analyze-tabs   POST /suggest                            │
│   GET  /pending        POST /suggestions/:id/review             │
│   GET  /status         GET  /analyses                           │
└──────────────────┬──────────────────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────────────────┐
│ AiMappingService (orchestrator)                                 │
│   • analyzeTabs()        ── фаза 1                              │
│   • suggestMapping()     ── фаза 2                              │
│   • markSuggestionReviewed()                                    │
└────────┬────────────────────────────────────────┬───────────────┘
         │                                        │
┌────────▼──────────────┐              ┌──────────▼──────────────┐
│ SheetTabAnalyzer       │              │ MappingSuggester        │
│  • listSheetNames      │              │  • getSheetInfo         │
│  • getSheetRowChunk x N│              │  • getSheetRowChunk(20) │
│  • Anthropic Haiku 4.5 │              │  • masterFieldsRepo     │
│  • save tab_analyses   │              │  • Anthropic Sonnet 4.5 │
└────────┬───────────────┘              │  • save mapping_suggest │
         │                              └──────────┬──────────────┘
         │                                         │
┌────────▼──────────────────────────────────────────▼─────────────┐
│ AnthropicClient (fetch-based wrapper)                           │
│   • retry on 429/5xx with exponential backoff                   │
│   • JSON-only mode з strict parsing                             │
│   • configurable per-call model + timeout                       │
└──────────────────┬──────────────────────────────────────────────┘
                   │ HTTPS
┌──────────────────▼──────────────────────────────────────────────┐
│ api.anthropic.com/v1/messages                                   │
└─────────────────────────────────────────────────────────────────┘
```

---

## База даних

### Міграція 051: `master_fields_ai_enrichment.sql`

Розширює існуючу таблицю `master_fields` колонками для AI-prompt контексту:

| колонка | тип | призначення |
|---|---|---|
| `description_ai` | TEXT | Детальний семантичний опис поля для AI (200-300 символів) |
| `example_values` | JSONB[] | 3-8 типових значень (для матчингу з sample data) |
| `applies_to` | JSONB[] | Для якого product_kind релевантне (`["Взуття"]`, `["Одяг","Взуття"]`, або `[]` для всіх) |
| `cardinality` | TEXT | `per_master` / `per_variant` / `per_master_multi` (для photo) |
| `anti_examples` | JSONB[] | Типові плутанини з reason: `[{value:"Adidas", reason:"bare brand"}]` |
| `format_hint` | TEXT | Regex для валідації (`^[0-9]{8,14}$` для gtin) |

**Усі 23 поля заповнені вручну** з ретельно прописаними описами укр. (див. SQL для повного seed).

### Міграція 052: `ai_mapping_suggestions.sql`

**`sheet_tab_analyses`** — результат фази 1 (один рядок на виклик):
- `supplier_id`, `spreadsheet_id`, `sheet_url`, `model_version`
- `tabs` JSONB — `[{name, is_catalog, product_type, confidence, reasoning}, ...]`
- `raw_response` JSONB — повна відповідь Anthropic (debug)
- `input_tokens`, `output_tokens`, `duration_ms`

**`column_mapping_suggestions`** — результат фази 2 (один рядок на tab):
- `supplier_id`, `source_id` (nullable), `sheet_url`, `tab_name`, `model_version`
- `header_row`, `first_data_row`, `header_row_confidence`, `header_row_reasoning`
- `proposed_mapping` JSONB — `{field_key: {type, col_index, header, confidence, reasoning, sample_values}}`
- `warnings`, `unmapped_cols` JSONB
- `raw_response`, tokens, duration
- **Workflow:** `status` enum `pending|approved|rejected|edited|superseded`
- `applied_mapping` (фактично збережений), `reviewed_by`, `reviewed_at`, `review_notes`

Обидві таблиці live окремо від `column_mappings` — AI пропозиція ніколи не йде в pipeline без явного Approve.

---

## Backend код (`src/core/ai/`)

| Файл | Рядки | Призначення |
|---|---|---|
| `AnthropicClient.ts` | 250 | fetch wrapper з retry/timeout/JSON-parse |
| `MappingPrompts.ts` | 376 | **Universal master prompts** — system + user message builders для tab analyzer та mapping suggester |
| `MasterFieldRepository.ts` | 86 | Завантажує master_fields для AI prompt context |
| `SheetTabAnalyzer.ts` | 171 | Фаза 1 — listing tabs + AI call |
| `MappingSuggester.ts` | 227 | Фаза 2 — preview tab + AI call + validation |
| `AiMappingService.ts` | 233 | High-level orchestrator (analyze/suggest/pending/review) |
| `types.ts` | 79 | Спільні типи |

### Master prompt (MappingPrompts.ts)

Універсальний промпт описує:
1. **Архітектуру системи** — товар = master + variants; кардинальності полів.
2. **Base 6 fields** (article/size/qty/price/extra/comment) з детальними правилами + типовими пастками (`Количество=0`).
3. **23 master fields** з description_ai + example_values + applies_to + anti_examples + format_hint.
4. **Output schema** — JSON з `header_row`, `mapping`, `warnings`, `unmapped_cols`.
5. **Confidence calibration** — як scoreить впевненість.
6. **Few-shot examples** (з env `MAPPING_FEW_SHOT`, опційно).

Промпт самодостатній — додавання нових master_fields автоматично потрапляє у промпт без правок коду.

---

## Налаштування (.env)

```bash
# ── Anthropic AI (для AI Mapping Wizard) ─────────────────────────────────────
# Без ключа wizard у UI показує "AI-мапінг недоступний". Все інше працює.
ANTHROPIC_API_KEY=sk-ant-api03-...

# Модель для column mapping (потужна, Sonnet 4.5):
ANTHROPIC_MODEL_MAPPING=claude-sonnet-4-5

# Модель для tab-analyzer (швидша/дешевша, Haiku 4.5):
ANTHROPIC_MODEL_TAB_ANALYZER=claude-haiku-4-5

# Retry + timeout (для 67-колонкових файлів потрібно 180000 = 3 хв):
ANTHROPIC_MAX_RETRIES=3
ANTHROPIC_TIMEOUT_MS=180000

# Опційно: few-shot examples як JSON-рядок (масив обʼєктів FewShotExample[]):
# MAPPING_FEW_SHOT='[{"supplierName":"...","headers":[...],...}]'
```

**Важливо:** `secure` cookie auth включається коли `NODE_ENV=production`. Для локальної розробки використовуй `NODE_ENV=development`, інакше cookie не пройде через HTTP.

---

## HTTP API

| Method | Path | Role | Body / Query | Response |
|---|---|---|---|---|
| GET | `/admin/api/ai-mapping/status` | viewer | — | `{enabled, models}` |
| POST | `/admin/api/ai-mapping/analyze-tabs` | admin | `{supplierId, sheetUrl}` | `{analysisId, tabs, modelVersion, tokens, durationMs}` |
| POST | `/admin/api/ai-mapping/suggest` | admin | `{supplierId, sheetUrl, tabName, sourceId?}` | `{suggestionId, result: {header_row, mapping, warnings, unmapped_cols}, tokens, durationMs}` |
| GET | `/admin/api/ai-mapping/pending` | viewer | `?supplierId&sourceId?&tabName?` | `null` або останній pending suggestion |
| POST | `/admin/api/ai-mapping/suggestions/:id/review` | admin | `{status: approved\|rejected\|edited, appliedMapping?, notes?}` | `{ok: true}` |
| GET | `/admin/api/ai-mapping/analyses` | viewer | `?supplierId&limit=5` | `{rows: [...]}` |

---

## Frontend (`AiMappingWizard.jsx`)

Компонент вбудований у `MappingTab.jsx` (з'являється коли обрано постачальника). 3 кроки:

**Step 1 — Idle:** input для Sheet URL + кнопка "Знайти tabs через AI".

**Step 2 — Tab-picker:** таблиця tabs:
- ✓ зелені (is_catalog=true) — кнопка "Аналізувати"
- ✗ червоні (is_catalog=false, з reasoning чому пропускається)

**Step 3 — Review:**
- Header row info з confidence badge + reasoning
- Warnings panel (collision/static_suspect/missing_required)
- Розгорнута секція **Базові 6** (червоний фон якщо не замаплене)
- Згорнута секція **Master fields** (зелений якщо confidence > 85%, жовтий < 85%)
- Per-row: field key / type / col / header / confidence% / sample / reasoning + кнопка ×
- Кнопки **✓ Apply mapping** (підставляє у форму) / **✗ Reject**
- Token usage + duration

Apply підставляє mapping у поточний draft `mappingFields` через колбек з App.jsx, після чого юзер відкриває mapping editor, перевіряє, корегує, тисне Save → mapping йде через стандартний `saveMapping`.

---

## Вартість + продуктивність

Для типового постачальника (одноразова дія при онбордингу):

| supplier | колонок | input tokens | output tokens | час | Sonnet cost | Haiku cost |
|---|---|---|---|---|---|---|
| europasport | 18 | 10 570 | 2 648 | ~40с | $0.07 | $0.024 |
| shopua | 32 | ~14 000 | ~5 000 | ~70с | $0.12 | $0.040 |
| markshop | 67 | ~22 000 | ~10 000 | ~110с | $0.22 | $0.070 |

**За весь рік (100 нових постачальників):** ~$10-30. Дешево порівняно з мануальною роботою.

---

## Workflow для адміна

```
1. Створи supplier у UI (назва, priority, markup).
2. Створи source (Google Sheet URL).
3. Натисни на source → відкриється модал з AI Mapping Wizard.
4. Встав URL → "Знайти tabs через AI" (Haiku, ~3-5с).
5. Обери каталог-tab → "Аналізувати" (Sonnet, ~40-110с).
6. У review-панелі:
   - перевір header_row
   - перевір warnings
   - проскрол base 6 — все має бути зелене (>85%)
   - проскрол master fields — підправ де треба
   - натисни ✓ Apply mapping
7. Відкриється mapping editor з підставленими полями.
8. Save → mapping готовий, можна імпортувати.
```

---

## Troubleshooting

### `enabled: false` у status endpoint
ANTHROPIC_API_KEY не задано або порожній. Додай у `.env`, перезапусти бекенд.

### `AI повернув невалідний JSON`
Модель додала markdown-обгортку. Парсер пробує strip `\`\`\`json` блоки, але якщо все одно ламається — подивись `raw_response` у БД (`SELECT raw_response FROM column_mapping_suggestions ORDER BY id DESC LIMIT 1`).

### Hang на 60+ секунд → timeout
markshop (67 cols) Sonnet генерує 90-120с. Якщо `ANTHROPIC_TIMEOUT_MS` менший — call зривається. Підніми до **180000** (3 хв).

### Cookie/login не працює локально
Перевір `NODE_ENV=development` у `.env`. У production режимі cookie має `Secure` flag і не йде через HTTP.

### "AI не зміг знайти колонку article"
В `column_mapping_suggestions.warnings` буде `{type: 'missing_required', field: 'article'}`. Це означає що у sample даних AI не побачив колонку схожу на SKU. Перевір що файл реально містить артикули. Або це справді нестандартна структура — мапь вручну.

---

## Що не входить у Phase 1 (потенціал Phase 2)

- **Auto-apply** для high-confidence пропозицій без manual approve.
- **Few-shot learning loop** — використовувати раніше approved mappings як приклади для нових постачальників.
- **Diff-mode** — якщо у source вже є mapping, показувати side-by-side діфф vs AI пропозиція.
- **Multi-tab batch analyze** — "Analyze all selected" одним кліком замість per-tab.
- **Cost dashboard** — сумарна статистика витрат на AI per supplier / per month.
- **Variation grouping detection** — розпізнавати master+variants структуру (батько в одному рядку, розміри в наступних).
- **Pre-processing splitter** — для клітинок типу `"Чорний, розмір L"` → 2 окремі поля.

---

## Файли — повний список

**Migrations:**
- `migrations/051_master_fields_ai_enrichment.sql`
- `migrations/052_ai_mapping_suggestions.sql`

**Backend (`src/core/ai/`):**
- `AnthropicClient.ts`, `MappingPrompts.ts`, `types.ts`
- `MasterFieldRepository.ts`
- `SheetTabAnalyzer.ts`, `MappingSuggester.ts`
- `AiMappingService.ts`

**HTTP routes:**
- `src/app/http/routes/aiMappingRoutes.ts`

**DI wiring:**
- `src/app/createApplication.ts` — додано `aiMappingService` у Application
- `src/app/http/server.ts` — додано `registerAiMappingRoutes`

**Frontend:**
- `frontend/src/components/AiMappingWizard.jsx`
- `frontend/src/tabs/MappingTab.jsx` — інтеграція wizard
- `frontend/src/App.jsx` — передача `apiFetch` + `setMappingFields` у MappingTab

**Helpers:**
- `src/core/pipeline/googleSheetsService.ts` — export `parseSheetId`
