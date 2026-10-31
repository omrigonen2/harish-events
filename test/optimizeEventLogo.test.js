const test = require('node:test');
const assert = require('node:assert/strict');
const FormConfig = require('../models/FormConfig');
const storage = require('../lib/s3');
const eventId = '6ae57ccf6dabb888a246fd83';
const expectedKey = 'uploads/original.png';

test('logo maintenance skips a logo that has already changed', async (t) => {
  t.mock.method(FormConfig, 'findOne', () => ({ select: () => ({ lean: async () => null }) }));
  const optimize = t.mock.method(storage, 'optimizeStoredImage', async () => { throw new Error('must not be called'); });
  const { optimizeEventLogo } = require('../lib/optimizeEventLogo');
  const result = await optimizeEventLogo({ eventId, expectedKey });
  assert.equal(result.changed, false);
  assert.equal(optimize.mock.callCount(), 0);
});

test('logo maintenance updates only the matching logo and retains the display configuration', async (t) => {
  t.mock.method(FormConfig, 'findOne', () => ({ select: () => ({ lean: async () => ({ _id: 'config-id' }) }) }));
  const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
  const sharp = require('sharp');
  const source = await sharp({ create: { width: 1600, height: 600, channels: 3, background: '#783b12' } })
    .png({ compressionLevel: 0 }).toBuffer();
  t.mock.method(S3Client.prototype, 'send', async (command) => command instanceof GetObjectCommand
    ? { Body: { transformToByteArray: async () => source } } : {});
  let update;
  t.mock.method(FormConfig, 'updateOne', async (filter, change) => { update = { filter, change }; return { modifiedCount: 1 }; });
  const { optimizeEventLogo } = require('../lib/optimizeEventLogo');
  const result = await optimizeEventLogo({ eventId, expectedKey });
  assert.equal(result.changed, true);
  assert.deepEqual(update.filter, { _id: 'config-id', logoUrl: expectedKey });
  assert.deepEqual(update.change, { $set: { logoUrl: result.key } });
  assert.match(result.key, /^uploads\/optimized\/.*\.webp$/);
});
