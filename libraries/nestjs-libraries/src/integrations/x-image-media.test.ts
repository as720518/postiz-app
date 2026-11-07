import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeXImage, mediaTypeForKind, sniffImageKind } from './x-image-media.ts';

const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const gif = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00]);
const other = Uint8Array.from([0x00, 0x01, 0x02, 0x03]);

test('sniffImageKind reads magic bytes and ignores the filename', () => {
  assert.equal(sniffImageKind(jpeg), 'jpeg');
  assert.equal(sniffImageKind(png), 'png');
  assert.equal(sniffImageKind(gif), 'gif');
  assert.equal(sniffImageKind(other), 'other');
  assert.equal(mediaTypeForKind('jpeg'), 'image/jpeg');
  assert.equal(mediaTypeForKind('png'), 'image/png');
  assert.equal(mediaTypeForKind('gif'), 'image/gif');
});

test('encodeXImage keeps JPEG and PNG and declares the encoded bytes', async () => {
  const calls: string[] = [];
  const jpegResult = await encodeXImage(jpeg, async (_input, kind) => {
    calls.push(kind);
    if (kind === 'jpeg') return jpeg;
    if (kind === 'png') return png;
    return gif;
  });
  assert.deepEqual(calls, ['jpeg']);
  assert.equal(jpegResult.mediaType, 'image/jpeg');
  assert.equal(jpegResult.mediaCategory, 'tweet_image');
  assert.equal(sniffImageKind(jpegResult.buffer), 'jpeg');

  calls.length = 0;
  const pngResult = await encodeXImage(png, async (_input, kind) => {
    calls.push(kind);
    return kind === 'png' ? png : jpeg;
  });
  assert.deepEqual(calls, ['png']);
  assert.equal(pngResult.mediaType, 'image/png');
  assert.equal(pngResult.mediaCategory, 'tweet_image');

  calls.length = 0;
  const gifResult = await encodeXImage(gif, async (_input, kind) => {
    calls.push(kind);
    return gif;
  });
  assert.deepEqual(calls, ['gif']);
  assert.equal(gifResult.mediaType, 'image/gif');
  assert.equal(gifResult.mediaCategory, 'tweet_gif');

  calls.length = 0;
  const otherResult = await encodeXImage(other, async (_input, kind) => {
    calls.push(kind);
    return jpeg;
  });
  assert.deepEqual(calls, ['jpeg']);
  assert.equal(otherResult.mediaType, 'image/jpeg');
});

test('encodeXImage re-encodes when the encoder output does not match the target', async () => {
  let calls = 0;
  const result = await encodeXImage(png, async () => {
    calls += 1;
    return calls === 1 ? gif : jpeg;
  });
  assert.equal(calls, 2);
  assert.equal(result.mediaType, 'image/jpeg');
  assert.equal(sniffImageKind(result.buffer), 'jpeg');
});
