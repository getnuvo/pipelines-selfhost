import { WizardError } from './ui';

// MongoDB Atlas Administration API v2 with a service account (OAuth 2.0 client credentials).
const BASE = 'https://cloud.mongodb.com';
const ACCEPT = 'application/vnd.atlas.2023-01-01+json';

export interface AtlasCredentials {
  clientId: string;
  clientSecret: string;
}

/** Atlas names the endpoint service's resource group rg_<projectId>_<suffix>. */
export const projectIdFromPls = (privateLinkServiceId: string) =>
  /\/resourceGroups\/rg_([0-9a-f]{24})_/i.exec(privateLinkServiceId)?.[1];

const token = async ({ clientId, clientSecret }: AtlasCredentials) => {
  const response = await fetch(`${BASE}/api/oauth/token`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok)
    throw new WizardError(
      `Atlas rejected the service account (HTTP ${response.status}). Check the client ID and secret.`,
    );

  return ((await response.json()) as { access_token: string }).access_token;
};

export const atlasClient = async (credentials: AtlasCredentials) => {
  const bearer = await token(credentials);
  const call = async (method: string, path: string) => {
    const response = await fetch(`${BASE}/api/atlas/v2${path}`, {
      method,
      headers: { authorization: `Bearer ${bearer}`, accept: ACCEPT },
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.text();
    if (!response.ok && response.status !== 404)
      throw new WizardError(
        `Atlas API ${method} ${path} failed (HTTP ${response.status}): ${body.slice(0, 300)}`,
      );

    return {
      status: response.status,
      json: body ? (JSON.parse(body) as unknown) : undefined,
    };
  };

  return { call };
};

interface EndpointService {
  id: string;
  privateLinkServiceResourceId?: string;
  privateEndpoints?: string[];
}

/**
 * Remove the stack's Azure Private Endpoint from the Atlas endpoint service it was registered
 * with. The endpoint service stays (it can serve the next deployment).
 */
export const removeAtlasEndpoint = async (
  credentials: AtlasCredentials,
  privateLinkServiceId: string,
  privateEndpointId: string,
) => {
  const projectId = projectIdFromPls(privateLinkServiceId);
  if (!projectId)
    throw new WizardError(
      `Cannot read the Atlas project from ${privateLinkServiceId}. Remove the endpoint in the Atlas UI.`,
    );
  const atlas = await atlasClient(credentials);
  const services = (
    await atlas.call(
      'GET',
      `/groups/${projectId}/privateEndpoint/AZURE/endpointService`,
    )
  ).json as EndpointService[] | undefined;
  const service = services?.find(
    (item) =>
      item.privateLinkServiceResourceId?.toLowerCase() ===
      privateLinkServiceId.toLowerCase(),
  );
  if (!service)
    throw new WizardError(
      `No Azure endpoint service with this Private Link Service in Atlas project ${projectId}.`,
    );

  const path = `/groups/${projectId}/privateEndpoint/AZURE/endpointService/${service.id}/endpoint/${encodeURIComponent(privateEndpointId)}`;
  const { status } = await atlas.call('DELETE', path);

  return status === 404 ? 'already removed' : 'removed';
};
