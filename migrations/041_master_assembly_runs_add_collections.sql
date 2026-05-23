-- Migration 041: add collections_upserted to master_assembly_runs.
--
-- Після введення Level-1 (master_collections), MasterAssembler повертає кількість
-- зведених колекцій. Зберігаємо її в runs, щоб UI міг показати у топ-барі.

ALTER TABLE master_assembly_runs
  ADD COLUMN IF NOT EXISTS collections_upserted INT NOT NULL DEFAULT 0;
