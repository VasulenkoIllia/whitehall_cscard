# CS-Cart connector parity (REST API)

Основні ендпоїнти (CS-Cart REST, basic auth user = email, password = API key) citeturn0search3:
- GET `/api/products?items_per_page=100&page=1` — дзеркало каталогу (поля: `product_id`, `product_code`, `status`, `price`, `amount`, `updated_timestamp`, `parent_product_id`).
- PUT `/api/products/{id}` — оновлення існуючого товару (наприклад, ціна/статус).
- POST `/api/products` — створення нового товару (мінімум: `product_code`, `price`, `status`).
- Статус: `A` (active/visible), `H` (hidden), `D` (disabled).
- Режим за замовчуванням: **update-only** (PUT по існуючому product_id з mirror). POST створення вмикається лише якщо `CSCART_ALLOW_CREATE=true`.

Пропонований мапінг з нейтрального preview:
- `article` → `product_code`
- `parent_article` → `parent_product_id` (для варіантів; якщо немає — null)
- `visibility` → `status` (`A` коли true, `H` коли false)
- `price_final` → `price`
- `size` → поки що частина `product_code` (article-size), як у Horoshop-конекторі; окрема модель варіантів — наступний етап.

Auth / env для CS-Cart:
- `CSCART_BASE_URL` — базовий URL магазину (без `/api` в кінці).
- `CSCART_API_USER` — email адміністратора (basic auth user).
- `CSCART_API_KEY` — API key (basic auth password).
- `CSCART_STOREFRONT_ID` — опціонально, якщо потрібно спрямовувати на конкретний storefront.

Паритет із Horoshop-гейтвеєм:
- Mirror: пагінація через `items_per_page` + `page`; зберігати `nextCursor = page+1` поки `page*items_per_page < total_items`.
- Import: батчувати 50–100 товарів, retry/backoff при 429/5xx, логувати статичні коди помилок.
- Visibility toggle: через `status` поле, без видалень.
- Повний resync mirror: опція cron раз/тиждень — truncate локального mirror і повне проходження GET `/api/products`.

Що реалізувати у `src/connectors/cscart`:
- Gateway з basic auth (email/API key), спільні HTTP helper-и, обмеження швидкості.
- Mapper, що будує payload: `{ product_code, status, price, parent_product_id }`.
- Контрактні тести: pagination, статуси `A/H`, створення/оновлення.

## Практичні вимірювання (whitehall.com.ua)
- GET `/api/products?items_per_page=1` → 1 товар, `total_items=663`.
- GET з `items_per_page=250` → 250 товарів.
- GET з `items_per_page=500` → 500 товарів.
- GET з `items_per_page=1000` → 663 товарів (увесь каталог). Отже сторінка приймає ≥1000 позицій, обмеження визначається налаштуванням “Elements per page” в адмінці.

## Оновлення 100–300k товарів
- Масових імпортів немає: тільки POST/PUT поштучно.
- За замовчуванням створення вимкнене (`CSCART_ALLOW_CREATE=false`), SKU без match у mirror — skip + warning.
- Рекомендований throttle: `CSCART_RATE_LIMIT_RPS` 10 (burst 20), конфігуровано; експоненційний backoff на 429/5xx.
- Батч процесингу: логічні групи 50–100 запитів, рахувати успіх/фейл, ETA. При 10 RPS 300k оновлень ≈ 8.3 год; при 15 RPS ≈ 5.5 год — потрібен стейджинг-тест перед підняттям RPS.
- `CSCART_ITEMS_PER_PAGE` ставити 1000 для mirror, щоб мінімізувати кількість сторінок.
