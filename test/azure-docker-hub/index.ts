// Test-only hub for `provider: azure-docker`. NOT for customers: it stands in for the
// customer's Azure Firewall / App Gateway / DNS with cheap pieces.
//
//   hub VNet 10.29.0.0/16
//     snet-nva    10.29.0.0/24  NVA VM 10.29.0.4: IP forwarding + NAT for the spoke (= firewallPrivateIp)
//     snet-appgw  10.29.1.0/24  reserved for an App Gateway later
//     snet-admin  10.29.2.0/24  jump VM 10.29.2.4 (public IP, SSH from adminIp only) + test Mongo :27017
//   Private DNS zones: the six privatelink.* zones the spoke needs (linked to the hub)
//   Peering hub <-> spoke once `spokeVnetId` is set (both sides, forwarded traffic allowed)
//
// ./deploy.sh deploys it when you pick "Create a test hub for me"; the wizard relies on the
// fixed names and addresses above (wizard/hub.ts TEST_HUB).

import * as pulumi from '@pulumi/pulumi';
import * as compute from '@pulumi/azure-native/compute';
import * as network from '@pulumi/azure-native/network';
import * as privatedns from '@pulumi/azure-native/privatedns';
import * as resources from '@pulumi/azure-native/resources';

const config = new pulumi.Config();
const location = config.get('location') || 'germanywestcentral';
const adminIp = config.require('adminIp'); // your public IP, for SSH to the jump VM
const sshPublicKey = config.require('sshPublicKey');
const spokeAddressSpace = config.get('spokeAddressSpace') || '10.30.0.0/16';
const spokeVnetId = config.get('spokeVnetId'); // set after the spoke VNet exists
const adminUsername = 'ingestro';

const rg = new resources.ResourceGroup('hub-rg', {
  resourceGroupName: 'ingestro-test-hub-rg',
  location,
});

const vnet = new network.VirtualNetwork('hub-vnet', {
  resourceGroupName: rg.name,
  virtualNetworkName: 'ingestro-test-hub-vnet',
  location,
  addressSpace: { addressPrefixes: ['10.29.0.0/16'] },
});

const nsg = (
  name: string,
  rules: network.NetworkSecurityGroupArgs['securityRules'],
) =>
  new network.NetworkSecurityGroup(name, {
    resourceGroupName: rg.name,
    location,
    securityRules: rules,
  });

const allowSshFromAdmin = {
  name: 'allow-ssh-admin',
  priority: 100,
  direction: 'Inbound',
  access: 'Allow',
  protocol: 'Tcp',
  sourceAddressPrefix: `${adminIp}/32`,
  sourcePortRange: '*',
  destinationAddressPrefix: '*',
  destinationPortRange: '22',
};

const nvaSubnet = new network.Subnet('snet-nva', {
  resourceGroupName: rg.name,
  virtualNetworkName: vnet.name,
  subnetName: 'snet-nva',
  addressPrefix: '10.29.0.0/24',
  // Forwarded spoke traffic targets internet IPs, which AllowVnetInBound does not match.
  networkSecurityGroup: {
    id: nsg('nva-nsg', [
      {
        name: 'allow-spoke-forward',
        priority: 100,
        direction: 'Inbound',
        access: 'Allow',
        protocol: '*',
        sourceAddressPrefix: spokeAddressSpace,
        sourcePortRange: '*',
        destinationAddressPrefix: '*',
        destinationPortRange: '*',
      },
    ]).id,
  },
});
const appgwSubnet = new network.Subnet(
  'snet-appgw',
  {
    resourceGroupName: rg.name,
    virtualNetworkName: vnet.name,
    subnetName: 'snet-appgw',
    addressPrefix: '10.29.1.0/24',
  },
  { dependsOn: [nvaSubnet] },
);
const adminSubnet = new network.Subnet(
  'snet-admin',
  {
    resourceGroupName: rg.name,
    virtualNetworkName: vnet.name,
    subnetName: 'snet-admin',
    addressPrefix: '10.29.2.0/24',
    networkSecurityGroup: { id: nsg('admin-nsg', [allowSshFromAdmin]).id },
  },
  { dependsOn: [appgwSubnet] },
);

