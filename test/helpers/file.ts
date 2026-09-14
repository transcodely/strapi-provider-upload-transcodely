import { Readable } from 'node:stream';

import type { StrapiFile } from '../../src/types';

/**
 * Builds a Strapi file record.
 *
 * `size` is kilobytes and `sizeInBytes` is bytes, exactly as Strapi sets them
 * (`size: bytesToKbytes(bytes)`, which divides by 1000). Getting that pair
 * wrong is the single easiest way to write a test that passes against a
 * provider which would fail in production.
 */
export function makeFile(overrides: Partial<StrapiFile> & { bytes?: Buffer } = {}): StrapiFile {
  const bytes = overrides.bytes ?? Buffer.alloc(0);
  const rest = { ...overrides };
  delete rest.bytes;

  return {
    name: 'clip.mp4',
    hash: 'clip_abc123',
    ext: '.mp4',
    mime: 'video/mp4',
    size: Math.round((bytes.length / 1000) * 100) / 100,
    sizeInBytes: bytes.length,
    ...rest,
  };
}

export function makeVideoFile(bytes: Buffer, overrides: Partial<StrapiFile> = {}): StrapiFile {
  return makeFile({ bytes, ...overrides });
}

export function makeImageFile(bytes: Buffer, overrides: Partial<StrapiFile> = {}): StrapiFile {
  return makeFile({
    bytes,
    name: 'photo.png',
    hash: 'photo_abc123',
    ext: '.png',
    mime: 'image/png',
    ...overrides,
  });
}

/** Emits `bytes` in fixed-size chunks, so part boundaries never line up with them. */
export function chunkedStream(bytes: Buffer, chunkSize: number): Readable {
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
  }
  return Readable.from(chunks.length > 0 ? chunks : [Buffer.alloc(0)]);
}

/** Deterministic pseudo-random bytes, so a corrupt reassembly is detectable. */
export function pattern(length: number, seed = 7): Buffer {
  const buffer = Buffer.allocUnsafe(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    buffer[i] = state & 0xff;
  }
  return buffer;
}
