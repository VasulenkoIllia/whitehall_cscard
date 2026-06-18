# Excel → AI → Excel: збагачення master_catalog

Демо-цикл для наповнення картки товару через AI: завантажуєш Excel з товарами →
AI заповнює 22 структурні поля + генерує SEO/AEO-опис за промптом → експортуєш
.xlsx для магазину.

Гілка: `develop`. Оновлено: 2026-06-18.

## AI v2 — SEO-опис + кешування промпта

- **Один виклик на SKU** заповнює всі 23 поля: 22 структурні (екстракція/нормалізація
  з confidence) + `description_full_uk` — повноцінна **SEO/AEO-проза** WHITE HALL
  (лід-відповідь, підзаголовки, атрибут→вигода, ~180-250 слів, без списку характеристик).
  Промпт у [EnrichmentPrompt.ts](src/core/ai/EnrichmentPrompt.ts), редагований на фронті.
- **КРОК 0 (визначення товару за узгодженістю)** діє глобально — відкидає помилкові
  `input_name`/`feed_name` (різні товари у зведених фідах). Конфлікт → поля null + warning.
- **Prompt caching**: статичний системний промпт (~4.7k токенів) кешується
  (`cache_control: ephemeral`) — пишеться 1 раз, читається 0.1× ціни. Працює і в sync,
  і в async Batch. Вартість рахується точно (cache write 1.25× / read 0.1×, Batch −50%),
  токени кешу логуються в `ai_usage_log` (міграція 040).
- **Модель** обирається в UI (Haiku — дешево; Sonnet 4.6 — якісніше). Для опису краще
  async Batch (1 SKU/запит) або малі sync-чанки.

## Загальна картина

```
Excel (твій файл)
   │  POST /excel/import — очистка зайвого, upsert по SKU
   ▼
master_catalog.feed_params.excel_upload.data = {очищені параметри товару}
   │  AI enrichment (sync або async batch) за промптом + ключем
   ▼
master_catalog: 23 поля картки + опис (name_uk, brand, description_full_uk, …)
   │  GET /export.xlsx
   ▼
Excel для завантаження в магазин
```

Структура `feed_params.excel_upload` — **та сама**, що у фідів по URL, тому
двигун enrichment (промпт, фільтри, batch) працює без змін.

## Що додано

### 1. Імпорт Excel (`ExcelImportService`)
- **Кнопка «📥 Імпорт Excel»** → preview (аркуші, заголовки, перші очищені
  рядки) → вибір колонки SKU / виключених колонок / колонки фото → імпорт.
- **Очистка для економії токенів**: HTML-теги геть, entities декодуються,
  пробіли колапсуються, порожні значення відкидаються, виключені колонки
  (фото, лінки, технічне, SEO) не йдуть в AI.
- **Upsert по SKU**: нові SKU створюються, наявні оновлюються (ідемпотентно).
- **Фото не йде в AI**: колонка фото пишеться напряму в `master_catalog.photo`.
- Ліміт файлу 150 MB (memoryStorage, реальний файл ~76 MB).
- Дефолтні виключення підлаштовані під реальний файл: `photo_*`, `url`,
  `feed_url`, `image_count`, `_feed_matched`, `keywords`, юридичні поля.
  Список редагується і зберігається кнопкою «Зберегти як стандарт».

### 2. Редагований промпт + власний API ключ (`AppSettingsService`, панель «⚙️ AI налаштування»)
- **Промпт**: редагується з фронта, зберігається в `app_settings`. Порожньо =
  вбудований default. Версія (`v1` / `custom-<hash>`) пишеться в кожен
  опрацьований рядок (`ai_prompt_version`).
- **Ключ**: вводиться на фронті, зберігається в БД, **має пріоритет над env**.
  Резолвиться при кожному запиті — діє одразу без рестарту. На фронт ніколи не
  повертається повністю (тільки маска `••••abcd` + джерело `db`/`env`).
  Видалення → fallback на `ANTHROPIC_API_KEY` з env.

| Стан ключа | Що використовується | UI `keySource` |
|------------|--------------------|----------------|
| env є, фронт порожній | env | `env` |
| ключ введено на фронті | фронт (БД) | `db` |
| фронт видалено | знову env | `env` |
| ніде немає | помилка 501 | `null` |

### 3. Пачки 10/50/100 + захист від подвійного запуску
- **«Обрати перші N» (10/50/100)** — вибирає з усього каталогу (не лише видимої
  сторінки) **тільки свіжі**: з даними, без AI, не в черзі.
