import { createApplication } from './app/createApplication';

function main(): void {
  try {
    const application = createApplication(process.env);
    const summary = {
      port: application.config.base.port,
      activeStore: application.config.base.activeStore,
      connector: application.connector.store,
      modules: [
        'src/core/config',
        'src/core/domain',
        'src/core/pipeline',
        `src/connectors/${application.connector.store}`,
        'src/app'
      ],
      migrationTargets: application.migrationTargets
    };

    console.log(JSON.stringify(summary, null, 2));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown bootstrap error';
    console.error(message);
    throw error;
  }
}

main();
