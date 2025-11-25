// Copyright 2016-2025, Pulumi Corporation.  All rights reserved.

import * as resources from '@pulumi/azure-native/resources';
import * as storage from '@pulumi/azure-native/storage';
import * as pulumi from '@pulumi/pulumi';

export function getConnectionString(
  resourceGroupName: pulumi.Input<string>,
  accountName: pulumi.Input<string>,
): pulumi.Output<string> {
  // Retrieve the primary storage account key.
  const storageAccountKeys = storage.listStorageAccountKeysOutput({
    resourceGroupName,
    accountName,
  });
  const primaryStorageKey = storageAccountKeys.keys[0].value;

  // Build the connection string to the storage account.
  return pulumi.interpolate`DefaultEndpointsProtocol=https;AccountName=${accountName};AccountKey=${primaryStorageKey};EndpointSuffix=core.windows.net`;
}

export function signedBlobReadUrl(
  blob: storage.Blob,
  container: storage.BlobContainer,
  account: storage.StorageAccount,
  resourceGroup: resources.ResourceGroup,
): pulumi.Output<string> {
  const blobSAS = storage.listStorageAccountServiceSASOutput({
    accountName: account.name,
    protocols: storage.HttpProtocol.Https,
    sharedAccessExpiryTime: '2030-01-01',
    sharedAccessStartTime: '2021-01-01',
    resourceGroupName: resourceGroup.name,
    // Use blob-level SAS to allow the Functions runtime to read the exact package blob.
    resource: storage.SignedResource.B,
    permissions: storage.Permissions.R,
    // Canonicalized resource must point to the specific blob for resource 'b'
    canonicalizedResource: pulumi.interpolate`/blob/${account.name}/${container.name}/${blob.name}`,
    // Optional headers are not needed for read access
    contentType: '',
    cacheControl: '',
    contentDisposition: '',
    contentEncoding: '',
  });
  return pulumi.interpolate`https://${account.name}.blob.core.windows.net/${container.name}/${blob.name}?${blobSAS.serviceSasToken}`;
}
