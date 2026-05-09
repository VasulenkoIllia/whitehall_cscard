# Деплой та інфраструктура

## Середовища

| Середовище | Домен | Гілка | Папка на сервері |
|---|---|---|---|
| **PROD** | https://whitehallshop.workflo.space | `main` | `/var/www/projects/whitehall_cscard` |
| **TEST** | https://whitehallshoptest.workflo.space | `develop` | `/var/www/projects/whitehall_cscard_test` |

## Сервер

- **Хост:** WorkfloMain
- **Реверс-проксі:** Traefik (мережа `proxy`)
- **База даних:** PostgreSQL 16 (окремий контейнер на кожне середовище)

## Контейнери

| Середовище | App контейнер | DB контейнер | DB порт (SSH тунель) |
|---|---|---|---|
| PROD | `whitehall-cscard-app` | `whitehall-cscard-db` | `5432` |
| TEST | `whitehall-cscard-test-app` | `whitehall-cscard-test-db` | `5433` |

### Підключення до БД через DataGrip (SSH тунель)
```
ssh -L 5432:localhost:5432 user@WorkfloMain   # PROD
ssh -L 5433:localhost:5433 user@WorkfloMain   # TEST
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

### Pause mirror_sync перед деплоєм міграцій з UPDATE

Бекфіл-UPDATE на `store_mirror` (~30-60 сек на 239k рядків) тримає
RowExclusiveLock на таблиці. Якщо в цей момент `mirror_sync` cron
запускає upsert — обидва упрутся в lock і `runMigrations` може зависнути.
Це вже траплялось при міграції 033 (потребувало ручного `pg_terminate_backend`).

**Перед `docker compose up -d --build app` для деплою з міграцією-бекфілом:**

```bash
docker exec -i whitehall-cscard-db psql -U whitehall_store -d whitehall_store -c \
  "UPDATE cron_settings SET enabled=false WHERE name='store_mirror_sync';"
```

Після успішного деплою + VACUUM:

```bash
docker exec -i whitehall-cscard-db psql -U whitehall_store -d whitehall_store -c \
  "UPDATE cron_settings SET enabled=true WHERE name='store_mirror_sync';"
```

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

```bash
cd /var/www/projects/whitehall_cscard

# Переглянути останні коміти
git log --oneline -10

# Відкотитись на попередній коміт
git checkout <commit-hash>
docker compose up -d --build app
```

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