const linuxVm = (
  name: string,
  subnet: network.Subnet,
  privateIp: string,
  size: string,
  cloudInit: string,
  ipForwarding: boolean,
) => {
  const pip = new network.PublicIPAddress(`${name}-pip`, {
    resourceGroupName: rg.name,
    location,
    sku: { name: 'Standard' },
    publicIPAllocationMethod: 'Static',
  });
  const nic = new network.NetworkInterface(`${name}-nic`, {
    resourceGroupName: rg.name,
    location,
    enableIPForwarding: ipForwarding,
    ipConfigurations: [
      {
        name: 'ipconfig',
        subnet: { id: subnet.id },
        privateIPAllocationMethod: 'Static',
        privateIPAddress: privateIp,
        publicIPAddress: { id: pip.id },
      },
    ],
  });
  new compute.VirtualMachine(
    name,
    {
      resourceGroupName: rg.name,
      location,
      hardwareProfile: { vmSize: size },
      networkProfile: { networkInterfaces: [{ id: nic.id, primary: true }] },
      osProfile: {
        computerName: name,
        adminUsername,
        customData: Buffer.from(cloudInit).toString('base64'),
        linuxConfiguration: {
          disablePasswordAuthentication: true,
          ssh: {
            publicKeys: [
              {
                path: `/home/${adminUsername}/.ssh/authorized_keys`,
                keyData: sshPublicKey,
              },
            ],
          },
        },
      },
      storageProfile: {
        imageReference: {
          publisher: 'Canonical',
          offer: 'ubuntu-24_04-lts',
          sku: 'server',
          version: 'latest',
        },
        osDisk: {
          createOption: 'FromImage',
          managedDisk: { storageAccountType: 'StandardSSD_LRS' },
          deleteOption: 'Delete',
        },
      },
    },
    // cloud-init runs only on first boot, and Azure rejects customData changes on an existing VM.
    { ignoreChanges: ['osProfile.customData'] },
  );

  return pip;
};

// NVA: forwards and NATs everything from the spoke to the internet (stands in for Azure Firewall).
const nvaPip = linuxVm(
  'ingestro-test-nva',
  nvaSubnet,
  '10.29.0.4',
  'Standard_B1s',
  `#cloud-config
write_files:
  - path: /etc/sysctl.d/90-forward.conf
    content: net.ipv4.ip_forward=1
  - path: /etc/systemd/system/spoke-nat.service
    content: |
      [Unit]
      After=network-online.target
      [Service]
      Type=oneshot
      RemainAfterExit=yes
      ExecStart=/bin/sh -c '/usr/sbin/iptables -t nat -C POSTROUTING -s ${spokeAddressSpace} -o eth0 -j MASQUERADE || /usr/sbin/iptables -t nat -A POSTROUTING -s ${spokeAddressSpace} -o eth0 -j MASQUERADE'
      [Install]
      WantedBy=multi-user.target
runcmd:
  - sysctl --system
  - systemctl daemon-reload
  - systemctl enable --now spoke-nat.service
`,
  true,
);

// Jump VM: SSH entry point (adminSourceCidr) + test MongoDB for the spoke.
const jumpPip = linuxVm(
  'ingestro-test-jump',
  adminSubnet,
  '10.29.2.4',
  'Standard_B2s',
  `#cloud-config
package_update: true
packages: [docker.io, jq]
runcmd:
  - systemctl enable --now docker
  - docker run -d --name mongo --restart unless-stopped -p 27017:27017 -v mongo-data:/data/db mongo:7
`,
  false,
);

const zoneNames: Record<string, string> = {
  blob: 'privatelink.blob.core.windows.net',
  vault: 'privatelink.vaultcore.azure.net',
  file: 'privatelink.file.core.windows.net',
  queue: 'privatelink.queue.core.windows.net',
  table: 'privatelink.table.core.windows.net',
  sites: 'privatelink.azurewebsites.net',
};
const zones = Object.values(zoneNames).map((zoneName) => {
  const zone = new privatedns.PrivateZone(zoneName, {
    resourceGroupName: rg.name,
    privateZoneName: zoneName,
    location: 'global',
  });
  new privatedns.VirtualNetworkLink(`${zoneName}-hub-link`, {
    resourceGroupName: rg.name,
    privateZoneName: zone.name,
    location: 'global',
    virtualNetwork: { id: vnet.id },
    registrationEnabled: false,
  });

  return zone;
});

if (spokeVnetId) {
  // /subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.Network/virtualNetworks/<name>
  const [, , , , spokeRg, , , , spokeVnetName] = spokeVnetId.split('/');
  new network.VirtualNetworkPeering('hub-to-spoke', {
    resourceGroupName: rg.name,
    virtualNetworkName: vnet.name,
    virtualNetworkPeeringName: 'hub-to-spoke',
    remoteVirtualNetwork: { id: spokeVnetId },
    allowVirtualNetworkAccess: true,
    allowForwardedTraffic: true,
  });
  new network.VirtualNetworkPeering('spoke-to-hub', {
    resourceGroupName: spokeRg,
    virtualNetworkName: spokeVnetName,
    virtualNetworkPeeringName: 'spoke-to-hub',
    remoteVirtualNetwork: { id: vnet.id },
    allowVirtualNetworkAccess: true,
    allowForwardedTraffic: true,
  });
}

export const firewallPrivateIp = '10.29.0.4';
export const adminSourceCidr = '10.29.2.0/24';
export const mongoConnectionString = 'mongodb://10.29.2.4:27017';
export const jumpPublicIp = jumpPip.ipAddress;
export const nvaPublicIp = nvaPip.ipAddress;
export const privateDnsZoneIds = Object.fromEntries(
  Object.keys(zoneNames).map((key, index) => [key, zones[index].id]),
);
export const hubVnetId = vnet.id;
