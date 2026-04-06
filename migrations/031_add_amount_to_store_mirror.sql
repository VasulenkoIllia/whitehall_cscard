-- Migration 031: Add amount column to store_mirror
-- Tracks product quantity from CS-Cart so delta filter can detect amount changes
-- without loading all products into memory via fetchProductIndexByCode.

ALTER TABLE store_mirror
  ADD COLUMN IF NOT EXISTS amount INTEGER NOT NULL DEFAULT 0;
