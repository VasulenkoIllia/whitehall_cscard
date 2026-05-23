-- Migration 044: drop legacy store-anchored master_* tables.
--
-- Phase 1 був анкорований на CS-Cart store_mirror — формував master_collections /
-- master_products / master_variations / master_offers через parent_product_id +
-- collection_code. У Phase 2 (Migration 043) каталог відв'язано від магазину —
-- catalog_* таблиці тепер ведуться суто з постачальницьких даних.
--
-- Старі master_* таблиці більше нічого не пишуть, не читаються UI або сервісами
-- (MasterAssembler, MasterAdminService, masterRoutes були видалені у цій же
-- ітерації). Дропаємо як dead-код.
--
-- Порядок DROP — у зворотному порядку FK залежностей. CASCADE щоб додаткові
-- залежності (індекси, тригери) пішли разом. Жодних даних з цих таблиць не
-- потрібно зберігати — catalog_master_field_values вже заміняє
-- master_collection_field_values з нуля.

DROP TABLE IF EXISTS master_collection_field_values CASCADE;
DROP TABLE IF EXISTS master_offers CASCADE;
DROP TABLE IF EXISTS master_variations CASCADE;
DROP TABLE IF EXISTS master_products CASCADE;
DROP TABLE IF EXISTS master_assembly_runs CASCADE;
DROP TABLE IF EXISTS master_collections CASCADE;

-- master_fields лишається — це shared конфіг канонічних полів. catalog_master_field_values
-- посилається на нього. Не дропаємо.
