-- Migration 050: чистимо дублі у column_mappings + додаємо UNIQUE constraint.
--
-- До цієї міграції saveMapping робив INSERT на кожне збереження → версійна історія.
-- На практиці це призводить до плутанини в UI (адмін бачить кілька рядків для
-- одного й того ж джерела і не розуміє який активний).
--
-- Тепер: 1 рядок на пару (supplier_id, source_id). Збереження = UPSERT.
-- CatalogAssembler.buildTempLatestMappings все одно бере DISTINCT ON — лишається
-- сумісним, просто тепер на нього припадає 1 рядок завжди.
--
-- 1. Видаляємо застарілі версії — лишаємо тільки рядок з найбільшим id для кожної
--    пари (supplier_id, source_id). MAX(id) = найсвіжіший save, який і так
--    використовувався у assemble.

DELETE FROM column_mappings cm
 WHERE cm.id NOT IN (
   SELECT MAX(id) FROM column_mappings GROUP BY supplier_id, source_id
 );

-- 2. UNIQUE constraint. Підстраховка від NULL source_id (PG 16+ підтримує
--    NULLS NOT DISTINCT, але для сумісності — partial index через COALESCE).

CREATE UNIQUE INDEX IF NOT EXISTS column_mappings_supplier_source_uq
  ON column_mappings (supplier_id, source_id)
  WHERE source_id IS NOT NULL;

-- Окремий guard для випадку source_id = NULL (рідко, але можливо).
CREATE UNIQUE INDEX IF NOT EXISTS column_mappings_supplier_null_source_uq
  ON column_mappings (supplier_id)
  WHERE source_id IS NULL;
