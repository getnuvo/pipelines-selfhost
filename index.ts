import * as pulumi from '@pulumi/pulumi';

const config = new pulumi.Config();
const provider = config.require('provider');

async function main() {
  if (provider === 'aws') {
    const awsMod = await import('./src/aws');
    await awsMod.run();
    return;
  }
  if (provider === 'azure') {
    const azureMod = await import('./src/azure');
    azureMod.run();
    return;
  }
  throw new Error(`Unknown provider: ${provider}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
