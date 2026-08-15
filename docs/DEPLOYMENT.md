# Деплой та інфраструктура

## Середовища

| Середовище | Домен | Гілка | Папка на сервері |
|---|---|---|---|
| **PROD** | https://system.whitehall.store | `main` | `/var/www/projects/whitehall_cscard` |
| **TEST** | https://systemtest.whitehall.store | `develop` | `/var/www/projects/whitehall_cscard_test` |

> Обидва середовища переїхали на новий сервер у ніч на 15.08.2026. Хід переносу,
> ухвалені рішення та шлях відкату —
> [`RUNBOOK_SERVER_MIGRATION_2026_08.md`](./RUNBOOK_SERVER_MIGRATION_2026_08.md).
> Старі адреси `whitehallshop.workflo.space` і `whitehallshoptest.workflo.space`
> лишились на старому сервері як відкат і згаснуть разом з ним.

## Сервер

- **Хост:** `77.42.87.94`, SSH на нестандартному порту **2222**, користувач `root`:
  ```bash
  ssh -p 2222 root@77.42.87.94
  ```
- **Реверс-проксі:** Traefik у `/var/www/proxy/traefik`, docker-мережа `proxy`
- **Сертифікати:** Let's Encrypt через DNS-01 Cloudflare, resolver `cf`,
  сховище `/var/www/proxy/traefik/acme/acme.json`. Випускаються автоматично,
  щойно стартує контейнер із відповідними лейблами — окремих дій не треба.
- **DNS:** зона `whitehall.store` у Cloudflare, записи **проксійовані**
  (помаранчева хмарка). Відвідувачу Cloudflare віддає свій wildcard-сертифікат,
  до origin ходить по нашому Let's Encrypt → режим SSL має бути **Full**
  (при Flexible буде нескінченний редирект).
- **База даних:** PostgreSQL 16, окремий контейнер на кожне середовище,
  дані на bind-mount `./data/postgres` усередині папки проєкту

## Контейнери

| Середовище | App контейнер | DB контейнер | DB порт (SSH тунель) |
|---|---|---|---|
| PROD | `whitehall-cscard-app` | `whitehall-cscard-db` | `5432` |
| TEST | `whitehall-cscard-test-app` | `whitehall-cscard-test-db` | `5433` |

Порти БД слухають **тільки на `127.0.0.1`**. Назовні відкриті лише 2222 (SSH),
80 і 443.

### Підключення до БД через DataGrip (SSH тунель)
```
ssh -p 2222 -L 5432:localhost:5432 root@77.42.87.94   # PROD
ssh -p 2222 -L 5433:localhost:5433 root@77.42.87.94   # TEST
```

---

## Конфігурація середовища: `.env` і compose

**`.env` більше не версіонується** (коміт `be11318` — файл лежав у публічному
репозиторії). На сервері створюється вручну, права `600`. Бекапи, зняті при
переносі, лежать у `/root/env-*-BEFORE-EDIT-*.bak`.

`docker-compose.yml` **однаковий на обох гілках**: середовище-залежні поля
винесені у змінні з дефолтами (коміт `be70f3f`). Розходження між PROD і TEST
тепер живе виключно в `.env`:

| Ключ | PROD | TEST |
|---|---|---|
| `APP_CONTAINER` | `whitehall-cscard-app` | `whitehall-cscard-test-app` |
| `DB_CONTAINER` | `whitehall-cscard-db` | `whitehall-cscard-test-db` |
| `DB_HOST_PORT` | `5432` | `5433` |
| `ROUTER_NAME` | `whitehall-cscard` | `whitehall-cscard-test` |
| `APP_DOMAIN` | `system.whitehall.store` | `systemtest.whitehall.store` |
| `POSTGRES_PASSWORD` | свій | свій |

`POSTGRES_PASSWORD` мусить збігатися з паролем усередині `DATABASE_URL` — це
найлегша помилка при ручному правленні `.env`. Перевірка:

```bash
cd /var/www/projects/whitehall_cscard
A=$(grep '^POSTGRES_PASSWORD=' .env | cut -d= -f2)
B=$(grep '^DATABASE_URL=' .env | sed -E 's|.*://whitehall_store:([^@]+)@.*|\1|')
[ "$A" = "$B" ] && echo OK || echo РОЗБІЖНІСТЬ
```

Перед перезапуском корисно глянути, що саме зрендериться з `.env`:

