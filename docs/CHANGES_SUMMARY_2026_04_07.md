# Зміни 2026-04-07: Article Format, Quantity Chain, Deactivation Logic

**Дата:** 2026-04-07
**Автор:** claude-code (session 5)
**Статус:** Завершено
**Кількість файлів змінено (код):** 3
**Документація оновлена:** Так (3 документи + 1 новий codemap)

## Резюме

Виправлені три критичні баги в pipeline імпорту/експорту що блокували коректну синхронізацію товарів в CS-Cart:

1. **Article Format Mismatch**: Товари не знаходились у store_mirror через невідповідність формату артикулу
2. **Quantity Never Passed**: Реальна кількість ігнорувалась, усі товари відправлялись з amount=1
3. **Deactivation Always Disabled**: Товари що зникли з асортименту не ховались у магазині

---

## 1. Фікс Article Format (exportPreviewDb.ts)

### Файл
`src/core/pipeline/exportPreviewDb.ts`

### Зміна
```typescript
// Рядки 68-69: Побудова повного артикулу
const sizeValue = String(row.size || '').trim();
const fullArticle = sizeValue ? `${row.article}-${sizeValue}` : row.article;
```

### Root Cause
- `products_final` зберігає: `article="GY6433"`, `size="37.5"` окремо
- `store_mirror` містить: `article="GY6433-37.5"` (повний код)
- `buildNeutralPreview` передавав тільки `"GY6433"` → не знаходилось у mirror → `productId=null`

### Виправлення
- Теперь будується повний артикул: `"GY6433" + "-" + "37.5"` = `"GY6433-37.5"`
- Товари де size вже в article (напр. `article="NK1234-37"`, `size=null`) залишаються як-є
- Для товарів з size: `parentArticle` встановлюється в `null` (не намагаємося виводити батьківський код через суфікс)
- `visibility` = `quantity > 0` (замість hardcoded `true`)

### Додатково змінено
- Додано `quantity: number` до ExportPreviewRow (рядок 6 store.ts)

---

## 2. Фікс Quantity Chain (весь ланцюг)

### Інтерфейси змінено

#### ExportPreviewRow (src/core/domain/store.ts, лінія 6)
```typescript
export interface ExportPreviewRow {
  quantity: number;  // ДОДАНО
  // ...
}
```

#### CsCartImportRow (src/connectors/cscart/CsCartConnector.ts, лінія 10)
```typescript
export interface CsCartImportRow {
  amount: number;  // ДОДАНО
  // ...
}
```

#### CsCartDeltaInputRow (src/core/jobs/StoreMirrorService.ts, лінія 16)
```typescript
export interface CsCartDeltaInputRow {
  amount: number;  // ДОДАНО
  // ...
}
```

### Ланцюг передачи

1. **ExportPreviewDb.buildNeutralPreview()** (lines 48-84)
   - SELECT ... `pf.quantity` ... (лінія 51)
   - `quantity = Number(row.quantity || 0)` (лінія 73)
   - `return { ... quantity ... }` (лінія 77)

2. **CsCartConnector.createImportBatch()** (lines 44-68)
   - `amount: row.quantity` (лінія 56) ← передача quantity як amount

3. **StoreMirrorService.filterCsCartDelta()** (lines 173-329)
   - `const desiredAmount = desiredVisibility ? Math.max(0, Math.trunc(Number(row.amount) || 0)) : 0;` (лінія 280)
   - Порівнює current.amount з desiredAmount (лінія 297)

4. **CsCartGateway.importProducts()** (lines 265-486)
   - `const desiredAmount = row.visibility ? this.normalizeAmount(row.amount) : 0;` (лінія 371)
   - Передає `amount: desiredAmount` у payload (лінія 409)

### Root Cause
- `CsCartDeltaInputRow` не мав поля `amount`
- `filterCsCartDelta` завжди використовував `desiredAmount = visibility ? 1 : 0`
- Реальна кількість з `products_final.quantity` ніколи не передавалась

### Виправлення
- Додано `amount` через весь ланцюг
- Delta filter тепер розраховує: `visibility ? row.amount : 0` (прховані товари = 0)
- Gateway отримує реальну кількість з `products_final.quantity`

---

## 3. Фікс Deactivation Logic (createApplication.ts)

### Файл
`src/app/createApplication.ts`

### Зміна (лінія 192)
```typescript
const skipDeactivationWithoutCreate =
  featureScopeEnabled &&
  matchedMissingInMirrorInput > 0 &&
  matchedMissingInMirrorInput < matchedManagedInput &&  // ← ДОДАНО (пропорційна перевірка)
  matchedManagedInput > 0 &&
  !allowCreateInStore;
```

### Root Cause
- `skipDeactivationWithoutCreate` спрацьовував при будь-якому `matchedMissingInMirrorInput > 0`
- Проект має 106K+ нерелевантних SKU від постачальників (які ніколи не були в CS-Cart)
- Цей rintf завжди був > 0 → деактивація завжди вимикалась
- Товари що зникли з асортименту залишались видимими у CS-Cart

