import * as pulumi from '@pulumi/pulumi';
import { default as axios } from 'axios';

const config = new pulumi.Config();
const codePipelineVersion = config.get('version') || '1.0.0';
const provider = config.require('provider')?.toUpperCase() || 'AWS';

export const fetchFunctionList = async () => {
  const url = `https://api-gateway-develop.ingestro.com/dp/api/v1/auth/self-host-deployment`;
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
    console.error('Error fetching function list:', error.response.data);
    throw error;
  }
};