- **Статус «у черзі» (pending)**: SKU в активному async batch
  (`results_fetched_at IS NULL`) — вже відправлені, результати ще не записані.
  Без цього їх можна було відправити вдруге і заплатити двічі.
- **Серверний запобіжник**: `batch-submit` сам відкидає pending SKU
  (`skippedPending` у відповіді); якщо всі pending → 409.
- **Фільтр AI**: `🤖 Опрацьовано` / `✨ Свіжі` / `⏳ У черзі` / `Не опрацьовано`.
- **Стрічка «📊 Прогрес AI»**: всього / з даними / опрацьовано / у черзі /
  лишилось / % готово.

### 4. Експорт у .xlsx
- **Кнопка «📤 Експорт XLSX»** — sku + 23 AI-поля + метадані. Враховує поточні
  фільтри (постав `AI = Опрацьовано`, щоб скачати тільки збагачені). Cap 50k.

## API (нове)

| Метод | Шлях | Роль | Призначення |
|-------|------|------|-------------|
| POST | `/admin/api/master-catalog/excel/preview` | admin | preview файлу (multipart) |
| POST | `/admin/api/master-catalog/excel/import` | admin | імпорт (multipart) |
| GET | `/admin/api/master-catalog/stats` | viewer | прогрес каталогу |
| GET | `/admin/api/master-catalog/ids?limit=N` | viewer | перші N id за фільтрами |
| GET | `/admin/api/master-catalog/export.xlsx` | viewer | експорт .xlsx |
| GET/PUT | `/admin/api/settings/enrichment-prompt` | viewer/admin | промпт (PUT порожнім = reset) |
| GET/PUT/DELETE | `/admin/api/settings/anthropic-key` | admin | ключ (GET тільки маска) |
| GET/PUT | `/admin/api/settings/excel-excluded-columns` | admin | дефолтні виключення |

> Усі нові single-segment роути (`stats`, `ids`, `export.xlsx`) зареєстровані
> **до** `/:id`, інакше Express трактує їх як SKU.

## База даних

Міграція `039_app_settings.sql`:
- `app_settings (key PK, value TEXT, value_json JSONB, updated_at)` — промпт,
  ключ, виключення.
- `anthropic_batches.prompt_version` — версія промпта, з якою відправлено batch.

Застосовується автоматично при старті контейнера.

## Очистка даних (dev/демо)

`scripts/reset_master_catalog_dev.sql` — стирає `master_catalog`,
`master_catalog_sync_runs`, `feed_imports`, `anthropic_batches`, `ai_usage_log`.
**Зберігає** `feeds` (конфіг) і `app_settings` (промпт/ключ).

```bash
docker exec -i whitehall-cscard-test-db psql -U whitehall_store -d whitehall_store \
  < scripts/reset_master_catalog_dev.sql
```

## Ключові файли

| Файл | Що |
|------|-----|
| `migrations/039_app_settings.sql` | таблиця налаштувань + prompt_version |
| `src/core/settings/AppSettingsService.ts` | промпт / ключ / виключення |
| `src/core/master_catalog/ExcelImportService.ts` | preview + import + очистка |
| `src/core/ai/AnthropicClient.ts` / `AnthropicBatchClient.ts` | keyProvider (DB > env) |
| `src/core/ai/EnrichmentService.ts` / `AnthropicBatchService.ts` | кастомний промпт, pending-guard |
| `src/app/http/routes/settingsRoutes.ts` | ендпоінти налаштувань |
| `frontend/src/components/AiSettingsPanel.jsx` | панель промпт + ключ |
| `frontend/src/components/ExcelImportModal.jsx` | модалка імпорту |
| `frontend/src/tabs/MasterCatalogTab.jsx` | стрічка прогресу, фільтри, кнопки |

## Нюанси

- **«Enrich — порожні» vs «переписати»**: «порожні» пропускає вже заповнені
  поля. Щоб прогнати з новим промптом по вже опрацьованих — «переписати».
- **Async batch не миттєвий**: 1–24 год. Після завершення натисни «⬇ Fetch»,
  щоб записати результати — доти SKU висять «у черзі».
- **Ключ у БД відкритим текстом** — для внутрішнього admin-tool за auth ок; за
  потреби можна зашифрувати AES через `AUTH_SESSION_SECRET`.
