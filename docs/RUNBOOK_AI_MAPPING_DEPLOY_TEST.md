# Runbook: AI Mapping Wizard — деплой на TEST + тестовий reset бази

**Дата:** 2026-05-24.
**Гілка:** `develop`.
**Призначення:** покроковий план для безпечного rollout AI Mapping Wizard на test-середовище + чистий reset продуктових даних для тестування з нуля.

---

## 0. Передумови

- [ ] Зміни закомічені та запушені в `origin/develop`.
- [ ] Anthropic API key готовий (формат `sk-ant-api03-...`).
- [ ] У тебе SSH-доступ до `WorkfloMain`.
- [ ] Знаєш що **після reset бази все доведеться перезавантажувати** (supplier sheets, mappings, store_mirror).

---

## 1. Деплой коду на TEST

```bash
ssh user@WorkfloMain
cd /var/www/projects/whitehall_cscard_test
git pull origin develop
```

**Перевір що нові файли є:**
```bash
ls migrations/051_master_fields_ai_enrichment.sql
ls migrations/052_ai_mapping_suggestions.sql
ls src/core/ai/AnthropicClient.ts
ls frontend/src/components/AiMappingWizard.jsx
```

---

## 2. Додай ANTHROPIC ENV до docker-compose (одноразово)

Перевір що у `.env` test-середовища є:

```bash
ANTHROPIC_API_KEY=sk-ant-api03-...
ANTHROPIC_MODEL_MAPPING=claude-sonnet-4-5
ANTHROPIC_MODEL_TAB_ANALYZER=claude-haiku-4-5
ANTHROPIC_MAX_RETRIES=3
ANTHROPIC_TIMEOUT_MS=180000
```

> Якщо немає — додай у `/var/www/projects/whitehall_cscard_test/.env` (поряд з іншими `CSCART_*`/`DATABASE_URL`). Docker compose підхопить його при `up -d`.

---

## 3. Білд + рестарт

```bash
docker compose up -d --build app
```

Це:
1. Запустить новий контейнер з оновленим кодом.
2. На старті `runMigrations.js` застосує **051_master_fields_ai_enrichment** + **052_ai_mapping_suggestions**.
3. Бекенд перезапуститься, frontend заберуться з `public/admin/`.

---

## 4. Verify міграції пройшли

```bash
# Перевірка 1: нові колонки у master_fields
docker exec -i whitehall-cscard-test-db psql -U whitehall_store -d whitehall_store -c \
  "SELECT column_name FROM information_schema.columns WHERE table_name='master_fields' AND column_name IN ('description_ai','example_values','applies_to','cardinality','anti_examples','format_hint') ORDER BY column_name;"
# Має бути 6 рядків.

# Перевірка 2: нові таблиці
docker exec -i whitehall-cscard-test-db psql -U whitehall_store -d whitehall_store -c \
  "SELECT tablename FROM pg_tables WHERE tablename IN ('sheet_tab_analyses','column_mapping_suggestions') ORDER BY tablename;"
# Має бути 2 рядки.

# Перевірка 3: всі 23 master_fields мають description_ai
docker exec -i whitehall-cscard-test-db psql -U whitehall_store -d whitehall_store -c \
  "SELECT COUNT(*) FROM master_fields WHERE description_ai IS NOT NULL AND LENGTH(description_ai) > 50;"
# Має бути 23.
```

Якщо хоч одна перевірка fail — **не йди далі**, відкоти `git reset --hard HEAD~1`, перерозберись.

---

## 5. Verify AI endpoint живий

```bash
# Логін отримати session cookie
curl -s -c /tmp/test_cookies.txt -X POST \
  https://whitehallshoptest.workflo.space/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin","password":"YOUR_ADMIN_PASSWORD"}'

# Перевірити що AI enabled
curl -s -b /tmp/test_cookies.txt \
  https://whitehallshoptest.workflo.space/admin/api/ai-mapping/status
# Очікувано: {"enabled":true,"models":{"mapping":"claude-sonnet-4-5","tabAnalyzer":"claude-haiku-4-5"}}
```

