const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { optimizeImage } = require('../lib/imageOptimization');

function poster(width, height) {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <defs><linearGradient id="bg"><stop stop-color="#412483"/><stop offset="1" stop-color="#e98532"/></linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#bg)"/>
    <circle cx="400" cy="300" r="160" fill="#fff" opacity="0.3"/>
    <text x="100" y="200" fill="#fff" font-size="100">Community event</text>
  </svg>`);
}

test('a multi-megabyte title becomes a much smaller WebP image with the same dimensions', async () => {
  const source = await sharp(poster(1600, 600)).png({ compressionLevel: 0 }).toBuffer();
  const result = await optimizeImage(source, { folder: 'event-descriptions' });
  const metadata = await sharp(result.buffer).metadata();
  assert.ok(source.length > 2_600_000);
  assert.ok(result.buffer.length < source.length / 4);
  assert.equal(metadata.width, 1600);
  assert.equal(metadata.height, 600);
  assert.equal(metadata.format, 'webp');
  assert.equal(result.mimetype, 'image/webp');
  assert.equal(result.extension, '.webp');
});

test('large uploads shrink proportionally without cropping or enlarging small images', async () => {
  const large = await sharp(poster(3000, 1500)).png().toBuffer();
  const largeResult = await optimizeImage(large);
  const metadata = await sharp(largeResult.buffer).metadata();
  assert.equal(metadata.width, 1920);
  assert.equal(metadata.height, 960);

  const small = await sharp(poster(400, 200)).png().toBuffer();
  const smallResult = await optimizeImage(small);
  const smallMetadata = await sharp(smallResult.buffer).metadata();
  assert.equal(smallMetadata.width, 400);
  assert.equal(smallMetadata.height, 200);
  assert.ok(smallResult.buffer.length <= small.length);
});

test('transparent images keep their alpha channel', async () => {
  const source = await sharp({ create: { width: 600, height: 400, channels: 4, background: { r: 30, g: 90, b: 160, alpha: 0.5 } } })
    .png({ compressionLevel: 0 }).toBuffer();
  const result = await optimizeImage(source);
  const { data, info } = await sharp(result.buffer).raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.channels, 4);
  assert.ok(data[3] >= 126 && data[3] <= 129);
});

test('messaging uploads remain JPEG or PNG and are limited to 1600 pixels', async () => {
  const source = await sharp(poster(2400, 1200)).removeAlpha().png({ compressionLevel: 0 }).toBuffer();
  const result = await optimizeImage(source, { folder: 'message-images' });
  const metadata = await sharp(result.buffer).metadata();
  assert.equal(result.mimetype, 'image/jpeg');
  assert.equal(result.extension, '.jpg');
  assert.equal(metadata.width, 1600);
  assert.equal(metadata.height, 800);

  const transparent = await sharp({ create: { width: 100, height: 100, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .png({ compressionLevel: 0 }).toBuffer();
  const transparentResult = await optimizeImage(transparent, { folder: 'message-images' });
  assert.equal(transparentResult.mimetype, 'image/png');
  assert.equal((await sharp(transparentResult.buffer).metadata()).hasAlpha, true);
});

test('SVG and animated GIF/WebP uploads remain intact', async () => {
  const svg = poster(1600, 600);
  const vectorResult = await optimizeImage(svg);
  assert.equal(vectorResult.buffer, svg);
  assert.equal(vectorResult.mimetype, 'image/svg+xml');

  const pixels = Buffer.alloc(4 * 2 * 3, 255);
  pixels.fill(0, 0, 4 * 3);
  for (const format of ['gif', 'webp']) {
    const animation = await sharp(pixels, { raw: { width: 4, height: 2, channels: 3, pageHeight: 1 } })
      .toFormat(format, { delay: [100, 100], loop: 0 }).toBuffer();
    assert.equal((await sharp(animation).metadata()).pages, 2);
    const result = await optimizeImage(animation);
    assert.equal(result.buffer, animation);
    assert.equal(result.mimetype, `image/${format}`);
  }
});

test('already efficient images never grow, and invalid image data is rejected', async () => {
  const tiny = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#fff' } }).png().toBuffer();
  const result = await optimizeImage(tiny);
  assert.ok(result.buffer.length <= tiny.length);
  await assert.rejects(() => optimizeImage(Buffer.from('not an image')));
});

test('storage uploads use the optimized bytes, content type and filename extension', async (t) => {
  const { S3Client } = require('@aws-sdk/client-s3');
  let stored;
  t.mock.method(S3Client.prototype, 'send', async (command) => { stored = command.input; });
  const { uploadFile } = require('../lib/s3');
  const source = await sharp(poster(1600, 600)).png({ compressionLevel: 0 }).toBuffer();
  const key = await uploadFile(source, 'title.png', 'image/png', 'event-descriptions');
  assert.match(key, /^event-descriptions\/.*\.webp$/);
  assert.equal(stored.Key, key);
  assert.equal(stored.ContentType, 'image/webp');
  assert.ok(stored.Body.length < source.length / 4);
  assert.equal((await sharp(stored.Body).metadata()).format, 'webp');
});

test('existing stored images get a smaller copy and leave the original object intact', async (t) => {
  const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
  const source = await sharp(poster(1600, 600)).png({ compressionLevel: 0 }).toBuffer();
  const commands = [];
  t.mock.method(S3Client.prototype, 'send', async (command) => {
    commands.push(command);
    if (command instanceof GetObjectCommand) return { Body: { transformToByteArray: async () => source } };
    return {};
  });
  const { optimizeStoredImage } = require('../lib/s3');
  const result = await optimizeStoredImage('uploads/original.png', { maxDimension: 1000 });
  assert.equal(result.changed, true);
  assert.equal(result.originalBytes, source.length);
  assert.ok(result.optimizedBytes < result.originalBytes / 4);
  assert.match(result.key, /^uploads\/optimized\/.*\.webp$/);
  assert.equal(commands.length, 2);
  assert.ok(commands[1] instanceof PutObjectCommand);
  assert.notEqual(commands[1].input.Key, commands[0].input.Key);
  const meta = await sharp(commands[1].input.Body).metadata();
  assert.equal(meta.width, 1000);
  assert.equal(meta.height, 375);
});
