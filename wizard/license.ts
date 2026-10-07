import { LIVE_SELF_HOST_URL } from './questions';

/**
 * Same call `pulumi up` makes (src/utils/ingestro.ts), done up front so a wrong key or
 * environment fails here instead of halfway through the deployment.
 */
export const checkLicense = async (
  licenseKey: string,
  version: string,
  url = LIVE_SELF_HOST_URL,
): Promise<string | undefined> => {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version,
        provider: 'AZURE',
        license_key: licenseKey,
      }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    return `Could not reach ${new URL(url).host} (${(err as Error).message}). The deployer machine needs outbound HTTPS to it.`;
  }
  if (response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      docker_key?: string;
    };

    return body.docker_key
      ? undefined
      : 'The license was accepted but no registry key came back. Contact Ingestro support.';
  }
  const detail = await response.text().catch(() => '');

  return `The license key was rejected for this environment (HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}).`;
};
