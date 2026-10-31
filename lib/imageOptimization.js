const sharp = require('sharp');

const INPUT_OPTIONS = { limitInputPixels: 40_000_000 };
const IMAGE_TYPES = {
  jpeg: { mimetype: 'image/jpeg', extension: '.jpg' },
  png: { mimetype: 'image/png', extension: '.png' },
  webp: { mimetype: 'image/webp', extension: '.webp' },
  gif: { mimetype: 'image/gif', extension: '.gif' },
  svg: { mimetype: 'image/svg+xml', extension: '.svg' },
};

/** Optimize once before storage, keeping vector graphics and animations intact. */
async function optimizeImage(buffer, { folder = 'uploads', maxDimension = 1920 } = {}) {
  const image = sharp(buffer, INPUT_OPTIONS);
  const metadata = await image.metadata();
  const originalType = IMAGE_TYPES[metadata.format];
  if (!originalType) throw new Error('Unsupported image format');

  const original = { buffer, ...originalType };
  if (metadata.format === 'svg' || metadata.format === 'gif' || metadata.pages > 1) {
    return original;
  }

  const forMessaging = folder === 'message-images';
  const targetDimension = forMessaging ? Math.min(1600, maxDimension) : maxDimension;
  let pipeline = image.rotate().resize({
    width: targetDimension,
    height: targetDimension,
    fit: 'inside',
    withoutEnlargement: true,
  });

  // WhatsApp image delivery uses JPEG/PNG; browser images can use smaller WebP.
  let outputType;
  if (forMessaging && metadata.hasAlpha) {
    pipeline = pipeline.png({ compressionLevel: 9, palette: true, quality: 90 });
    outputType = IMAGE_TYPES.png;
  } else if (forMessaging) {
    pipeline = pipeline.jpeg({ quality: 85, mozjpeg: true });
    outputType = IMAGE_TYPES.jpeg;
  } else {
    pipeline = pipeline.webp({ quality: 85, effort: 4 });
    outputType = IMAGE_TYPES.webp;
  }

  const optimized = await pipeline.toBuffer();
  // Already efficient uploads should never become larger due to re-encoding.
  if (optimized.length >= buffer.length) return original;
  return { buffer: optimized, ...outputType };
}

module.exports = { optimizeImage };
