# Import-Export Architecture Codemap

**Last Updated:** 2026-04-07
**Key Files:** exportPreviewDb.ts, CsCartConnector.ts, StoreMirrorService.ts, CsCartGateway.ts, createApplication.ts

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     products_final (DB)                          │
│  article="GY6433", size="37.5", quantity=50, price_final=199.99 │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│         ExportPreviewDb.buildNeutralPreview()                   │
│  - Combines article + size → "GY6433-37.5" (full article code) │
│  - Extracts quantity from products_final                        │
│  - Sets visibility = (quantity > 0)                             │
│  - Returns ExportPreviewRow (includes quantity)                 │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│        CsCartConnector.createImportBatch()                      │
│  Maps ExportPreviewRow → CsCartImportRow:                       │
│  - productCode: "GY6433-37.5" (full article from above)        │
│  - amount: row.quantity (passed through)                        │
│  - visibility, price, parentProductCode                         │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│    StoreMirrorService.filterCsCartDelta()                       │
│  Three-phase delta filter:                                      │
│  1. Load current store_mirror state (article,visibility,price,  │
│     amount, parentProductId) into memory                        │
│  2. For each row:                                               │
│     - desiredAmount = visibility ? row.amount : 0               │
│     - Compare visibility, price, amount with current state      │
│  3. Add productId + resolvedParentProductId enrichment          │
│  4. Return only changed rows                                    │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│      CsCartGateway.importProducts()                             │
│  For each row:                                                  │
│  - Resolve productId (pre-resolved from mirror or API fallback) │
│  - Build payload: {product_code, status, amount, price}        │
│  - PUT /api/products/{productId} with real amount value        │
│  - Track imported/failed/skipped with progress                 │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
                    ┌─────────────────┐
                    │  CS-Cart Store  │
                    │  (REST API)     │
                    └─────────────────┘
```

## Data Flow: Article + Size Concatenation

**Where it happens:** `ExportPreviewDb.buildNeutralPreview()` (lines 68-69)

```javascript
const sizeValue = String(row.size || '').trim();
const fullArticle = sizeValue ? `${row.article}-${sizeValue}` : row.article;
```

**Rationale:**
- `products_final` schema: separate columns `article` (e.g., "GY6433") and `size` (e.g., "37.5")
- `store_mirror` (synced from CS-Cart): `article` column contains full code (e.g., "GY6433-37.5")
- **Bug fixed:** Previously only `article` was passed → no match in store_mirror → productId=null → gateway skipped product
- **Solution:** Reconstruct full article before passing to delta/gateway logic
- **Edge case:** Products where size is already in article (e.g., article="NK1234-37", size=null) → kept as-is

## Data Flow: Quantity Chain

**Problem (before 2026-04-07):** `amount` field didn't exist in data structures. `filterCsCartDelta` hardcoded `desiredAmount = visibility ? 1 : 0`. Real quantity from `products_final.quantity` was ignored → all products in CS-Cart got amount=1 regardless of stock.

**Solution implemented:**

| Layer | Type | Field | Source |
|-------|------|-------|--------|
| products_final | DB | `quantity` | Actual stock level from finalize |
| ExportPreviewRow | DTO | `quantity: number` | Extract from products_final row |
| CsCartImportRow | DTO | `amount: number` | `row.quantity` (line 56 in CsCartConnector.ts) |
| CsCartDeltaInputRow | DTO | `amount: number` | Input for delta comparison |
| filterCsCartDelta | Logic | desiredAmount | `visibility ? Math.max(0, row.amount) : 0` (line 280) |
| CsCartImportRow (output) | DTO | `amount: number` | Enriched with productId, amount preserved |
| Gateway payload | JSON | `amount` | `desiredAmount = visibility ? normalizeAmount(row.amount) : 0` (line 371) |
| CS-Cart API | PUT | `amount` | Real stock quantity sent to store |

**Key invariant:** Hidden products always get amount=0, regardless of stored quantity.

## Delta Filter Logic

**File:** `StoreMirrorService.filterCsCartDelta()` (lines 173-329)

**Three-level comparison:**

```javascript
const desiredVisibility = row.visibility === true;
const desiredPrice = Number(row.price || 0) || 0;
const desiredAmount = desiredVisibility ? Math.max(0, Math.trunc(Number(row.amount) || 0)) : 0;

