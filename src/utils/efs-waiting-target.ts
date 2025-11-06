import * as pulumi from '@pulumi/pulumi';
import { EFSClient, DescribeMountTargetsCommand } from '@aws-sdk/client-efs';

interface IWaitForEfsInputs {
  fileSystemId: pulumi.Input<string>;
  timeoutSeconds?: pulumi.Input<number>;
  stabilizationSeconds?: pulumi.Input<number>;
}

class WaitForEfsProvider implements pulumi.dynamic.ResourceProvider {
  async create(inputs: any): Promise<pulumi.dynamic.CreateResult> {
    const fileSystemId = inputs.fileSystemId;;
    const timeout = (inputs.timeoutSeconds || 300) * 1000;
    const stabilizationMs = ((inputs.stabilizationSeconds ?? 30) as number) * 1000;

    const config = new pulumi.Config('aws');
    const awsProfile = config.get('profile');
    const region = config.get('region');

    const client = new EFSClient({ region, profile: awsProfile });

    const start = Date.now();

    console.log(
      `🔍 Waiting for all EFS mount targets to become available for FS: ${fileSystemId}`,
    );

    while (true) {
      const resp = await client.send(
        new DescribeMountTargetsCommand({ FileSystemId: fileSystemId }),
      );
      const states = resp.MountTargets?.map(
        (mt) => `${mt.MountTargetId}: ${mt.LifeCycleState}`,
      );

      const allAvailable = resp.MountTargets?.every(
        (mt) => mt.LifeCycleState === 'available',
      );

      if (allAvailable) {
        console.log(`✅ All EFS mount targets are available. Adding ${stabilizationMs / 1000}s buffer...`);
        await new Promise((res) => setTimeout(res, stabilizationMs));
        console.log('✅ EFS mount targets fully ready for Lambda functions.');
        break;
      }

      if (Date.now() - start > timeout) {
        throw new Error(
          `⏱️ Timeout: Not all mount targets are available. States: ${states?.join(', ')}`,
        );
      }

      console.log(`⏳ Waiting... Current states: ${states?.join(', ')}`);
      await new Promise((res) => setTimeout(res, 10_000));
    }

    return {
      id: `wait-for-${fileSystemId}`,
      outs: inputs,
    };
  }
}

export class WaitForEfsTargets extends pulumi.dynamic.Resource {
  constructor(
    name: string,
    args: IWaitForEfsInputs,
    opts?: pulumi.CustomResourceOptions,
  ) {
    super(new WaitForEfsProvider(), name, args, opts);
  }
}
