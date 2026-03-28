/**
 * Shared SKU-prefix validation used by CatalogAdminService and import scripts.
 * Keep in sync with:
 *   - migrations/028_add_supplier_sku_prefix.sql  (CHECK constraint regex)
 *   - frontend/src/App.jsx                        (SUPPLIER_SKU_PREFIX_RE)
 */

export const SUPPLIER_SKU_PREFIX_RE = /^[A-Z0-9][A-Z0-9_-]{0,23}$/;

/**
 * Normalises and validates a raw SKU prefix value.
 * Returns `null` for absent / empty values.
 * Throws a plain `Error` for invalid format — callers wrap it as needed
 * (e.g. HTTP 400 in the service layer, script exit in CLI scripts).
 */
export function normalizeSkuPrefixRaw(value: unknown): string | null {
  if (value === null || typeof value === 'undefined') {
    return null;
  }
  const normalized = String(value).trim().toUpperCase();
  if (!normalized) {
    return null;
  }
  if (!SUPPLIER_SKU_PREFIX_RE.test(normalized)) {
    throw new Error(
      `sku_prefix "${normalized}" is invalid (allowed: A–Z, 0–9, "-", "_"; max 24 chars)`
    );
  }
  return normalized;
}
