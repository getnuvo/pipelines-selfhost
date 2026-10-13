import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { projectIdFromPls } from './atlas-api';

describe('projectIdFromPls', () => {
  it('reads the Atlas project from the endpoint service resource group', () => {
    assert.equal(
      projectIdFromPls(
        '/subscriptions/97882aca-74af-46a8-b854-b4fa3c86ea46/resourceGroups/rg_6ac5c54d915d431a07be3251_lrthvqyr/providers/Microsoft.Network/privateLinkServices/pls_6ac5c791976dc240af27ea1b',
      ),
      '6ac5c54d915d431a07be3251',
    );
    assert.equal(
      projectIdFromPls('/subscriptions/x/resourceGroups/hub-rg/providers/y'),
      undefined,
    );
  });
});
