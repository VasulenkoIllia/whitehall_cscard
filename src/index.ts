import { createApplication } from './app/createApplication';
import { createHttpServer } from './app/http/server';

async function main(): Promise<void> {
  const application = createApplication(process.env);
  const server = createHttpServer(application);
  server.listen(application.config.base.port, () => {
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          port: application.config.base.port,
          activeStore: application.config.base.activeStore,
          connector: application.connector.store,
          auth: application.config.auth.strategy,
          migrationTargets: application.migrationTargets
        },
        null,
        2
      )
    );
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
