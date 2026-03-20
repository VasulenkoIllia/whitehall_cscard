import type { ImportSummary, SourceImportSummary, SourceImporter } from './contracts';

export class ImporterPlaceholder implements SourceImporter {
  async importAll(): Promise<ImportSummary> {
    throw new Error('Import pipeline not yet ported from legacy');
  }

  async importSource(): Promise<SourceImportSummary> {
    throw new Error('Import pipeline not yet ported from legacy');
  }

  async importSupplier(): Promise<SourceImportSummary> {
    throw new Error('Import pipeline not yet ported from legacy');
  }
}
