# Runbook: Legacy supplier config migration (March 2026)

## Goal
- Вигрузити конфіг постачальників зі старої production-бази (`whitehall.store_integration`) і завантажити в нову базу `whitehall_cscard` для тесту parity.
- Цільовий кейс: `WHITE HALL`, `sevrukov`.

## Scripts
- `npm run export:legacy-config` — читає legacy БД і формує JSON snapshot.
- `npm run import:legacy-config` — імпортує snapshot у нову БД з upsert-поведінкою.

## 1) Export на legacy/prod середовищі
Передумови:
- На хості доступний код `whitehall_cscard` (цей репозиторій).
- Є доступ до legacy PostgreSQL.

Команди:
```bash
cd /path/to/whitehall_cscard
npm run build

export LEGACY_DATABASE_URL='postgres://...legacy...'
export LEGACY_SUPPLIER_NAMES='WHITE HALL,sevrukov'
export LEGACY_CONFIG_OUTPUT_PATH='/tmp/legacy_wh_sevrukov_snapshot.json'

npm run export:legacy-config
```

Результат:
- JSON snapshot у файлі `/tmp/legacy_wh_sevrukov_snapshot.json`.
- У stdout виводиться summary (`suppliers/sources/mappings/rule_sets`).

## 2) Import у нову БД (локально або staging)
Передумови:
- Нова БД вже мігрована (`npm run migrate`), включно з `025_add_column_mappings_comment.sql`.
- Snapshot скопійований у доступний шлях.

Dry-run (рекомендовано):
```bash
cd /path/to/whitehall_cscard
npm run build

export DATABASE_URL='postgres://...new...'
export LEGACY_CONFIG_INPUT_PATH='/tmp/legacy_wh_sevrukov_snapshot.json'
export LEGACY_CONFIG_DRY_RUN='1'

npm run import:legacy-config
```

Реальний імпорт:
```bash
export LEGACY_CONFIG_DRY_RUN='0'
npm run import:legacy-config
```

## 3) Що саме переноситься
- `suppliers` (основні поля конфігу націнки/активності/пріоритету).
- `sources` для цих постачальників.
- Останній `column_mappings` per `(supplier_id, source_id|null)`.
- `comment` для mapping (якщо є в snapshot).
- `markup_rule_sets` + `markup_rule_conditions`, які реально прив’язані до вибраних suppliers.

## 4) Важливі нюанси
- Під час імпорту `mapping_meta.source_id` автоматично ремапиться на нові `source_id`, щоб не зламати mapping validation.
- Імпорт не чіпає бізнес-правила пайплайна, тільки переносить конфіг.
- `global markup default` (`markup_settings`) у новій схемі поки не застосовується автоматично; переноситься тільки те, що явно прив’язано до suppliers.

## 5) Мінімальна перевірка після імпорту
```sql
SELECT id, name, is_active, markup_percent, min_profit_enabled, min_profit_amount, priority, markup_rule_set_id
FROM suppliers
WHERE lower(name) IN ('white hall', 'sevrukov')
ORDER BY name;
```

```sql
SELECT s.name AS supplier_name, src.id, src.source_type, src.source_url, src.sheet_name, src.is_active
FROM sources src
JOIN suppliers s ON s.id = src.supplier_id
WHERE lower(s.name) IN ('white hall', 'sevrukov')
ORDER BY s.name, src.id;
```

```sql
SELECT s.name AS supplier_name, cm.id, cm.source_id, cm.header_row, cm.comment, cm.created_at
FROM column_mappings cm
JOIN suppliers s ON s.id = cm.supplier_id
WHERE lower(s.name) IN ('white hall', 'sevrukov')
ORDER BY s.name, cm.id DESC;
```
