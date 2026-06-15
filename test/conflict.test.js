/**
 * test/conflict.test.js
 *
 * Unit tests for the conflict-tracking pipeline in electron/db.js:
 *   - logConflict()
 *   - getPendingConflicts()
 *   - resolveConflict()
 *   - detectConflicts()
 *
 * Uses Node's built-in `node:test` runner (no extra dependencies).
 * Run with: `npm test`
 *
 * These tests run outside Electron: they set POUCHDB_DIR_OVERRIDE to
 * a fresh temp dir, so db.js never imports the `electron` package.
 */

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('fs');
const os       = require('os');
const path     = require('path');

// Fresh, empty working dir per test file run
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cos20015-conflict-test-'));
process.env.POUCHDB_DIR_OVERRIDE = TMP_DIR;

// Clean up the PouchDB instances the module creates on require
function cleanup(done) {
  try {
    const db = require('../electron/db');
    Promise.all([
      db.studentsDB  && db.studentsDB.destroy(),
      db.equipmentDB && db.equipmentDB.destroy(),
      db.loansDB     && db.loansDB.destroy(),
      db.conflictsDB && db.conflictsDB.destroy(),
    ]).catch(() => {}).finally(() => {
      try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}
      done && done();
    });
  } catch (e) {
    done && done();
  }
}

// Require AFTER setting the env var so the module picks up the temp dir
const db = require('../electron/db');

// Helper: create a real PouchDB conflict on the equipmentDB by writing
// a divergent edit at an old revision via bulkDocs({ new_edits: false }).
async function forceEquipmentConflict(docId, versionA, versionB) {
  // First write: rev 1
  await db.equipmentDB.put({ _id: docId, equipmentID: docId, name: versionA, available: true });
  // Get the rev
  const cur = await db.equipmentDB.get(docId);
  const rev1 = cur._rev;

  // Update: rev 2 (legitimate)
  await db.equipmentDB.put({ _id: docId, _rev: rev1, equipmentID: docId, name: 'rev2', available: true });

  // Now write a divergent edit at rev1 with new_edits: false
  // This creates a conflict branch
  await db.equipmentDB.bulkDocs(
    [{ _id: docId, _rev: rev1, equipmentID: docId, name: versionB, available: true, _revisions: { start: 2, ids: [rev1.split('-')[1], 'AAAAAAAA'] } }],
    { new_edits: false }
  );
}

test('logConflict writes a pending record', async () => {
  const logged = await db.logConflict({
    table: 'equipment',
    documentID: 'E001',
    localRev: '1-aaa',
    remoteRev: '1-bbb',
    localDoc: { _id: 'E001', name: 'local' },
    remoteDoc: { _id: 'E001', name: 'remote' },
  });

  assert.equal(logged.status, 'pending');
  assert.equal(logged.table, 'equipment');
  assert.equal(logged.documentID, 'E001');
  assert.match(logged.conflictID, /^conflict_\d+_E001$/);
  assert.ok(logged.timestamp);
});

test('logConflict de-duplicates on (table, documentID) while pending', async () => {
  const first = await db.logConflict({
    table: 'loans',
    documentID: 'L0042',
    localRev: '2-aaa',
    remoteRev: '2-bbb',
    localDoc: {},
    remoteDoc: {},
  });
  const second = await db.logConflict({
    table: 'loans',
    documentID: 'L0042',
    localRev: '2-aaa',
    remoteRev: '2-bbb',
    localDoc: {},
    remoteDoc: {},
  });

  // Second call returns the existing record (same _id), does not create a new one
  assert.equal(second.conflictID, first.conflictID);
  const pending = await db.getPendingConflicts();
  const loans = pending.filter(c => c.documentID === 'L0042');
  assert.equal(loans.length, 1, 'only one pending conflict for L0042');
});

test('getPendingConflicts returns only pending, sorted newest-first', async () => {
  // Two new pending conflicts with slightly different timestamps
  await db.logConflict({
    table: 'students', documentID: 'S100',
    localRev: '1-x', remoteRev: '1-y', localDoc: {}, remoteDoc: {},
  });
  // ensure timestamp ordering
  await new Promise(r => setTimeout(r, 5));
  await db.logConflict({
    table: 'students', documentID: 'S101',
    localRev: '1-x', remoteRev: '1-y', localDoc: {}, remoteDoc: {},
  });

  const pending = await db.getPendingConflicts();
  // All returned must be pending
  for (const c of pending) {
    assert.equal(c.status, 'pending');
  }
  // Newest-first ordering: S101 should appear before S100
  const s100 = pending.findIndex(c => c.documentID === 'S100');
  const s101 = pending.findIndex(c => c.documentID === 'S101');
  assert.ok(s100 >= 0 && s101 >= 0, 'both present');
  assert.ok(s101 < s100, `S101 (idx ${s101}) should be before S100 (idx ${s100})`);
});

