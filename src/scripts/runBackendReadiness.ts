import { createApplication } from '../app/createApplication';

function readPositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.trunc(parsed);
}

async function main() {
  const application = createApplication(process.env);
  try {
    const store = String(process.env.BACKEND_READINESS_STORE || application.connector.store)
      .trim()
      .toLowerCase() || 'cscart';
    const maxMirrorAgeMinutes = readPositiveInt(
      process.env.BACKEND_READINESS_MAX_MIRROR_AGE_MINUTES,
      120
    );

    const result = await application.catalogAdminService.getBackendReadiness({
      store,
      maxMirrorAgeMinutes
    });

    // eslint-disable-next-line no-console
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await application.close();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
