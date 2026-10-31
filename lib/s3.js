const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const crypto = require('crypto');
const { optimizeImage } = require('./imageOptimization');

const BUCKET = process.env.IDRIVE_E2_BUCKET;
const REGION = process.env.IDRIVE_E2_REGION || 'us-east-1';

function normalizeEndpoint(raw) {
  if (!raw) return raw;
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://${raw}`;
}
const ENDPOINT = normalizeEndpoint(process.env.IDRIVE_E2_ENDPOINT);

const client = new S3Client({
  region: REGION,
  endpoint: ENDPOINT,
  credentials: {
    accessKeyId: process.env.IDRIVE_E2_ACCESS_KEY,
    secretAccessKey: process.env.IDRIVE_E2_SECRET_KEY,
  },
  forcePathStyle: true, // required for iDrive e2
});

/**
 * Optimize and upload an image buffer to S3-compatible storage.
 * @param {Buffer} buffer
 * @param {string} originalName
 * @param {string} mimetype
 * @param {string} [folder='uploads']
 * @returns {Promise<string>} S3 key
 */
async function uploadFile(buffer, originalName, mimetype, folder = 'uploads') {
  const optimized = await optimizeImage(buffer, { folder });
  return storeImage(optimized, folder);
}

async function storeImage(optimized, folder) {
  const key = `${folder}/${Date.now()}-${crypto.randomBytes(10).toString('hex')}${optimized.extension}`;

  await client.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: optimized.buffer,
      ContentType: optimized.mimetype,
    })
  );

  return key;
}

/** Create a smaller copy without deleting or overwriting the original object. */
async function optimizeStoredImage(key, { maxDimension = 1920 } = {}) {
  const response = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }), {
    abortSignal: AbortSignal.timeout(30000),
  });
  const buffer = Buffer.from(await response.Body.transformToByteArray());
  const optimized = await optimizeImage(buffer, { maxDimension });
  if (optimized.buffer.length >= buffer.length) {
    return { key, originalBytes: buffer.length, optimizedBytes: buffer.length, changed: false };
  }
  const newKey = await storeImage(optimized, 'uploads/optimized');
  return { key: newKey, originalBytes: buffer.length, optimizedBytes: optimized.buffer.length, changed: true };
}

/**
 * Delete an object by key.
 * @param {string} key
 */
async function deleteFile(key) {
  if (!key) return;
  try {
    await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
  } catch (err) {
    console.error('S3 delete failed for key', key, err.message);
  }
}

/**
 * Generate a pre-signed GET URL for a private object.
 * @param {string} key
 * @param {number} [expiresIn=3600] seconds
 * @returns {Promise<string>}
 */
async function getPresignedUrl(key, expiresIn = 3600) {
  if (!key) return '';
  const command = new GetObjectCommand({ Bucket: BUCKET, Key: key });
  return getSignedUrl(client, command, { expiresIn });
}

/**
 * Generate presigned URLs for a config object's image fields.
 * Returns a plain object with resolved URLs (or empty strings).
 */
async function resolveConfigUrls(config) {
  if (!config) return config;

  const [logoUrl, backgroundImage] = await Promise.all([
    config.logoUrl ? getPresignedUrl(config.logoUrl) : Promise.resolve(''),
    config.backgroundImage ? getPresignedUrl(config.backgroundImage) : Promise.resolve(''),
  ]);

  return { ...config, logoUrl, backgroundImage };
}

module.exports = { uploadFile, deleteFile, getPresignedUrl, resolveConfigUrls, optimizeStoredImage };
