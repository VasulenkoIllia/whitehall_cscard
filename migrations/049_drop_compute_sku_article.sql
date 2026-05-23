-- Migration 049: видалити сирітську функцію compute_sku_article.
--
-- Функція створена у міграції 035 для старого MasterAssembler (через
-- store_mirror-anchored схему). Після переходу на офлайн catalog_*
-- (міграції 043+044) CatalogAssembler використовує normalize_article()
-- замість compute_sku_article. У коді немає жодних посилань.
--
-- Безпечно дропаємо.

DROP FUNCTION IF EXISTS compute_sku_article(TEXT, TEXT);
