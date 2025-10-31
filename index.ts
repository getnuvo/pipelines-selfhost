import * as pulumi from '@pulumi/pulumi';
import * as awsMod from './src/aws';
import * as azureMod from './src/azure';

const config = new pulumi.Config();
const provider = config.require('provider');

if (provider === 'aws') {
  awsMod.run();
} else if (provider === 'azure') {
  azureMod.run();
} else {
  throw new Error(`Unknown provider: ${provider}`);
}
