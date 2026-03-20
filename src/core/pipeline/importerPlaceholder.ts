import type { ImportSummary, SourceImporter } from './contracts';

export class ImporterPlaceholder implements SourceImporter {
  async importAll(): Promise<ImportSummary> {
    throw new Error('Import pipeline not yet ported from legacy');
  }
}
