# Architecture baseline after docs review

## Що закладено в `whitehall_cscard`
- `src/core/config` — централізоване читання та валідація env (`ACTIVE_STORE`, Horoshop / CS-Cart параметри, finalize flags).
- `src/core/domain` — нейтральні DTO для preview/import/mirror, без прив’язки до конкретного магазину.
- `src/core/pipeline` — orchestration-шар для кроків `import -> finalize -> export -> store import`, який працює через ін’єкцію портів.
- `src/connectors/horoshop` — окремий адаптер Horoshop з мапінгом нейтрального preview в Horoshop payload.
- `src/connectors/cscart` — окремий адаптер CS-Cart з власним payload-контрактом.
- `src/app` — composition root, де вибирається активний конектор і фіксуються точки переносу з legacy.

## Що це змінює відносно legacy
- Старий зв’язок `runners.js -> exportService.js -> horoshopService.js` розбитий на pipeline + connector.
- Нейтральний preview більше не мусить знати про Horoshop-поля `presence_ua` або `display_in_showcase`.
- Перемикання магазину відбувається через `ACTIVE_STORE`, а не через жорсткі імпорти сервісів.

## Наступний порядок переносу
1. (TODO) Перенести імпорт джерел із `/Users/monstermac/WebstormProjects/whitehall.store_integration/src/services/importService.js` у `src/core/pipeline`.
2. (TODO) Перенести finalize з `/Users/monstermac/WebstormProjects/whitehall.store_integration/src/services/finalizeService.js`, одразу прибравши жорсткий `DELETE` за флагом.
3. (TODO) Винести з `/Users/monstermac/WebstormProjects/whitehall.store_integration/src/services/exportService.js` нейтральний preview builder і залишити store-specific mapping лише в конекторах.
4. (TODO) Перенести Horoshop gateway із `/Users/monstermac/WebstormProjects/whitehall.store_integration/src/services/horoshopService.js` у `src/connectors/horoshop`.

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
- `HOROSHOP_RATE_LIMIT_RPS`, `HOROSHOP_RATE_LIMIT_BURST` — throttle для Horoshop API (стартово 5 RPS, burst 10).

## Auth/roles (просте закриття адмінки)
- 2 ролі: `admin` (повний доступ), `viewer` (тільки перегляд).
- Стратегія за замовчуванням: cookie-сесії + таблиця `users` або env-список (bcrypt-хеші), без реєстрацій.
- Мінімальні env: `AUTH_STRATEGY=db|env`, `AUTH_SESSION_SECRET`, для env-варіанту `AUTH_USERS_JSON=[{email, password_hash, role}]`.
- Усі `/admin` і `/admin/api` захищені middleware; GET-доступ для viewer, mutating — тільки admin.
- Статус: middleware + login/logout API реалізовано, таблиця `users` додана (міграція 020); інтеграція з реальними маршрутизаторами admin-ui — TODO.
