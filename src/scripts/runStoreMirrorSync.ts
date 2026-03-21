import { createApplication } from '../app/createApplication';

async function main() {
  const application = createApplication(process.env);
  try {
    const startedAt = Date.now();
    const result = await application.jobRunner.runStoreMirrorSync();
    const durationMs = Math.max(0, Date.now() - startedAt);

    console.log(
      JSON.stringify(
        {
          ok: true,
          jobId: result.jobId,
          durationMs,
          result: result.result
        },
        null,
        2
      )
    );
  } finally {
    await application.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