```bash
docker compose config | grep -E 'container_name|published|traefik.http.routers'
```

## Робоча копія на сервері: sparse-checkout

Обидва проєкти клоновані з виключенням каталогів, непотрібних у продакшені:

```
/*  !/docs/  !/.claude/  !/.idea/  !/output/
```

Тобто `git pull` **ніколи не притягне документацію на сервер** — вона живе лише
в репозиторії. Перевірити:

```bash
git -C /var/www/projects/whitehall_cscard sparse-checkout list
```

---

## Workflow розробки

```
1. Розробка → гілка develop (локально)
2. git push origin develop
3. Деплой на TEST → перевірка
4. git checkout main && git merge develop && git push origin main
5. Деплой на PROD
```

### Правило: нічого не йде на PROD без перевірки на TEST.

---

## Деплой TEST (гілка develop)

```bash
cd /var/www/projects/whitehall_cscard_test
git pull origin develop
docker compose up -d --build app
```

## Деплой PROD (гілка main)

```bash
cd /var/www/projects/whitehall_cscard
git pull origin main
docker compose up -d --build app
```

### Перевірка після деплою (рекомендована)

```bash
# Які міграції щойно застосовано (нові — рядок "Applied migration ...")
docker logs whitehall-cscard-app --tail 100 | grep -iE "Applied migration|migration.*error"

# Контейнер живий і відповідає
docker compose ps
```

> **Caveat по логах**: `tail 100` може не зловити `Applied migration NNN` якщо app вже встиг
> налогувати багато після старту (mirror_sync, scheduler, request handlers тощо).
> Якщо grep пустий — це ще не означає, що міграція не пройшла. **Завжди підтверджуй
> результат через стан БД**: чи з'явилась нова колонка / запис у `migration_history`.
> Приклад для міграції 034:
> ```bash
> docker exec -i whitehall-cscard-db psql -U whitehall_store -d whitehall_store -c \
>   "SELECT column_name FROM information_schema.columns WHERE table_name='store_mirror' AND column_name='variation_group_code';"
> # 1 рядок означає, що колонка є → міграція пройшла.
> ```

### Якщо міграція робила великий UPDATE / backfill

PostgreSQL не дозволяє `VACUUM` всередині транзакції, а `runMigrations.ts` обгортає
кожен файл у `BEGIN/COMMIT`. Коли міграція робить масовий `UPDATE` (наприклад,
бекфіл нової колонки на 100k+ рядків), створюються мертві версії MVCC →
тимчасове ~+1.2 GB на таблиці. Autovacuum прибере це через години — або вручну:

```bash
docker exec -i whitehall-cscard-db psql -U whitehall_store -d whitehall_store -c \
  "VACUUM (ANALYZE) <table_name>;"
```

`ANALYZE` одразу оновлює статистику для нових індексів — без неї перші
запити можуть піти не оптимальним планом.

Міграції що вимагають VACUUM після застосування (актуальний список):
- `033_add_collection_code_to_store_mirror.sql` → `VACUUM (ANALYZE) store_mirror`.
- `034_add_variation_group_code_to_store_mirror.sql` → `VACUUM (ANALYZE) store_mirror`.

### Pause update_pipeline перед деплоєм міграцій з UPDATE

Бекфіл-UPDATE на `store_mirror` (~30-60 сек на 239k рядків) тримає
RowExclusiveLock на таблиці. Якщо в цей момент знімок магазину запускає
upsert — обидва упрутся в lock і `runMigrations` може зависнути. Це вже
траплялось при міграції 033 (потребувало ручного `pg_terminate_backend`).

Знімок магазину виконується як **крок ① усередині `update_pipeline`**, тому
паузити треба саме пайплайн. Окремої крон-задачі `store_mirror_sync` більше
немає — її прибрано разом із фіксом гонки (див.
[`RUNBOOK_STORE_MIRROR_RACE_2026_07.md`](./RUNBOOK_STORE_MIRROR_RACE_2026_07.md)).

**Перед `docker compose up -d --build app` для деплою з міграцією-бекфілом:**

```bash
docker exec -i whitehall-cscard-db psql -U whitehall_store -d whitehall_store -c \
  "UPDATE cron_settings SET is_enabled=false WHERE name='update_pipeline' RETURNING name, is_enabled;"
```

