// AGPL-3.0-or-later. Part of Postiz. See the repository LICENSE.
//
// X v2 media upload compares the declared media_type with the bytes. The
// non-article image path used to encode every still as GIF and still declare
// the filename MIME. These helpers keep JPEG and PNG as themselves and only
// re-encode a format X would not accept as JPEG, then declare the type of the
// buffer that is actually uploaded.

export type XStillKind = 'gif' | 'png' | 'jpeg';

export function sniffImageKind(bytes: Uint8Array): XStillKind | 'other' {
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return 'gif';
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpeg';
  }
  return 'other';
}

export function mediaTypeForKind(kind: XStillKind): 'image/gif' | 'image/png' | 'image/jpeg' {
  if (kind === 'gif') return 'image/gif';
  if (kind === 'png') return 'image/png';
  return 'image/jpeg';
}

export async function encodeXImage(
  input: Uint8Array,
  encode: (input: Uint8Array, kind: XStillKind) => Promise<Uint8Array>
): Promise<{
  buffer: Uint8Array;
  mediaType: 'image/gif' | 'image/png' | 'image/jpeg';
  mediaCategory: 'tweet_gif' | 'tweet_image';
}> {
  const sniffed = sniffImageKind(input);
  const target: XStillKind = sniffed === 'other' ? 'jpeg' : sniffed;
  let buffer = await encode(input, target);
  if (sniffImageKind(buffer) !== target) {
    buffer = await encode(input, 'jpeg');
  }
  const outputKind = sniffImageKind(buffer);
  const mediaType = mediaTypeForKind(outputKind === 'gif' || outputKind === 'png' ? outputKind : 'jpeg');
  return {
    buffer,
    mediaType,
    mediaCategory: mediaType === 'image/gif' ? 'tweet_gif' : 'tweet_image',
  };
}
