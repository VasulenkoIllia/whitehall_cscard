import { createApplication } from './app/createApplication';
import { createHttpServer } from './app/http/server';

async function main(): Promise<void> {
  const application = createApplication(process.env);

  // Wait for orphaned-job cleanup BEFORE we start accepting HTTP traffic. Otherwise
  // the first job-creation request after a deploy may see a stale 'running' row from
  // the previous process and reject with 409 JobConflictError. Cheap to await — only
  // a couple of UPDATE/DELETE statements.
  try {
    await application.startupCleanup;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      JSON.stringify({
        startup_cleanup: 'failed',
        error: err instanceof Error ? err.message : String(err)
      })
    );
    // Continue: scheduler will retry on next tick; HTTP can still serve read-only views.
  }

  const app = createHttpServer(application);
  let server: ReturnType<typeof app.listen> | null = null;
  let shuttingDown = false;

  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    const finalize = () => {
      void application
        .close()
        .then(() => {
          // eslint-disable-next-line no-console
          console.log(JSON.stringify({ signal, shutdown: 'ok' }));
          process.exit(0);
        })
        .catch((err) => {
          // eslint-disable-next-line no-console
          console.error(err instanceof Error ? err.message : err);
          process.exit(1);
        });
    };
    if (server) {
      server.close(finalize);
    } else {
      finalize();
    }
    setTimeout(() => {
      process.exit(0);
    }, 5000).unref();
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  server = app.listen(application.config.base.port, () => {
    // Long-running jobs (import-all with 100+ sources) can take 10-15 min.
    // Raise socket timeout so the HTTP connection stays alive for the response.
    if (server) {
      server.timeout = 30 * 60 * 1000;          // 30 min socket timeout
      server.keepAliveTimeout = 30 * 60 * 1000; // 30 min keep-alive
    }
    void (async () => {
      // startupCleanup already awaited above (before listen). Just initialize scheduler.
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
            }
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
