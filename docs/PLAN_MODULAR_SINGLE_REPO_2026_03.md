# Modular re-arch plan (single repo, swappable connector)

## Goals
- Залишаємо один кодовий базис, але вводимо модулі й інтерфейси, щоб сьогодні працювати з Horoshop, а потім замінити конектор на CS-Cart без перепису ядра.
- Зберегти бізнес-логіку: імпорт постачальників, націнка, дедуп, фіналізація, експорт/імпорт у магазин.
- Підготуватися до 500k+ позицій на добу без деградації.

## Поточні опорні місця
- Імпорт, прайсинг, дедуп: [src/services/importService.js](/Users/monstermac/WebstormProjects/whitehall.store_integration/src/services/importService.js), [src/services/finalizeService.js](/Users/monstermac/WebstormProjects/whitehall.store_integration/src/services/finalizeService.js), [src/services/dedupService.js](/Users/monstermac/WebstormProjects/whitehall.store_integration/src/services/dedupService.js).
- Оркестрація задач: [src/jobs/runners.js](/Users/monstermac/WebstormProjects/whitehall.store_integration/src/jobs/runners.js), [src/jobs/scheduler.js](/Users/monstermac/WebstormProjects/whitehall.store_integration/src/jobs/scheduler.js).
- Конектор Horoshop: [src/services/horoshopService.js](/Users/monstermac/WebstormProjects/whitehall.store_integration/src/services/horoshopService.js), експорт: [src/services/exportService.js](/Users/monstermac/WebstormProjects/whitehall.store_integration/src/services/exportService.js).
- UI: [admin-ui/src/App.jsx](/Users/monstermac/WebstormProjects/whitehall.store_integration/admin-ui/src/App.jsx).

## Цільова модульність у межах одного репо
- `core/domain`: типи й сервіси постачальників, прайсингу, дедуп, мапінгу, DTO для конекторів.
- `core/pipeline`: імпорт → прайсинг → дедуп → finalize → export preview; без прив’язки до магазину.
- `connectors/horoshop`: реалізація інтерфейсу `StoreConnector` (mirror fetch, delta push, visibility toggle).
- `connectors/cscart`: другий адаптер, підключається пізніше, спільний інтерфейс.
- `infra/db`: міграції, доступ до БД, партиції, перевірки конфігів.
- `admin-ui`: виділені сторінки й API-клієнт, що працює через єдиний бекенд з параметром `store=horoshop|cscart`.

## Мінімальні зміни для запуску з Horoshop (етап 1)
- Виділити інтерфейс `StoreConnector` і обгорнути поточний Horoshop код у клас/модуль у `connectors/horoshop`.
- Привести pipeline до ін’єкції конектора: `runExport`, `runHoroshopImport` повинні приймати конектор замість жорсткого імпорту сервісу.
- Замінити глобальний `DELETE` у finalize на UPSERT/MERGE у `products_final` (початково можна залишити старий код за флагом `FINALIZE_LEGACY=true`).
- Додати в `config` параметр `ACTIVE_STORE=horoshop|cscart` та валідацію `.env`.

## Підготовка до заміни конектора (етап 2)
- Винести формат `export preview` у нейтральний вигляд: `article, size, price_final, visibility, parent_article, supplier`. Зараз це робиться в [exportService.js](/Users/monstermac/WebstormProjects/whitehall.store_integration/src/services/exportService.js); відокремити форму для магазину.
- Додати шар мапінгу атрибутів (size, parent, visibility) між `core` та конектором, щоб CS-Cart міг мати свої поля.
- Створити загальний mirror-інтерфейс: `fetchMirrorPage(cursor)` → map до `MirrorRow { article, supplier, parent, visibility, price }`.

## Оптимізації БД, сумісні з поточним кодом
- Додати партиції `products_raw` за `job_id` (daily) і індекс `(job_id, article, size)`; міграція без зміни API.
- Додати індекс `products_final(article, size, price_final)` для швидших дельт.
- У `finalize` додати флаг `FINALIZE_DELETE_ENABLED` і підготувати заміну на UPSERT.

## UI кроки без перепису з нуля
- Розбити `App.jsx` на маршрути: Dashboard, Suppliers/Sources, Pricing, Jobs/Logs, Settings.
- Додати селектор активного магазину (спочатку лише Horoshop, але структура UI готується до CS-Cart).
- Винести API-клієнт у `/admin-ui/src/api.js`, щоб легко перемкнути базовий шлях/connector.

## Порядок робіт
1. Створити модулі `core` і `connectors/horoshop`, перепідключити `runners.js` до ін’єкційного конектора (без зміни бізнес-логіки).
2. Додати міграції: партиції `products_raw`, індекс `products_final`, флаг `FINALIZE_DELETE_ENABLED`.
3. В UI розділити App на сторінки та додати параметр активного магазину в запити.
4. Прогнати повний цикл з Horoshop → переконатися, що новий шар не зламав логіку.
5. Реалізувати `connectors/cscart` у тому ж репо, використовуючи той самий інтерфейс; переключитися флагом `ACTIVE_STORE=cscart` для тесту.
6. Коли CS-Cart готовий, винести конектори в окремі пакети або залишити в монорепо — код ядра вже відокремлений.

## Ризики та контроль
- Потенційні lock-и при великих DELETE у finalize → готуємо UPSERT й партиції.
- Відсутність тестів → одразу закладаємо integration-тести на pipeline з фікстурами CSV/Sheets і контрактні тести для `StoreConnector`.
- Конфіг без валідації → додати схему env до старту сервера.

## Що потрібно від замовника
- Підтвердження, що працюємо у межах цього репо на першому етапі.
- Доступ до staging CS-Cart для подальшої імплементації конектора.
- Часові вікна для прогонів на 500k+ записів (щоб виміряти фактичний приріст).
