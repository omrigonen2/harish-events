#!/usr/bin/env node
/**
 * Migration: populate phoneNormalized on existing registrations.
 *
 *   node scripts/backfill-phone-normalized.js
 *
 * Safe to run multiple times.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Registration = require('../models/Registration');
const { normalizePhone } = require('../lib/wasender');

async function main() {
  const mongoUrl = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/event_signup';
  await mongoose.connect(mongoUrl);

  let updated = 0;
  const cursor = Registration.find({
    $or: [
      { phoneNormalized: { $exists: false } },
      { phoneNormalized: '' },
      { phoneNormalized: null },
    ],
  }).select('_id phone').cursor();

  let batch = [];
  for await (const registration of cursor) {
    const phoneNormalized = normalizePhone(registration.phone);
    batch.push({
      updateOne: {
        filter: { _id: registration._id },
        update: { $set: { phoneNormalized } },
      },
    });

    if (batch.length >= 500) {
      const result = await Registration.bulkWrite(batch);
      updated += result.modifiedCount;
      batch = [];
    }
  }

  if (batch.length) {
    const result = await Registration.bulkWrite(batch);
    updated += result.modifiedCount;
  }

  console.log(`Updated ${updated} registration(s) with phoneNormalized.`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
