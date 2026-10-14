import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { loadSshPublicKey } from './hub';

const keyFile = (name: string, content: string) => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'ssh-')), name);
  writeFileSync(file, content);

  return file;
};

describe('loadSshPublicKey', () => {
  it('reads an OpenSSH public key', async () => {
    const key =
      'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMMpjr3xhV0Ji5eYbOdl me@host';
    assert.equal(await loadSshPublicKey(keyFile('id.pub', `${key}\n`)), key);
  });

  it('refuses a private key', async () => {
    await assert.rejects(
      loadSshPublicKey(
        keyFile(
          'id',
          '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----\n',
        ),
      ),
      /not an OpenSSH public key/,
    );
  });
});
