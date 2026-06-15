/**
 * seed-couchdb.js
 * External script to seed CouchDB with data from PouchDB
 * 
 * Usage: node scripts/seed-couchdb.js
 */

const PouchDB = require('pouchdb');
const path = require('path');
const os = require('os');

// CouchDB configuration (env-driven for marker reproducibility)
const COUCHDB_URL = process.env.COUCHDB_URL || 'http://localhost:5984';

// PouchDB paths (same as main app)
const DB_DIR = path.join(os.homedir(), 'AppData', 'Roaming', 'equipment-loan-app');

// Create PouchDB instances
const studentsDB = new PouchDB(path.join(DB_DIR, 'students'));
const equipmentDB = new PouchDB(path.join(DB_DIR, 'equipment'));
const loansDB = new PouchDB(path.join(DB_DIR, 'loans'));

async function getAllFromPouchDB(db) {
  const result = await db.allDocs({ include_docs: true });
  return result.rows
    .map(row => row.doc)
    .filter(doc => !doc._id.startsWith('_design/'));
}

async function seedToCouchDB(localDB, remoteDBName) {
  const records = await getAllFromPouchDB(localDB);
  console.log(`\nSeeding ${remoteDBName}... (${records.length} records)`);

  const remoteDB = new PouchDB(`${COUCHDB_URL}/${remoteDBName}`);

  let inserted = 0;
  let skipped = 0;

  for (const record of records) {
    try {
      // Check if doc already exists in remote
      try {
        const existing = await remoteDB.get(record._id);
        console.log(`  Skipping ${record._id} (already exists)`);
        skipped++;
        continue;
      } catch (err) {
        if (err.status !== 404) throw err;
        // Doc doesn't exist, proceed to insert
      }

      // Remove _rev for new document
      const { _rev, ...docData } = record;
      await remoteDB.put({ ...docData, _id: record._id });
      console.log(`  Inserted ${record._id}`);
      inserted++;
    } catch (err) {
      console.error(`  Failed to insert ${record._id}:`, err.message);
    }
  }

  console.log(`  ${remoteDBName}: ${inserted} inserted, ${skipped} skipped`);
  return { inserted, skipped };
}

async function main() {
  console.log('=== CouchDB Seed Script ===');
  console.log(`PouchDB dir: ${DB_DIR}`);
  console.log(`CouchDB: ${COUCHDB_URL}`);

  // Verify CouchDB connection
  try {
    const testDB = new PouchDB(`${COUCHDB_URL}/_test`);
    await testDB.info();
    await testDB.destroy();
    console.log('\n✓ CouchDB connection verified');
  } catch (err) {
    console.error('\n✗ Cannot connect to CouchDB:', err.message);
    process.exit(1);
  }

  // Read all data from PouchDB
  const students = await getAllFromPouchDB(studentsDB);
  const equipment = await getAllFromPouchDB(equipmentDB);
  const loans = await getAllFromPouchDB(loansDB);

  console.log(`\nData loaded from PouchDB:`);
  console.log(`  Students: ${students.length}`);
  console.log(`  Equipment: ${equipment.length}`);
  console.log(`  Loans: ${loans.length}`);

  // Seed each collection to CouchDB
  const results = {};
  results.students = await seedToCouchDB(studentsDB, 'campus_equipment_loan_students');
  results.equipment = await seedToCouchDB(equipmentDB, 'campus_equipment_loan_equipment');
  results.loans = await seedToCouchDB(loansDB, 'campus_equipment_loan_loans');

  // Summary
  const totalInserted = results.students.inserted + results.equipment.inserted + results.loans.inserted;
  const totalSkipped = results.students.skipped + results.equipment.skipped + results.loans.skipped;

  console.log('\n=== Summary ===');
  console.log(`Total inserted: ${totalInserted}`);
  console.log(`Total skipped: ${totalSkipped}`);
  console.log('\nDone! You can now test two-way sync.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