Якщо `enabled: false` — env var не підхопився. Перезапусти `docker compose restart app` та перевір `docker exec whitehall-cscard-test-app env | grep ANTHROPIC`.

---

## 6. Reset продуктових даних на TEST

**⚠️ ЦЕ ВИДАЛИТЬ ВСЕ:** suppliers, sources, mappings, products_raw, products_final, store_mirror, catalog_*, jobs, logs.
**НЕ видаляє:** users, scheduler_settings, markup_rule_sets, master_fields, color_mappings, size_mappings, category_mappings.

> **🚨 ВАЖЛИВО про `products_raw`:** це partitioned table (міграція 021). У ній є БАГАТО child partitions: `products_raw_YYYYMMDD` (по одній на дату), плюс DEFAULT — `products_raw_p`. **TRUNCATE `products_raw_p` НЕ зачищає day-partitions** — лишається orphan-дата старих імпортів.
> Завжди роби **`TRUNCATE products_raw CASCADE`** (з БАТЬКА) — це автоматично truncate всі child partitions.

```bash
docker exec -i whitehall-cscard-test-db psql -U whitehall_store -d whitehall_store <<'SQL'
BEGIN;

-- 1. Stop активні jobs (інакше pipeline помре посеред операції).
UPDATE cron_settings SET is_enabled = false WHERE name IN ('update_pipeline','store_mirror_sync','cleanup','catalog_assemble');

-- 2. Catalog (depends on offers, які depend на final).
TRUNCATE catalog_master_field_values CASCADE;
TRUNCATE catalog_offers CASCADE;
TRUNCATE catalog_variants CASCADE;
TRUNCATE catalog_masters CASCADE;
TRUNCATE catalog_assembly_runs CASCADE;

-- 3. Pipeline tables.
TRUNCATE products_final CASCADE;
TRUNCATE products_raw CASCADE;          -- parent table — truncate ALL child partitions
                                        -- (НЕ products_raw_p — це лише DEFAULT partition)
TRUNCATE store_mirror CASCADE;
TRUNCATE compare_preview CASCADE;       -- якщо існує

-- 4. AI suggestions (історія).
TRUNCATE column_mapping_suggestions CASCADE;
TRUNCATE sheet_tab_analyses CASCADE;

-- 5. Mappings + sources + suppliers.
TRUNCATE column_mappings CASCADE;
TRUNCATE sources CASCADE;
TRUNCATE suppliers CASCADE;

-- 6. Jobs + logs (історія).
TRUNCATE logs CASCADE;
TRUNCATE job_locks CASCADE;
TRUNCATE jobs CASCADE;

-- 7. Verify.
SELECT 'suppliers' AS t, COUNT(*) FROM suppliers
UNION ALL SELECT 'sources', COUNT(*) FROM sources
UNION ALL SELECT 'column_mappings', COUNT(*) FROM column_mappings
UNION ALL SELECT 'products_raw (all partitions)', COUNT(*) FROM products_raw
UNION ALL SELECT 'products_final', COUNT(*) FROM products_final
UNION ALL SELECT 'store_mirror', COUNT(*) FROM store_mirror
UNION ALL SELECT 'catalog_masters', COUNT(*) FROM catalog_masters
UNION ALL SELECT 'jobs', COUNT(*) FROM jobs
UNION ALL SELECT 'users (зберігаються)', COUNT(*) FROM users
UNION ALL SELECT 'master_fields (зберігаються)', COUNT(*) FROM master_fields;

COMMIT;
SQL
```

Усі лічильники окрім `users` та `master_fields` мають бути 0. `master_fields` = 23.

---

## 7. Тестовий E2E проганяння AI Wizard

