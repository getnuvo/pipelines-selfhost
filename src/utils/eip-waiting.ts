import * as pulumi from '@pulumi/pulumi';
import {
  EC2Client,
  DescribeNetworkInterfacesCommand,
} from '@aws-sdk/client-ec2';
import e = require('cors');

class LambdaEniWaitProvider implements pulumi.dynamic.ResourceProvider {
  async create(inputs: any): Promise<pulumi.dynamic.CreateResult> {
    const {
      securityGroupId,
      subnetIds,
      region = process.env.AWS_REGION ||
        process.env.AWS_DEFAULT_REGION ||
        'eu-central-1',
    } = inputs;
    const timeoutSeconds = 300;
    const pollSeconds = 5;
    const expected = subnetIds.length;

    const client = new EC2Client({ region });
    const expiredAt = Date.now() + timeoutSeconds * 1000;
    const sleep = (ms: number) =>
      new Promise((resolve) => setTimeout(resolve, ms));

    console.log(
      `Waiting for ${expected} Lambda ENIs (one per subnet) (SG=${securityGroupId})...`,
    );

    while (true) {
      const resp = await client.send(
        new DescribeNetworkInterfacesCommand({
          Filters: [
            { Name: 'group-id', Values: [securityGroupId] },
            { Name: 'interface-type', Values: ['lambda'] },
            { Name: 'subnet-id', Values: subnetIds },
          ],
        }),
      );

      const enis = resp.NetworkInterfaces || [];
      const objEnis = new Map<string, string>();

      for (const ni of enis) {
        if (ni.SubnetId && ni.NetworkInterfaceId) {
          if (!objEnis.has(ni.SubnetId)) {
            objEnis.set(ni.SubnetId, ni.NetworkInterfaceId);
          }
        }
      }

      console.log(
        `Found ${enis.length} ENIs, ${objEnis.size} unique subnets: ${[...objEnis.entries()].map(([s, id]) => `${s}:${id}`).join(', ')}`,
      );
      if (objEnis.size >= expected) {
        console.log(
          `All ENIs ready. Subnet coverage: ${[...objEnis.entries()]
            .map(([s, id]) => `${s}:${id}`)
            .join(', ')}`,
        );
        return {
          id: [...objEnis.values()].join(','),
          outs: {
            eniIds: [...objEnis.values()],
          },
        };
      }

      if (Date.now() > expiredAt) {
        console.error(
          `Timeout waiting for Lambda ENIs. Found ${objEnis.size}/${expected}. Current: ${[
            ...objEnis.entries(),
          ]
            .map(([s, id]) => `${s}:${id}`)
            .join(', ')}`,
        );
        throw new Error(
          `Timeout waiting for Lambda ENIs. Found ${objEnis.size}/${expected}. Current: ${[
            ...objEnis.entries(),
          ]
            .map(([s, id]) => `${s}:${id}`)
            .join(', ')}`,
        );
      }

      console.log(
        `ENIs ready: ${objEnis.size}/${expected}. Retrying in ${pollSeconds}s...`,
      );
      await sleep(pollSeconds * 1000);
    }
  }
}

export class LambdaEniWait extends pulumi.dynamic.Resource {
  public readonly eniIds: pulumi.Output<string[]>;

  constructor(name: string, args: any, opts?: pulumi.CustomResourceOptions) {
    const provider = new LambdaEniWaitProvider();
    super(provider, name, args, opts);

    this.eniIds = pulumi
      .output(this.id)
      .apply((id) => id.split(',').map((str) => str.trim()));
  }
}
