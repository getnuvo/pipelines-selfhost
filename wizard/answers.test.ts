import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { loadAnswers } from './answers';

const answersFile = (yaml: string) => {
  const file = path.join(
    mkdtempSync(path.join(tmpdir(), 'answers-')),
    'a.yaml',
  );
  writeFileSync(file, yaml);

  return file;
};

describe('loadAnswers', () => {
  it('takes lists only for list questions', () => {
    assert.deepEqual(
      loadAnswers(answersFile('blobClientCidrs:\n  - 10.1.0.0/24\n'))
        .blobClientCidrs,
      ['10.1.0.0/24'],
    );
    assert.throws(
      () => loadAnswers(answersFile('version:\n  - 0.1.0\n  - 0.2.0\n')),
      /version: expected a single value/,
    );
  });
});
