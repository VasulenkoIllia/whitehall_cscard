# Architecture baseline after docs review

## Що закладено в `whitehall_cscard`
- `src/core/config` — централізоване читання та валідація env (`ACTIVE_STORE`, Horoshop / CS-Cart параметри, finalize flags).
- `src/core/domain` — нейтральні DTO для preview/import/mirror, без прив’язки до конкретного магазину.
- `src/core/pipeline` — orchestration-шар для кроків `import -> finalize -> export -> store import`, який працює через ін’єкцію портів.
- `src/connectors/horoshop` — окремий адаптер Horoshop з мапінгом нейтрального preview в Horoshop payload.
- `src/connectors/cscart` — окремий адаптер CS-Cart з власним payload-контрактом.
- `src/app` — composition root, де вибирається активний конектор і фіксуються точки переносу з legacy.

## Що це змінює відносно legacy
- Старий зв’язок `runners.js -> exportService.js -> horoshopService.js` розбитий на pipeline + connector.
- Нейтральний preview більше не мусить знати про Horoshop-поля `presence_ua` або `display_in_showcase`.
- Перемикання магазину відбувається через `ACTIVE_STORE`, а не через жорсткі імпорти сервісів.

## Наступний порядок переносу
1. Перенести імпорт джерел із `/Users/monstermac/WebstormProjects/whitehall.store_integration/src/services/importService.js` у `src/core/pipeline`.
2. Перенести finalize з `/Users/monstermac/WebstormProjects/whitehall.store_integration/src/services/finalizeService.js`, одразу прибравши жорсткий `DELETE` за флагом.
3. Винести з `/Users/monstermac/WebstormProjects/whitehall.store_integration/src/services/exportService.js` нейтральний preview builder і залишити store-specific mapping лише в конекторах.
4. Перенести Horoshop gateway із `/Users/monstermac/WebstormProjects/whitehall.store_integration/src/services/horoshopService.js` у `src/connectors/horoshop`.