Пауза застосовується не миттєво: планувальник перечитує `cron_settings` при
старті або при збереженні через `PUT /admin/api/cron-settings`. Тому перед
деплоєм переконайся, що зараз нічого не виконується:

```bash
docker exec -i whitehall-cscard-db psql -U whitehall_store -d whitehall_store -c \
  "SELECT id, type, status FROM jobs WHERE status = 'running' ORDER BY id;"
```

Після успішного деплою + VACUUM:

```bash
docker exec -i whitehall-cscard-db psql -U whitehall_store -d whitehall_store -c \
  "UPDATE cron_settings SET is_enabled=true WHERE name='update_pipeline' RETURNING name, is_enabled;"
```

> **Примітка:** колонка називається саме `is_enabled` (BOOLEAN), а не `enabled`. Перевірити можна командою `\d cron_settings` всередині psql.
>
> **Примітка 2:** прямий `UPDATE` у БД підхоплюється лише після рестарту контейнера. Щоб застосувати на льоту — міняй розклад через адмінку (вкладка «Розклад»), яка ходить у `PUT /admin/api/cron-settings`.

---

## Оновлення користувачів

### 1. Згенерувати хеш пароля
```bash
cd /var/www/projects/whitehall_cscard
docker compose exec app npm run hash-password НовийПароль
```

### 2. Оновити AUTH_USERS_JSON в .env
```
AUTH_USERS_JSON='[
  {"email":"Admin","password_hash":"$2a$12$...","role":"admin"},
  {"email":"View","password_hash":"$2a$12$...","role":"viewer"}
]'
```

### 3. Застосувати
```bash
docker compose exec app npm run seed:users
```

### 4. Видалити старих (якщо потрібно)
```bash
docker compose exec db psql -U whitehall_store whitehall_store -c \
  "DELETE FROM users WHERE email IN ('old1','old2');"
```

---

## Міграція конфігів між середовищами

Конфіги (постачальники, націнки, розклад, маппінги розмірів) — тільки ці таблиці:

### Зробити дамп (з PROD або TEST)
```bash
cd /var/www/projects/whitehall_cscard   # або _test

docker compose exec db pg_dump -U whitehall_store whitehall_store \
  --data-only \
  -t suppliers \
  -t sources \
  -t column_mappings \
  -t markup_rule_sets \
  -t markup_rule_conditions \
  -t markup_settings \
  -t cron_settings \
  -t size_mappings \
  -t price_overrides \
  > /tmp/whitehall_config.sql
```

### Відновити в інше середовище
```bash
cd /var/www/projects/whitehall_cscard_test   # або prod

docker compose exec -T db psql -U whitehall_store whitehall_store < /tmp/whitehall_config.sql
```

---

## Відкат PROD у разі проблем

### Відкат коду (звичайний випадок)

```bash
cd /var/www/projects/whitehall_cscard

# Переглянути останні коміти
git log --oneline -10

# Відкотитись на попередній коміт
git checkout <commit-hash>
docker compose up -d --build app
```

### Відкат на старий сервер (поки він живий)

Старий сервер лишається цілим із даними станом на момент переносу. Повернення:

```bash
# НА СТАРОМУ сервері (49.12.219.133, користувач workflo)
cd /var/www/projects/whitehall_cscard && docker compose start app
```

> **Обережно: шляхи на обох серверах ідентичні** (`/var/www/projects/whitehall_cscard`
> і `..._test`). Команду, скопійовану без прив'язки до хоста, легко виконати не на
> тій машині — так уже було з `docker compose stop`. Для команд на старому сервері
> використовуй запобіжник:
> ```bash
> if [ "$(hostname)" = "WorkfloMain" ]; then cd /var/www/projects/whitehall_cscard && docker compose ps -a; else echo "НЕ ТОЙ СЕРВЕР: $(hostname)"; fi
> ```

> **Поки ключі не ротовані**, старий і новий прод мають один CS-Cart API-юзер,
> один Google service account і один Telegram-бот. Обидва одночасно запускати
> НЕ можна — вони писатимуть в один магазин і одну таблицю покупцям.

---

## Моніторинг

```bash
# Логи в реальному часі
docker compose logs app -f --tail=50

# Перевірити статус контейнерів
docker compose ps

# Перевірити health
docker compose exec app node -e "require('http').get('http://127.0.0.1:3000/health', r => { console.log(r.statusCode); process.exit(0); })"
```