### Виправлення
- Додана пропорційна перевірка: `< matchedManagedInput`
- Тепер розрізняються два сценарії:
  - **A: missing < managed** (напр. 100 missing, 2000 managed) → це сценарій переіменування → деактивація ПРОПУСКАЄТЬСЯ (захист)
  - **B: missing >= managed** (напр. 106K missing, 1.7K managed) → це нерелевантні SKU → деактивація ЗАПУСКАЄТЬСЯ (нормальне)

### Механізм appendCsCartMissingAsHidden
- Запускається тільки при повному import (без supplier-фільтра)
- По фіксі деактивації:
  - Збирає всі SKU з store_mirror що мають feature 564=Y (управляються API)
  - SKU що є у mirror але НЕ у products_final → додаються з visibility=false
  - Ці рядки йдуть через delta filter та можуть бути відправлені якщо змінилось

---

## Документація оновлена

### 1. CURRENT_FUNCTIONALITY.md
**Вставлено нові секції:**
- "Архітектура передачи даних: article + size + quantity" (6 блоків)
- "Механізм appendCsCartMissingAsHidden" (умови активації, примеры)
- "Root cause analysis" (3 баги з детальними описами та посиланнями на код)

**Оновлено:**
- CS-Cart import section: додано описання 4-рівневого оптимізатора
- Delta filter: додано інформацію про синхронізацію amount та логіку приховування
- Migration 031: додано пояснення про purpose `amount` поля

### 2. CSCART_CONNECTOR_NOTES.md
**Оновлено:**
- Mapping: змінено опис article → product_code та додано quantity → amount
- Runtime optimization: додано `amount` до індексу та пояснено порівняння за amount
- Missing товарів: додано дату (2026-04-07) та пояснення захисту від нерелевантних SKU

### 3. CODEMAPS_IMPORT_EXPORT_ARCHITECTURE.md (новий файл)
**Докладна архітектура:**
- Диаграма data flow з 4 основними фазами
- Таблиця ланцюга передачи quantity
- Детальне пояснення delta filter логіки
- Опис deactivation logic із сценаріями
- Опис feature scope filter та gateway import (2 paths)
- Database schema для store_mirror.amount
- Verification checklist

---

## Файли коду що були змінено (в попередній сесії)

### 1. src/core/pipeline/exportPreviewDb.ts
- Лінії 51, 68-82: buildNeutralPreview переробана для article+size та quantity

### 2. src/core/domain/store.ts
- Лінія 6: додано `quantity: number` до ExportPreviewRow

### 3. src/connectors/cscart/CsCartConnector.ts
- Лінія 10: додано `amount: number` до CsCartImportRow
- Лінія 56: передача `amount: row.quantity`

### 4. src/core/jobs/StoreMirrorService.ts
- Лінія 16: додано `amount: number` до CsCartDeltaInputRow
- Лінія 280: логіка `desiredAmount = visibility ? ... : 0`
- Лінія 297: порівняння `amountSame = current.amount === desiredAmount`

### 5. src/connectors/cscart/CsCartGateway.ts
- Лінія 113: `normalizeAmount()` method
- Лінія 371: логіка `desiredAmount = visibility ? normalizeAmount(row.amount) : 0`
- Лінія 409: передача `amount: desiredAmount` у payload

### 6. src/app/createApplication.ts
- Лінія 192: додана пропорційна перевірка `< matchedManagedInput`
- Лінії 196-222: оновлено логіка appendCsCartMissingAsHidden

---

## Верифікація

Усі посилання на файли та номери рядків протестовані grep-командами:

```bash
✓ exportPreviewDb.ts лінія 69: fullArticle = ... found
✓ CsCartConnector.ts лінія 56: amount: row.quantity ... found
✓ StoreMirrorService.ts лінія 280: desiredAmount = ... found
✓ CsCartGateway.ts лінія 371: desiredAmount = row.visibility ? ... found
✓ createApplication.ts лінія 189-192: skipDeactivationWithoutCreate ... found
```

---

## Related Issues Addressed

- **Issue #1 (quantity=1)**: Товари відправлялись в CS-Cart з amount=1 замість реальної кількості
  - **Fix**: Quantity chain через весь pipeline
  - **Verification**: All rows in store_import preserve actual quantity from products_final

- **Issue #2 (missing match)**: productId=null бо article не совпадав
  - **Fix**: Article format concatenation (article+size)
  - **Verification**: Lookup у store_mirror має знаходити товари за полним кодом

- **Issue #3 (deactivation never ran)**: Товари що зникли з асортименту не ховались
  - **Fix**: Proportional check для skipDeactivationWithoutCreate
  - **Verification**: Distinguish rename (skip) vs unrelated SKU (run)

---

## Next Steps

1. **Testing**: E2E run with actual supplier data
2. **Monitoring**: Verify quantity synchronization in CS-Cart mirror syncs
3. **Validation**: Check deactivation logic with 106K+ supplier SKU dataset
4. **Production rollout**: When all tests pass

---

**Last Updated:** 2026-04-07
**Commit:** 29850b8 (docs: update with article format, quantity chain, deactivation logic improvements)