1. Відкрий https://whitehallshoptest.workflo.space/admin → логін.
2. Вкладка **Постачальники** → **+ Новий**.
3. Заповни: назва (наприклад `test_europasport`), priority `100`, markup за замовч.
4. Збережи → клікни на supplier → **Мапінги**.
5. **+ Додати** source (тип `gsheet`, URL `https://docs.google.com/spreadsheets/d/...`).
6. Збережи → з'явиться синій блок **🤖 AI Mapping Wizard**.
7. Встав URL → "Знайти tabs через AI" (Haiku, ~3-5с).
8. Обери tab → "Аналізувати" (Sonnet, **до 2 хв**).
9. У review-панелі перевір warnings, конфірмні поля → "Apply mapping".
10. Mapping editor відкриється → перевір → **Save**.
11. Тригерни **Import** для цього source → перевір `products_raw_p`.

---

## 8. Якщо щось пішло не так — rollback

```bash
cd /var/www/projects/whitehall_cscard_test
git log --oneline -3              # знайди попередній commit
git reset --hard <prev_commit>
docker compose up -d --build app
```

**Schema rollback** (якщо треба прибрати міграції):
```sql
DROP TABLE IF EXISTS column_mapping_suggestions;
DROP TABLE IF EXISTS sheet_tab_analyses;
ALTER TABLE master_fields
  DROP COLUMN IF EXISTS description_ai,
  DROP COLUMN IF EXISTS example_values,
  DROP COLUMN IF EXISTS applies_to,
  DROP COLUMN IF EXISTS cardinality,
  DROP COLUMN IF EXISTS anti_examples,
  DROP COLUMN IF EXISTS format_hint;
DELETE FROM migration_history WHERE name IN ('051_master_fields_ai_enrichment','052_ai_mapping_suggestions');
```

> **Не запускай rollback без явної необхідності** — старий код буде падати на запитах до видалених колонок якщо встиг закешуватись.

---

## 9. Чек-ліст готовності до тестування

- [ ] `git pull` на тест зробив (commit з AI Mapping Wizard у HEAD).
- [ ] `.env` має `ANTHROPIC_API_KEY` + 4 інші AI vars.
- [ ] `docker compose up -d --build app` без помилок.
- [ ] Міграції 051 + 052 пройшли (verify крок 4).
- [ ] `/admin/api/ai-mapping/status` повертає `enabled: true`.
- [ ] Тестовий reset бази виконаний (всі лічильники = 0, окрім users + master_fields).
- [ ] Cron `update_pipeline` / `store_mirror_sync` вимкнені на час тестів.
- [ ] У UI вкладка Постачальники → новий supplier → AI Wizard працює.

---

## 10. Після тестування — повернутися в звичайний режим

Якщо тестування пройшло, треба ввімкнути cron-и:

```sql
UPDATE cron_settings SET is_enabled = true
 WHERE name IN ('update_pipeline','store_mirror_sync','cleanup');
```

`catalog_assemble` залиш `is_enabled=false` (він manual).

---

## Питання які можуть виникнути

**Q:** Чи безпечно дропати products_raw_p на TEST якщо там вже були реальні дані?
**A:** Так, TEST не має staging для PROD — це повністю окрема БД. Дропати на TEST = втратити ТІЛЬКИ test data. PROD не зачіпається.

**Q:** Що буде з PROD якщо AI Wizard додасться в TEST?
**A:** Нічого. Гілка `develop` йде ТІЛЬКИ на TEST. PROD читає `main` — поки не зробиш `git merge develop && git push origin main`, продакшн не побачить нових файлів.

**Q:** Скільки буде коштувати тестування на 5-10 постачальниках?
**A:** ~$1.5-3 (Sonnet). Якщо хочеш дешевше — постав `ANTHROPIC_MODEL_MAPPING=claude-haiku-4-5` (буде ~3x менше).

**Q:** AI пропозиція зберігається у БД назавжди?
**A:** Так, в `column_mapping_suggestions` (включно з повним raw_response). Це історія + дебаг + матеріал для майбутнього few-shot. Можна почистити через `TRUNCATE column_mapping_suggestions;` будь-коли.
