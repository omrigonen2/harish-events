#!/usr/bin/env node
/**
 * One-time script: create the first super-admin user.
 *
 *   node scripts/seed-superadmin.js <email> <password> [displayName]
 *
 * Requires MONGODB_URI in .env (or defaults to local).
 */
require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('../models/User');

async function main() {
  const [,, email, password, displayName] = process.argv;

  if (!email || !password) {
    console.error('Usage: node scripts/seed-superadmin.js <email> <password> [displayName]');
    process.exit(1);
  }

  const mongoUrl = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/event_signup';
  await mongoose.connect(mongoUrl);

  const existing = await User.findOne({ role: 'superadmin' });
  if (existing) {
    console.log(`Super-admin already exists: ${existing.email}`);
    await mongoose.disconnect();
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const user = await User.create({
    email: email.toLowerCase().trim(),
    passwordHash,
    displayName: (displayName || '').trim() || email.split('@')[0],
    role: 'superadmin',
  });

  console.log(`Super-admin created: ${user.email} (${user._id})`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