const visibilitySame = current.visibility === desiredVisibility;
const priceSame = Math.abs(current.price - desiredPrice) <= 0.01;
const amountSame = current.amount === desiredAmount;  // NEW: compares real quantity
```

**Changed rows:** Only rows where at least one attribute differs from store_mirror state.

**Enrichment:** For each changed row, add:
- `productId` — resolved from store_mirror (or undefined if missing)
- `resolvedParentProductId` — parent code looked up in store_mirror state

## Deactivation Logic (appendCsCartMissingAsHidden)

**File:** `createApplication.ts` (lines 196-222)

**Activation condition:**

```javascript
if (disableMissingOnFullImport && !supplierFilter && !skipDeactivationWithoutCreate) {
  // Run appendCsCartMissingAsHidden
}
```

**Skip condition (protection against false positives):**

```javascript
const skipDeactivationWithoutCreate =
  featureScopeEnabled &&
  matchedMissingInMirrorInput > 0 &&              // Some SKU not in mirror
  matchedMissingInMirrorInput < matchedManagedInput &&  // NEW (2026-04-07): but fewer than managed
  matchedManagedInput > 0 &&
  !allowCreateInStore;
```

**Root cause of previous bug:**
- Project has 106K+ supplier SKU that never existed in CS-Cart (nonce, unrelated)
- `matchedMissingInMirrorInput > 0` was always true → `skipDeactivationWithoutCreate` was always true
- Mechanism never ran → products disappearing from supplier were never hidden in CS-Cart
- **Fix:** Added proportional check `< matchedManagedInput` to distinguish:
  - Scenario A: 1.7K managed, 106K missing → missing > managed → deactivation RUNS (unrelated SKU)
  - Scenario B: 2K managed, 100 missing → missing < managed → deactivation SKIPPED (rename scenario, protect new variants)

**What it does:**
- Scans `store_mirror` for all articles with feature `564=Y` (API-managed)
- For each article in mirror that is NOT in current `products_final` preview
- Adds row with `visibility=false` (status=H in CS-Cart)
- These rows go through delta filter and may be sent if changed

## Feature Scope Filter (filterCsCartRowsByFeature)

**File:** `StoreMirrorService.filterCsCartRowsByFeature()` (lines 331+)

**Purpose:** Only import SKU marked with feature "Оновлення товару API" = "Y" (feature_id=564)

**Implementation:** Two-phase SQL queries:
1. Get all managed SKU (feature 564=Y) from store_mirror → build Set<string>
2. For each input row, check if article in managedCodes

**Output summary:** `matchedManagedInput`, `matchedMissingInMirrorInput`, `droppedInput`

## Gateway Import (CsCartGateway.importProducts)

**File:** `CsCartGateway.ts` (lines 265-486)

**Two paths:**

### Path A: Normal (fresh mirror)
- Mirror age < maxMirrorAgeMinutes
- All rows have `productId` pre-resolved by filterCsCartDelta
- No API call to fetch index
- For each row: PUT `/api/products/{productId}`

### Path B: Fallback (stale/empty mirror)
- Mirror age > threshold OR mirror empty
- Fetch full index from CS-Cart API (`fetchProductIndexByCode`)
- Second-level delta check against API state
- For each row: lookup productId, compare state, POST/PUT as needed

**Amount handling (line 371):**

```javascript
const desiredAmount = row.visibility ? this.normalizeAmount(row.amount) : 0;
```

- Visibility=true → use actual amount from `products_final.quantity`
- Visibility=false → always 0 (hidden products have no stock)

**Payload construction (lines 406-414):**

```javascript
const payload = {
  product_code: productCode,
  status: desiredStatus,
  amount: desiredAmount,
  price: desiredPrice
};
if (parentProductId !== null) {
  payload.parent_product_id = parentProductId;  // Only when explicit value
}
```

**Key invariant:** Never send `parent_product_id: 0` for variant products (breaks CS-Cart)

## Database: store_mirror.amount

**Migration:** 031_add_amount_to_store_mirror.sql

**Purpose:** Denormalize `amount` from CS-Cart so delta filter can:
- Compare current stock level without second API call
- Detect quantity changes for re-export

**Synced by:** `StoreMirrorService.toPersistRow()` (lines 115-136)
- Extracts from `raw.amount` (JSONB from CS-Cart API response)
- Normalizes with `normalizeAmount()` (convert to int, handle nulls)
- Stored in `store_mirror.amount INTEGER NOT NULL DEFAULT 0`

## Related Codemaps

- [Backend Services](/docs/CODEMAPS_BACKEND_SERVICES.md) — Finalize, ImporDB overview
- [Database Schema](/docs/CODEMAPS_DATABASE_SCHEMA.md) — Full schema with partitions
- [Job Queue & Scheduler](/docs/CODEMAPS_JOBS_SCHEDULER.md) — Async orchestration

## Verification Checklist

- [ ] Full article code (article+size) matches store_mirror
- [ ] Quantity from products_final flows to CS-Cart amount field
- [ ] Visibility=true → amount > 0; Visibility=false → amount=0
- [ ] Delta filter detects quantity changes
- [ ] Deactivation respects proportional check
- [ ] Feature scope (564=Y) applied correctly
- [ ] Fallback path handles stale mirror gracefully
- [ ] No parent_product_id: 0 ever sent
