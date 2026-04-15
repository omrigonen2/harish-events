#!/usr/bin/env node
/**
 * Migration: assign a default Account to all events that lack an accountId.
 *
 *   node scripts/migrate-add-accounts.js
 *
 * Safe to run multiple times.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Account = require('../models/Account');
const Event = require('../models/Event');

async function main() {
  const mongoUrl = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/event_signup';
  await mongoose.connect(mongoUrl);

  let account = await Account.findOne({ slug: 'default' });
  if (!account) {
    account = await Account.create({ name: 'ברירת מחדל', slug: 'default' });
    console.log(`Created default account: ${account._id}`);
  } else {
    console.log(`Default account exists: ${account._id}`);
  }

  const result = await Event.updateMany(
    { accountId: { $exists: false } },
    { $set: { accountId: account._id } }
  );
  console.log(`Updated ${result.modifiedCount} event(s) with accountId.`);

  // Also handle events where accountId is null
  const result2 = await Event.updateMany(
    { accountId: null },
    { $set: { accountId: account._id } }
  );
  if (result2.modifiedCount > 0) {
    console.log(`Updated ${result2.modifiedCount} event(s) with null accountId.`);
  }

  await mongoose.disconnect();
  console.log('Migration complete.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
