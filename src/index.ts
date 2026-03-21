import { createApplication } from './app/createApplication';
import { createHttpServer } from './app/http/server';

async function main(): Promise<void> {
  const application = createApplication(process.env);
  const app = createHttpServer(application);
  let server: ReturnType<typeof app.listen> | null = null;

  const shutdown = (signal: NodeJS.Signals): void => {
    application.scheduler.stop();
    if (server) {
      server.close(() => {
        // eslint-disable-next-line no-console
        console.log(JSON.stringify({ signal, shutdown: 'ok' }));
        process.exit(0);
      });
    } else {
      process.exit(0);
    }
    setTimeout(() => {
      process.exit(0);
    }, 5000).unref();
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  server = app.listen(application.config.base.port, () => {
    void (async () => {
      await application.schedulerSettingsService.initialize();
      application.scheduler.start();
      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify(
          {
            port: application.config.base.port,
            activeStore: application.config.base.activeStore,
            connector: application.connector.store,
            auth: application.config.auth.strategy,
            scheduler: {
              enabled: application.config.scheduler.enabled,
              tickSeconds: application.config.scheduler.tickSeconds
            },
            migrationTargets: application.migrationTargets
          },
          null,
          2
        )
      );
    })().catch((err) => {
      // eslint-disable-next-line no-console
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
