import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { conflictFileName, saveConflictCopy } from '../src/conflict.js';

/** @type {string} */
let root;

before(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'myobs-conflict-'));
  await fs.promises.mkdir(path.join(root, 'notes'), { recursive: true });
});

after(async () => {
  await fs.promises.rm(root, { recursive: true, force: true });
});

describe('conflictFileName', () => {
  it('inserts .conflict-<epochms> before the extension', () => {
    assert.equal(conflictFileName('note.md', 1730000000000), 'note.conflict-1730000000000.md');
  });

  it('handles files without an extension', () => {
    assert.equal(conflictFileName('README', 1730000000000), 'README.conflict-1730000000000');
  });

  it('treats a leading dot as part of the name, not an extension', () => {
    assert.equal(conflictFileName('.env', 1730000000000), '.env.conflict-1730000000000');
  });

  it('only treats the final suffix as the extension', () => {
    assert.equal(
      conflictFileName('archive.tar.gz', 1730000000000),
      'archive.tar.conflict-1730000000000.gz',
    );
  });
});

describe('saveConflictCopy', () => {
  it('copies the current contents next to the original', async () => {
    const absolute = path.join(root, 'notes/keep.md');
    await fs.promises.writeFile(absolute, 'version one');

    const result = await saveConflictCopy(absolute, 'notes/keep.md', { now: 1730000000000 });

    assert.equal(result.savedAs, 'notes/keep.conflict-1730000000000.md');
    assert.equal(await fs.promises.readFile(result.absPath, 'utf8'), 'version one');
    assert.equal(await fs.promises.readFile(absolute, 'utf8'), 'version one');
  });

  it('never overwrites an existing conflict copy', async () => {
    const absolute = path.join(root, 'notes/collide.md');
    await fs.promises.writeFile(absolute, 'current');
    await fs.promises.writeFile(
      path.join(root, 'notes/collide.conflict-1730000000000.md'),
      'already here',
    );

    const result = await saveConflictCopy(absolute, 'notes/collide.md', { now: 1730000000000 });

    assert.equal(result.savedAs, 'notes/collide.conflict-1730000000001.md');
    assert.equal(await fs.promises.readFile(result.absPath, 'utf8'), 'current');
    assert.equal(
      await fs.promises.readFile(
        path.join(root, 'notes/collide.conflict-1730000000000.md'),
        'utf8',
      ),
      'already here',
    );
  });

  it('rejects a directory', async () => {
    const absolute = path.join(root, 'notes');
    await assert.rejects(
      () => saveConflictCopy(absolute, 'notes'),
      (err) => err && err.code === 'EISDIR',
    );
  });
});
