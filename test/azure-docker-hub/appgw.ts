// Optional App Gateway WAF v2 for the test hub, to measure WAF rule hits on Ingestro traffic.
// Mirrors the spec in docs/azure-docker/terraform-handoff.md section 9: HTTPS listener on a
// private frontend IP, /dp/* to the DP Function App, /blob/* (prefix stripped) to the Blob
// Private Endpoint, WAF policy in Detection mode, logs to a Log Analytics workspace.

import * as pulumi from '@pulumi/pulumi';
import * as monitor from '@pulumi/azure-native/monitor';
import * as network from '@pulumi/azure-native/network';
import * as operationalinsights from '@pulumi/azure-native/operationalinsights';

export const APP_GATEWAY_PRIVATE_IP = '10.29.1.10';
const NAME = 'ingestro-test-appgw';

// Measured false positives of Microsoft_DefaultRuleSet 2.1 on Ingestro traffic
// (docs/azure-docker/terraform-handoff.md section 9). `groups` maps a rule group to the
// rule IDs to skip for that argument; an empty list skips the whole group (free text).
const EXCLUSIONS: {
  variable: string;
  operator: string;
  selector: string;
  groups: Record<string, string[]>;
}[] = [
  {
    // The dashboard's page origin, sent by every component verify call.
    variable: 'RequestArgNames',
    operator: 'Equals',
    selector: 'meta.origin',
    groups: { RFI: ['931130'] },
  },
  {
    // Webhook target URL.
    variable: 'RequestArgNames',
    operator: 'Equals',
    selector: 'url',
    groups: { RFI: ['931130'] },
  },
  {
    // Connector source URLs (HTTP url, OAuth refresh_url, ...).
    variable: 'RequestArgNames',
    operator: 'StartsWith',
    selector: 'configuration.',
    groups: { RFI: ['931130'] },
  },
  {
    // Component verify calls carry `session_id` from a cross-origin dashboard.
    variable: 'RequestArgKeys',
    operator: 'Equals',
    selector: 'session_id',
    groups: { FIX: ['943110'] },
  },
  {
    // MongoDB-style list filters in the query string, e.g. `filters[$and][0][pipeline]`
    // (GET /execution); a block here also fails the CORS preflight.
    variable: 'RequestArgKeys',
    operator: 'StartsWith',
    selector: 'filters',
    groups: { SQLI: ['942290'] },
  },
  {
    // JSON-encoded `options` query parameter (GET /connector/:id/data).
    variable: 'RequestArgNames',
    operator: 'Equals',
    selector: 'options',
    groups: { SQLI: [] },
  },
  {
    // Target data model columns: descriptions, labels, validation regexes.
    variable: 'RequestArgNames',
    operator: 'StartsWith',
    selector: 'columns.',
    groups: { SQLI: [], XSS: [] },
  },
  {
    // Free-text labels of the embeddable components.
    variable: 'RequestArgNames',
    operator: 'StartsWith',
    selector: 'settings.i18n_overrides.',
    groups: { SQLI: [], XSS: [] },
  },
];

const exclusions = (ruleSetType: string, ruleSetVersion: string) =>
  EXCLUSIONS.map((entry) => ({
    matchVariable: entry.variable,
    selectorMatchOperator: entry.operator,
    selector: entry.selector,
    exclusionManagedRuleSets: [
      {
        ruleSetType,
        ruleSetVersion,
        ruleGroups: Object.entries(entry.groups).map(
          ([ruleGroupName, ids]) => ({
            ruleGroupName,
            rules: ids.map((ruleId) => ({ ruleId })),
          }),
        ),
      },
    ],
  }));

// Endpoints whose bodies are user data or code: spreadsheet rows (keyed by the file's own
// column names), transformation JavaScript / formulas and AI prompts. They trip RCE, SQLI,
// XSS and LFI rules under any field name, so these paths skip body inspection; URL, query
// and headers are still inspected, and every one of them requires an access token.
const DATA_PATHS = [
  '/dp/api/v1/transformation*',
  '/dp/api/v1/pipeline*',
  '/dp/api/v1/execution*',
  '/dp/api/v1/connector*',
];

