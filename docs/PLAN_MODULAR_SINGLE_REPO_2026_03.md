# План повного паритету бізнес-логіки (CS-Cart, March 2026)

## Scope (зафіксовано)
- Активний конектор: `CS-Cart`.
- `Horoshop` на паузі як окремий майбутній конектор і не входить у поточний delivery scope.
- Бізнес-логіка не змінюється: переносимо legacy-правила 1:1, покращуємо тільки архітектуру, стабільність і швидкодію.

## Незмінні вимоги
- Пайплайн має стабільно тримати ітерації `~500k` товарів, `3-5` запусків на добу.
- Без повних hot-path `DELETE` на критичних таблицях.
- Кожна довга job: керована (`cancel`) і відновлювана (`resume`, де застосовно).
- Дані/логи/джоби мають контрольований retention.

## Поточний статус (вже реалізовано)
- Модульний TypeScript каркас (`core`, `connectors`, `app`) у робочому стані.
- Імпорт Google Sheets (`products_raw`) з валідацією mapping і skip-статистикою.
- Finalize перенесений у staging merge path (без небезпечного `ON CONFLICT` припущення).
- Runtime-партиціювання `products_raw` активоване.
- Керований jobs-layer: `import_all`, `finalize`, `store_import`, `update_pipeline`, `cleanup`, `store_mirror_sync`, cancel flow.
- CS-Cart import оптимізований через попередній mirror-index і skip незмінених SKU.
- `store_import` має progress checkpoints + resume.
- Додано паритетні джоби імпорту з legacy:
  - `import_source`
  - `import_supplier`

## Етапи повного паритету

### Phase 1 (in progress): Import parity + orchestration parity
Ціль:
- повний контроль імпорту по сценаріях legacy: all/source/supplier;
- однакова lock/конкурентна семантика.

Статус:
- `import_all`: done
- `import_source`: done
- `import_supplier`: done
- API:
  - `POST /admin/api/jobs/import-all`
  - `POST /admin/api/jobs/import-source`
  - `POST /admin/api/jobs/import-supplier`

### Phase 2 (next): Admin/data-management parity (без зміни правил)
Ціль:
- перенести CRUD і операційні API з legacy в модульну структуру:
  - suppliers
  - sources
  - mappings
  - markup rule sets
  - price overrides
  - stats/logs/read APIs

Принцип:
- правила ціноутворення/дедупу не змінювати;
- виділяти read/write сервіси per-domain для прогнозованої підтримки.

Поточний статус:
- `suppliers`: in progress (CRUD + bulk update + search + A-Я sort API ready)
- `sources`: in progress (CRUD API ready)
- `mappings`: in progress (latest get/save API ready, `comment` field support added)
- `source-sheets/source-preview`: in progress (API ready for mapping flow)
- `markup rule sets`: in progress (list/create/update/apply API ready)
- `price overrides`: in progress (list/upsert/update API ready)
- `stats/logs/read parity`: in progress (`/admin/api/logs`, `/admin/api/stats` ready)
- `preview/export parity`: in progress (`merged/final/compare` preview + CSV export API ready)
- `cron/scheduler settings parity`: in progress (`/admin/api/cron-settings` + DB persistence + runtime apply ready)

### Phase 3: Export/preview parity для CS-Cart
Ціль:
- довести preview/export контролі до parity з legacy для оператора:
  - final preview/export
  - compare preview/export
  - стабільні bounded payload responses для великих вибірок.

### Phase 4: Високе навантаження і стабільність
Ціль:
- підтвердити виробничу стабільність під цільовим обсягом.

Обов’язково:
- staged load tests: 100k / 300k / 500k
- вимірювання throughput:
  - import rows/sec
  - finalize duration
  - store import rate + ETA accuracy
- tuning:
  - `CSCART_RATE_LIMIT_RPS`
  - `CSCART_RATE_LIMIT_BURST`
  - `CSCART_IMPORT_CONCURRENCY`
  - scheduler cadence

Поточний статус:
- scripted load-audit контур додано (`npm run audit:load`, `docs/RUNBOOK_LOAD_AUDIT_2026_03.md`)
- лишається прогін на staging і фіксація фактичного tuning baseline

### Phase 5: Migration cutover readiness
Ціль:
- закрити ризики production cutover.

Критерії:
- всі core сценарії legacy доступні в новому API/UI;
- документація відповідає фактичній реалізації;
- retention і recovery runbook перевірені на staging.
- є керований шлях переносу supplier config зі старої БД (`export/import legacy-config` runbook).

## Пропозиції для прискорення без зміни бізнес-логіки
- Додати lightweight integration tests на критичні інваріанти:
  - mapping validation
  - dedup winner selection
  - price override precedence
  - resume mismatch guards.
- Винести важкі SQL (stats/export) у окремі query-модулі з контрольованими timeout.
- Додати явні operational метрики в jobs meta:
  - rows imported/finalized/exported
  - duration per stage
  - warnings density.

## Короткий execution plan на найближчі кроки
1. Закрити parity по default markup semantics (`markup-rule-sets/default` / `markup_settings` equivalent).
2. Додати інтеграційні тести на mapping/dedup/override/resume інваріанти.
3. Прогнати staged load tests та зафіксувати tuning-профіль у runbook.
4. Провести тестовий перенос legacy supplier config (WHITE HALL, sevrukov) і валідацію імпорту.
