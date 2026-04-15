const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const crypto = require('crypto');
const path = require('path');

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
 * Upload a buffer/stream to S3-compatible storage.
 * @param {Buffer} buffer
 * @param {string} originalName - used to derive extension
 * @param {string} mimetype
 * @param {string} [folder='uploads']
 * @returns {Promise<string>} S3 key
 */
async function uploadFile(buffer, originalName, mimetype, folder = 'uploads') {
  const ext = path.extname(originalName || '') || mimetypeToExt(mimetype);
  const key = `${folder}/${Date.now()}-${crypto.randomBytes(10).toString('hex')}${ext}`;

  await client.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: buffer,
      ContentType: mimetype,
    })
  );

  return key;
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

function mimetypeToExt(mime) {
  const map = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
  };
  return map[mime] || '';
}

module.exports = { uploadFile, deleteFile, getPresignedUrl, resolveConfigUrls };