export const appGateway = (args: {
  resourceGroupName: pulumi.Input<string>;
  resourceGroupId: pulumi.Input<string>;
  location: string;
  subnetId: pulumi.Input<string>;
  dpFqdn: string;
  blobFqdn?: string;
  certPfx: pulumi.Input<string>;
  certPassword: pulumi.Input<string>;
  wafMode: string;
  ruleSetType: string;
  ruleSetVersion: string;
}) => {
  const id = (kind: string, name: string) =>
    pulumi.interpolate`${args.resourceGroupId}/providers/Microsoft.Network/applicationGateways/${NAME}/${kind}/${name}`;

  const policySettings = {
    state: 'Enabled',
    mode: args.wafMode,
    requestBodyCheck: true,
    // Inspect as much as v2 allows (the API itself accepts 6 MB JSON/XML bodies).
    maxRequestBodySizeInKb: 2000,
    requestBodyInspectLimitInKB: 2000,
    fileUploadLimitInMb: 100,
  };
  const policy = new network.WebApplicationFirewallPolicy('appgw-waf', {
    resourceGroupName: args.resourceGroupName,
    location: args.location,
    policySettings,
    managedRules: {
      managedRuleSets: [
        { ruleSetType: args.ruleSetType, ruleSetVersion: args.ruleSetVersion },
      ],
      exclusions: exclusions(args.ruleSetType, args.ruleSetVersion),
    },
  });
  const dataPolicy = new network.WebApplicationFirewallPolicy(
    'appgw-waf-data',
    {
      resourceGroupName: args.resourceGroupName,
      location: args.location,
      // No body inspection, so no body size cap either: the API's own 6 MB limit applies.
      policySettings: {
        ...policySettings,
        requestBodyCheck: false,
        requestBodyEnforcement: false,
      },
      managedRules: {
        managedRuleSets: [
          {
            ruleSetType: args.ruleSetType,
            ruleSetVersion: args.ruleSetVersion,
          },
        ],
        exclusions: exclusions(args.ruleSetType, args.ruleSetVersion),
      },
    },
  );
  // /blob/* carries the uploaded file as-is (xlsx, csv, ...): 920420 rejects every
  // content type outside its JSON/XML/form list, so the path gets its own policy.
  const blobPolicy = args.blobFqdn
    ? new network.WebApplicationFirewallPolicy('appgw-waf-blob', {
        resourceGroupName: args.resourceGroupName,
        location: args.location,
        // Uploads are raw PUT bodies, not multipart: fileUploadLimitInMb does not apply and
        // the 2000 KB body cap would reject larger files. A file body is not inspectable anyway.
        policySettings: {
          ...policySettings,
          requestBodyCheck: false,
          requestBodyEnforcement: false,
        },
        managedRules: {
          managedRuleSets: [
            {
              ruleSetType: args.ruleSetType,
              ruleSetVersion: args.ruleSetVersion,
              ruleGroupOverrides: [
                {
                  ruleGroupName: 'PROTOCOL-ENFORCEMENT',
                  rules: [{ ruleId: '920420', state: 'Disabled' }],
                },
              ],
            },
          ],
        },
      })
    : undefined;

  const publicIp = new network.PublicIPAddress('appgw-pip', {
    resourceGroupName: args.resourceGroupName,
    location: args.location,
    sku: { name: 'Standard' },
    publicIPAllocationMethod: 'Static',
  });

  const pools = [
    { name: 'dp', backendAddresses: [{ fqdn: args.dpFqdn }] },
    ...(args.blobFqdn
      ? [{ name: 'blob', backendAddresses: [{ fqdn: args.blobFqdn }] }]
      : []),
  ];

  const gateway = new network.ApplicationGateway('appgw', {
    applicationGatewayName: NAME,
    resourceGroupName: args.resourceGroupName,
    location: args.location,
    sku: { name: 'WAF_v2', tier: 'WAF_v2', capacity: 1 },
    firewallPolicy: { id: policy.id },
    gatewayIPConfigurations: [
      { name: 'gateway', subnet: { id: args.subnetId } },
    ],
    frontendIPConfigurations: [
      { name: 'public', publicIPAddress: { id: publicIp.id } },
      {
        name: 'private',
        privateIPAllocationMethod: 'Static',
        privateIPAddress: APP_GATEWAY_PRIVATE_IP,
        subnet: { id: args.subnetId },
      },
    ],
    frontendPorts: [{ name: 'https', port: 443 }],
    sslCertificates: [
      { name: 'listener', data: args.certPfx, password: args.certPassword },
    ],
    // `none` has no targets: the path map's default, so unmatched paths such as the DP
    // internal /functions/* get a 502 instead of reaching DP.
    backendAddressPools: [...pools, { name: 'none' }],
    probes: [
      {
        name: 'dp',
        protocol: 'Https',
        path: '/dp/api/v1/management/health',
        interval: 30,
        timeout: 30,
        unhealthyThreshold: 3,
        pickHostNameFromBackendHttpSettings: true,
        match: { statusCodes: ['200'] },
      },
      ...(args.blobFqdn
        ? [
            {
              name: 'blob',
              protocol: 'Https',
              path: '/',
              interval: 30,
              timeout: 30,
              unhealthyThreshold: 3,
              pickHostNameFromBackendHttpSettings: true,
              // The account root answers 400 without a container: reachable is enough.
              match: { statusCodes: ['200-499'] },
            },
          ]
        : []),
    ],
    backendHttpSettingsCollection: pools.map((pool) => ({
      name: pool.name,
      port: 443,
      protocol: 'Https',
      pickHostNameFromBackendAddress: true,
      requestTimeout: 230,
      probe: { id: id('probes', pool.name) },
    })),
    httpListeners: [
      {
        name: 'https',
        protocol: 'Https',
        frontendIPConfiguration: {
          id: id('frontendIPConfigurations', 'private'),
        },
        frontendPort: { id: id('frontendPorts', 'https') },
        sslCertificate: { id: id('sslCertificates', 'listener') },
      },
    ],
    rewriteRuleSets: args.blobFqdn
      ? [
          {
            name: 'strip-blob',
            rewriteRules: [
              {
                name: 'strip-blob-prefix',
                ruleSequence: 100,
                conditions: [
                  {
                    variable: 'var_uri_path',
                    pattern: '^/blob(/.*)$',
                    ignoreCase: true,
                  },
                ],
                actionSet: {
                  // Put Blob rejects uploads without it (400 MissingRequiredHeader), and the
                  // dashboard's PUT to the proxied SAS URL arrives without it.
                  requestHeaderConfigurations: [
                    { headerName: 'x-ms-blob-type', headerValue: 'BlockBlob' },
                  ],
                  urlConfiguration: {
                    modifiedPath: '{var_uri_path_1}',
                    reroute: false,
                  },
                },
              },
            ],
          },
        ]
      : [],
    urlPathMaps: [
      {
        name: 'paths',
        defaultBackendAddressPool: { id: id('backendAddressPools', 'none') },
        defaultBackendHttpSettings: {
          id: id('backendHttpSettingsCollection', 'dp'),
        },
        pathRules: [
          {
            name: 'dp-data',
            paths: DATA_PATHS,
            backendAddressPool: { id: id('backendAddressPools', 'dp') },
            backendHttpSettings: {
              id: id('backendHttpSettingsCollection', 'dp'),
            },
            firewallPolicy: { id: dataPolicy.id },
          },
          {
            name: 'dp',
            paths: ['/dp/*'],
            backendAddressPool: { id: id('backendAddressPools', 'dp') },
            backendHttpSettings: {
              id: id('backendHttpSettingsCollection', 'dp'),
            },
          },
          ...(args.blobFqdn
            ? [
                {
                  name: 'blob',
                  paths: ['/blob/*'],
                  backendAddressPool: { id: id('backendAddressPools', 'blob') },
                  backendHttpSettings: {
                    id: id('backendHttpSettingsCollection', 'blob'),
                  },
                  rewriteRuleSet: { id: id('rewriteRuleSets', 'strip-blob') },
                  firewallPolicy: { id: blobPolicy!.id },
                },
              ]
            : []),
        ],
      },
    ],
    requestRoutingRules: [
      {
        name: 'paths',
        ruleType: 'PathBasedRouting',
        priority: 100,
        httpListener: { id: id('httpListeners', 'https') },
        urlPathMap: { id: id('urlPathMaps', 'paths') },
      },
    ],
  });

  const logs = new operationalinsights.Workspace('appgw-logs', {
    resourceGroupName: args.resourceGroupName,
    location: args.location,
    sku: { name: 'PerGB2018' },
    retentionInDays: 30,
  });
  new monitor.DiagnosticSetting('appgw-diagnostics', {
    resourceUri: gateway.id,
    name: 'waf-logs',
    workspaceId: logs.id,
    // Resource-specific tables: AGWFirewallLogs, AGWAccessLogs.
    logAnalyticsDestinationType: 'Dedicated',
    logs: [
      { category: 'ApplicationGatewayFirewallLog', enabled: true },
      { category: 'ApplicationGatewayAccessLog', enabled: true },
    ],
  });

  return { gateway, policy, logs };
};