test('resolveConflict applies the remote revision and marks the record resolved', async () => {
  // Seed source doc
  await db.equipmentDB.put({ _id: 'E777', equipmentID: 'E777', name: 'local-name', available: true });

  // Log a conflict whose remoteDoc is what we want to apply.
  // The remoteDoc must include the equipmentID field — upsertFromRemote
  // uses it as the PouchDB _id.
  const logged = await db.logConflict({
    table: 'equipment',
    documentID: 'E777',
    localRev: '1-aaa',
    remoteRev: '1-bbb',
    localDoc:  { _id: 'E777', equipmentID: 'E777', name: 'local-name',  available: true },
    remoteDoc: { _id: 'E777', equipmentID: 'E777', name: 'remote-name', available: false },
  });

  // Resolve as "remote" — should overwrite the local doc with the remote one
  const result = await db.resolveConflict(logged.conflictID, 'remote');
  assert.equal(result.success, true);
  assert.equal(result.resolution, 'remote');

  // The source record should now reflect the remote revision
  const after = await db.equipmentDB.get('E777');
  assert.equal(after.name, 'remote-name');
  assert.equal(after.available, false);

  // The conflict record should be marked resolved
  const pending = await db.getPendingConflicts();
  assert.equal(
    pending.find(c => c.conflictID === logged.conflictID),
    undefined,
    'resolved conflict should not appear in pending list'
  );
});

test('resolveConflict("merge") writes the caller-supplied winnerData', async () => {
  await db.equipmentDB.put({ _id: 'E888', equipmentID: 'E888', name: 'orig', available: true });
  const logged = await db.logConflict({
    table: 'equipment',
    documentID: 'E888',
    localRev: '1-x', remoteRev: '1-y',
    localDoc:  { _id: 'E888', equipmentID: 'E888', name: 'orig' },
    remoteDoc: { _id: 'E888', equipmentID: 'E888', name: 'remote' },
  });

  const merged = { _id: 'E888', equipmentID: 'E888', name: 'merged-name', available: true };
  await db.resolveConflict(logged.conflictID, 'merge', merged);

  const after = await db.equipmentDB.get('E888');
  assert.equal(after.name, 'merged-name');
});

test('resolveConflict throws on unknown conflictID', async () => {
  await assert.rejects(
    () => db.resolveConflict('conflict_does_not_exist', 'remote'),
    /Conflict not found/
  );
});

test('detectConflicts finds and logs conflicts on the source DBs', async () => {
  // Force a conflict on equipmentDB
  await forceEquipmentConflict('E999', 'local-version', 'remote-version');

  // detectConflicts should now log this conflict (and any others)
  const detected = await db.detectConflicts();
  const e999 = detected.find(d => d.documentID === 'E999' && d.table === 'equipment');
  assert.ok(e999, `detectConflicts should find E999 conflict, got: ${JSON.stringify(detected)}`);

  // The conflict should be retrievable via getPendingConflicts
  const pending = await db.getPendingConflicts();
  const e999Pending = pending.find(c => c.documentID === 'E999' && c.table === 'equipment');
  assert.ok(e999Pending, 'E999 conflict should be in pending list');
  assert.equal(e999Pending.status, 'pending');
  assert.ok(e999Pending.localDoc && e999Pending.remoteDoc, 'both localDoc and remoteDoc should be captured');
});

test('detectConflicts is idempotent: re-running does not create duplicate pending records', async () => {
  // Use a fresh doc ID — E999 already has a conflict logged from the
  // previous test. Idempotency is about NOT creating duplicates when
  // the same conflict is detected multiple times.
  await forceEquipmentConflict('E1000', 'local-version', 'remote-version');
  // The de-dup logic in logConflict should keep pending count stable
  await db.detectConflicts();
  await db.detectConflicts();
  await db.detectConflicts();

  const pending = await db.getPendingConflicts();
  const e1000Pending = pending.filter(c => c.documentID === 'E1000' && c.table === 'equipment');
  assert.equal(e1000Pending.length, 1, 'only one pending conflict for E1000 even after 3 detect passes');
});

test('cleanup', async (t) => {
  await new Promise((resolve) => cleanup(resolve));
});
