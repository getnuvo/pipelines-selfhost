import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import { checkLicense } from './license';

const realFetch = globalThis.fetch;
const respond = (status: number, body = '') => {
  globalThis.fetch = (async () =>
    new Response(body, { status })) as typeof fetch;
};

describe('checkLicense', () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('tells a rejected key from a busy or failing service', async () => {
    respond(401, 'invalid license');
    assert.match((await checkLicense('key', '1.0.0')) ?? '', /rejected/);
    respond(429);
    assert.match((await checkLicense('key', '1.0.0')) ?? '', /rate limiting/);
    respond(503);
    assert.match((await checkLicense('key', '1.0.0')) ?? '', /service failed/);
  });

  it('accepts a key that returns a registry key', async () => {
    respond(200, JSON.stringify({ docker_key: 'x' }));
    assert.equal(await checkLicense('key', '1.0.0'), undefined);
  });
});
