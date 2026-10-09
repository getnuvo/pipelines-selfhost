import * as pulumi from '@pulumi/pulumi';
import { default as axios } from 'axios';

const config = new pulumi.Config();
const codePipelineVersion = config.get('version') || '1.0.0';
const configuredProvider = config.require('provider')?.toUpperCase() || 'AWS';
// azure-docker uses the Azure self-host license payload; the API only accepts AWS | AZURE.
const provider =
  configuredProvider === 'AZURE-DOCKER' ? 'AZURE' : configuredProvider;
const selfHostDeploymentUrl =
  config.get('selfHostDeploymentUrl') ||
  'https://api-gateway.ingestro.com/dp/api/v1/auth/self-host-deployment';

export const fetchFunctionList = async () => {
  const url = selfHostDeploymentUrl;
  const body = {
    version: codePipelineVersion,
    provider: provider,
    license_key: config.require('INGESTRO_LICENSE_KEY'),
  };

  try {
    const response = await axios.post(url, body);
    return response.data as {
      functions: { name: string; url: string }[];
      docker_key: string;
    };
  } catch (error) {
    const isAxios = axios.isAxiosError(error);
    const details = isAxios
      ? {
          url,
          status: error.response?.status,
          data: error.response?.data,
        }
      : { url, error };
    console.error('Error fetching self-host deployment payload:', details);
    throw error;
  }
};
