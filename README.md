[![Deploy this example with Pulumi](https://www.pulumi.com/images/deploy-with-pulumi/dark.svg)](https://app.pulumi.com/new?template=https://github.com/pulumi/examples/blob/master/azure-ts-functions/README.md#gh-light-mode-only)
[![Deploy this example with Pulumi](https://get.pulumi.com/new/button-light.svg)](https://app.pulumi.com/new?template=https://github.com/pulumi/examples/blob/master/azure-ts-functions/README.md#gh-dark-mode-only)

# Deploying Azure Functions

Starting point for building serverless applications hosted in Azure Functions.

## Running the App

1.  Create a new stack:

    ```
    $ pulumi stack init dev
    ```

1.  Login to Azure CLI (you will be prompted to do this during deployment if you forget this step):

    ```
    $ az login
    ```

1.  Restore NPM dependencies:

    ```
    $ npm install
    ```

1.  Set the Azure region location to use:

    ```
    $ pulumi config set azure-native:location westus2
    ```

1.  Run `pulumi up` to preview and deploy changes:

    ```
    $ pulumi up
    Previewing changes:
    ...

    Performing changes:
    ...
    Resources:
        + 8 created

    Duration: 1m18s
    ```

1.  Check the deployed endpoint:

    ```
    $ pulumi stack output endpoint
    https://appg-fsprfojnnlr.azurewebsites.net/api/HelloNode?name=Pulumi
    $ curl "$(pulumi stack output endpoint)"
    Hello from Node.js, Pulumi
    ```

## Using an S3 archive for your function code

Instead of zipping the local ./javascript folder, you can point the deployment at a remote .zip or .tar(.gz) archive stored in S3 (or any HTTPS-accessible storage).

- Set a stack config value `codeArchiveUrl` to an HTTPS URL of your archive. For S3, use a presigned URL so Pulumi can download it during deploy.
- If `codeArchiveUrl` is not set, the deployment falls back to zipping the local `appPath` (default: ./javascript).

Example with AWS CLI to presign and deploy:

```
# Zip your function app (must be the app root containing host.json, function folders, etc.)
zip -r function.zip ./javascript

# Upload to S3
aws s3 cp function.zip s3://my-bucket/function.zip

# Generate a 1-hour presigned URL
URL=$(aws s3 presign s3://my-bucket/function.zip --expires-in 3600)

# Point the stack at the remote archive and deploy
pulumi config set codeArchiveUrl "$URL"
# Optional: override appPath if you want a different local folder when not using S3
# pulumi config set appPath ./my-local-app

pulumi up
```

Notes:

- The URL must be reachable from the machine running Pulumi (no private-only endpoints unless your environment has access).
- The archive should contain a valid Azure Functions app layout (host.json at root, function folders with function.json, etc.).
- To revert to local packaging, unset the config:

```
pulumi config rm codeArchiveUrl
```
