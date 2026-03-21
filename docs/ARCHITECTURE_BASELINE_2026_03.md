# Architecture baseline after docs review

## Що закладено в `whitehall_cscard`
- `src/core/config` — централізоване читання та валідація env (`ACTIVE_STORE`, CS-Cart параметри, finalize flags). Horoshop конектор буде підключено окремо при потребі.
- `src/core/domain` — нейтральні DTO для preview/import/mirror, без прив’язки до конкретного магазину.
- `src/core/pipeline` — orchestration-шар для кроків `import -> finalize -> export -> store import`, який працює через ін’єкцію портів.
- `src/core/alerts` — окремий модуль error-alert sink (Telegram), підключений до `LogService` без впливу на бізнес-флоу.
- `src/connectors/cscart` — активний адаптер CS-Cart (update-only за замовчуванням, throttle/backoff).
- `src/app` — composition root, де вибирається активний конектор і фіксуються точки переносу з legacy.

## Що це змінює відносно legacy
- Старий зв’язок `runners.js -> exportService.js -> horoshopService.js` розбитий на pipeline + connector.
- Нейтральний preview більше не мусить знати про Horoshop-поля `presence_ua` або `display_in_showcase`.
- Перемикання магазину відбувається через `ACTIVE_STORE`, а не через жорсткі імпорти сервісів.
- Додано вбудований scheduler (env-driven) для job orchestration без окремого зовнішнього cron-процесу.

## Наступний порядок переносу (активно працюємо тільки з CS-Cart)
1. (in progress) Імпорт Google Sheets у `src/core/pipeline/importerDb` (CS-Cart цикл).
2. (done) Finalize UPSERT у `FinalizerDb`, індекси/партиції.
3. (done) Нейтральний preview builder (`ExportPreviewDb`) → CsCart/Horoshop конектори.
4. (later) Horoshop gateway і модуль буде додано окремо; наразі `ACTIVE_STORE` = cscart.

## Retention & cleanup (для 5×500k запусків/добу)
- Партиціювання `products_raw` по дню/`created_at`; індекс партицій `(job_id, article, size)`. Видалення через drop partition за `RETENTION_DAYS`, залишаючи останні `IMPORT_RETAIN_JOBS` успішних import_all навіть якщо вони старші.
- Індекс `products_final(article, size, price_final)`; finalize → UPSERT/MERGE без глобальних DELETE.
- Cleanup крон: чистити `horoshop_api_preview`, `job_locks`, старі файли експорту; логувати скільки партицій дропнуто та скільки рядків залишилось.
- Конектори: батчі/бекпрешер + retry/backoff; опціональний щотижневий повний resync mirror (truncate + sync) замість вічного росту.

## CS-Cart env (для активного `ACTIVE_STORE=cscart`)
- `CSCART_BASE_URL` — базовий URL магазину (без `/api` наприкінці).
- `CSCART_API_USER` — email для basic auth.
- `CSCART_API_KEY` — API key (basic auth password).
- `CSCART_STOREFRONT_ID` — опційний storefront.
- `CSCART_ITEMS_PER_PAGE` — розмір сторінки mirror (рекомендовано 1000, виміряно на whitehall.com.ua).
- `CSCART_RATE_LIMIT_RPS`, `CSCART_RATE_BURST` — ліміт запитів при оновленні товарів (стартово 10 RPS, burst 20) з backoff на 429/5xx.
- `CSCART_ALLOW_CREATE` — дозволити POST створення нових SKU (default false). За замовчуванням тільки PUT по mirror (update-only).
- `HOROSHOP_RATE_LIMIT_RPS`, `HOROSHOP_RATE_LIMIT_BURST` — throttle для Horoshop API (стартово 5 RPS, burst 10).

## Scheduler env (pipeline automation)
- `SCHEDULER_ENABLED` — глобально увімкнути scheduler (`true|false`, default `false`).
- `SCHEDULER_TICK_SECONDS` — крок опитування scheduler (default `30`).
- `SCHEDULER_UPDATE_PIPELINE_ENABLED` — запуск `update_pipeline`.
- `SCHEDULER_UPDATE_PIPELINE_INTERVAL_MINUTES` — інтервал запуску `update_pipeline` (default `180`).
- `SCHEDULER_UPDATE_PIPELINE_RUN_ON_STARTUP` — одноразовий запуск `update_pipeline` після старту сервера.
- `SCHEDULER_UPDATE_PIPELINE_SUPPLIER` — фільтр supplier для `update_pipeline` (optional).
- `SCHEDULER_STORE_MIRROR_SYNC_ENABLED` — запуск `store_mirror_sync`.
- `SCHEDULER_STORE_MIRROR_SYNC_INTERVAL_MINUTES` — інтервал sync mirror (default `120`).
- `SCHEDULER_STORE_MIRROR_SYNC_RUN_ON_STARTUP` — одноразовий mirror sync після старту.
- `SCHEDULER_CLEANUP_ENABLED` — запуск `cleanup`.
- `SCHEDULER_CLEANUP_INTERVAL_MINUTES` — інтервал cleanup (default `720`).
- `SCHEDULER_CLEANUP_RUN_ON_STARTUP` — одноразовий cleanup після старту.

## Auth/roles (просте закриття адмінки)
- 2 ролі: `admin` (повний доступ), `viewer` (тільки перегляд).
- Стратегія за замовчуванням: cookie-сесії + таблиця `users` або env-список (bcrypt-хеші), без реєстрацій.
- Мінімальні env: `AUTH_STRATEGY=db|env`, `AUTH_SESSION_SECRET`, для env-варіанту `AUTH_USERS_JSON=[{email, password_hash, role}]`.
- Усі `/admin` і `/admin/api` захищені middleware; GET-доступ для viewer, mutating — тільки admin.
- Статус: middleware + login/logout API реалізовано, таблиця `users` додана (міграція 020); інтеграція з реальними маршрутизаторами admin-ui — TODO.

## Alerts env (optional)
- `TELEGRAM_BOT_TOKEN` — токен Telegram bot.
- `TELEGRAM_CHAT_ID` — chat/channel id для алертів.
- `TELEGRAM_APP_NAME` — optional префікс у повідомленні.
- `TELEGRAM_TIMEOUT_MS` — timeout запиту до Telegram API (default `7000`).
