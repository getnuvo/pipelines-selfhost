import * as pulumi from '@pulumi/pulumi';

const config = new pulumi.Config();
const provider = config.require('provider');

// Pulumi stack outputs (available via `pulumi stack output ...`)
export let endpoint: pulumi.Output<string> | undefined;
export let mappingModuleUrl: pulumi.Output<string> | undefined;
export let configuredCustomDomain: pulumi.Output<string> | string | undefined;

async function main() {
  if (provider === 'aws') {
    const awsMod = await import('./src/aws');
    const outputs = await awsMod.run();
    endpoint = outputs.endpoint;
    return;
  }
  if (provider === 'azure') {
    const azureMod = await import('./src/azure');
    const outputs = azureMod.run();
    endpoint = outputs.endpoint;
    mappingModuleUrl = outputs.mappingModuleUrl;
    configuredCustomDomain = outputs.configuredCustomDomain;
    return;
  }
  throw new Error(`Unknown provider: ${provider}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
