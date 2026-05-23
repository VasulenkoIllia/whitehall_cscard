-- Migration 047: видалити parent_code з master_fields.
--
-- parent_code дублював те, що вже є master ідентифікатором (catalog_masters.display_article
-- = products_final.article, який містить supplier_sku_prefix + raw_article = "SKU ефективний"
-- = "Колекція+модель батьківський" у термінах існуючої системи).
--
-- Master сам по собі є батьком. Окреме поле для його коду не потрібне — використовується
-- catalog_masters.display_article. У UI це показується як header картки.

DELETE FROM master_fields WHERE key = 'parent_code';
