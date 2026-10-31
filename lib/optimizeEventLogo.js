const mongoose = require('mongoose');
const FormConfig = require('../models/FormConfig');
const storage = require('./s3');

/** Apply a requested one-time optimization only while the original key still matches. */
async function optimizeEventLogo({ eventId, expectedKey }) {
  if (!mongoose.isValidObjectId(eventId) || typeof expectedKey !== 'string' || !expectedKey.startsWith('uploads/')) {
    throw new Error('Invalid event logo optimization request');
  }
  const config = await FormConfig.findOne({ eventId, logoUrl: expectedKey }).select('_id').lean();
  if (!config) return { eventId, changed: false, reason: 'Logo already updated' };

  const image = await storage.optimizeStoredImage(expectedKey, { maxDimension: 1000 });
  if (!image.changed) return { eventId, ...image };

  const result = await FormConfig.updateOne(
    { _id: config._id, logoUrl: expectedKey },
    { $set: { logoUrl: image.key } }
  );
  return { eventId, ...image, changed: result.modifiedCount === 1 };
}

module.exports = { optimizeEventLogo };
