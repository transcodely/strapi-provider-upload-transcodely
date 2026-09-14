import type { Readable } from 'node:stream';

import { MAX_UPLOAD_BYTES } from './config';
import { TranscodelyUploadError } from './errors';
import type { ResolvedConfig } from './config';
import type { TranscodelyClient, UploadPart, VideoResource } from './client';
import type { StrapiFile } from './types';

/**
 * How many presigned part URLs to mint per `GetUploadPartUrls` call. The API
 * caps the request at 100 part numbers, and `CreateMultipartUpload` already
 * returns the first 50 itself.
 */
const PART_URL_BATCH = 100;

export interface UploadResult {
  video: VideoResource;
  bytesUploaded: number;
}

/**
 * The exact byte length of a file, or `undefined` when Strapi gave none.
 *
 * `file.sizeInBytes` is the exact count and is what Strapi v5 sets. `file.size`
 * is kilobytes produced by `Math.round(bytes / 1000 * 100) / 100`, so bytes
 * recovered from it are only accurate to a few bytes — which matters here,
 * because `CompleteMultipartUpload` refuses the request unless the number of
 * parts matches the `total_parts` declared at create time exactly.
 */
export function declaredByteSize(file: StrapiFile): number | undefined {
  if (
    typeof file.sizeInBytes === 'number' &&
    Number.isFinite(file.sizeInBytes) &&
    file.sizeInBytes > 0
  ) {
    return Math.round(file.sizeInBytes);
  }
  if (typeof file.size === 'number' && Number.isFinite(file.size) && file.size > 0) {
    return Math.round(file.size * 1000);
  }
  return undefined;
}

export function partCount(sizeBytes: number, partSizeBytes: number): number {
  return Math.max(1, Math.ceil(sizeBytes / partSizeBytes));
}

/**
 * Reads fixed-size chunks off a Readable.
 *
 * Async iteration hands back whatever chunk sizes the source happened to
 * produce, so a leftover has to be carried between calls; `carry` is that
 * leftover.
 */
class ChunkReader {
  private readonly iterator: AsyncIterator<Buffer>;
  private carry: Buffer = Buffer.alloc(0);
  private done = false;

  constructor(stream: Readable) {
    this.iterator = stream[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  }

  /** Returns exactly `size` bytes, or fewer at end of stream. */
  async next(size: number): Promise<Buffer> {
    const pieces: Buffer[] = [];
    let collected = 0;

    if (this.carry.length > 0) {
      const take = Math.min(size, this.carry.length);
      pieces.push(this.carry.subarray(0, take));
      collected += take;
      this.carry = this.carry.subarray(take);
    }

    while (collected < size && !this.done) {
      const { value, done } = await this.iterator.next();
      if (done) {
        this.done = true;
        break;
      }
      const chunk = toBuffer(value);
      const take = Math.min(size - collected, chunk.length);
      pieces.push(chunk.subarray(0, take));
      collected += take;
      if (take < chunk.length) {
        this.carry = chunk.subarray(take);
      }
    }

    if (pieces.length === 1) {
      return pieces[0];
    }
    return Buffer.concat(pieces, collected);
  }

  /** True once the source is exhausted and nothing is held back. */
  async exhausted(): Promise<boolean> {
    while (this.carry.length === 0 && !this.done) {
      const { value, done } = await this.iterator.next();
      if (done) {
        this.done = true;
        return true;
      }
      this.carry = toBuffer(value);
    }
    return this.carry.length === 0;
  }

  /**
   * Releases the source.
   *
   * Driving the iterator by hand means `for await`'s implicit cleanup never
   * runs, so a throw mid-upload would leave the Readable paused and
   * undestroyed. Strapi does not clean up either — `services/provider.js` only
   * runs `delete file.stream` after a successful await — and the source is an
   * `fs.createReadStream` over a temp file, so every failed upload would pin a
   * file descriptor and a temp file until GC.
   */
  async close(): Promise<void> {
    this.done = true;
    this.carry = Buffer.alloc(0);
    try {
      await this.iterator.return?.();
    } catch {
      // Closing a source that is already torn down is not an error.
    }
  }
}

function toBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (typeof value === 'string') {
    return Buffer.from(value);
  }
  return Buffer.from(value as Uint8Array);
}

/** A source of part-sized buffers, in order, exactly `totalParts` of them. */
interface PartSource {
  next(index: number): Promise<Buffer>;
  /** Called after the last part; throws if the source did not hold exactly the declared bytes. */
  verifyExhausted(): Promise<void>;
  /** Always called, success or failure, so a stream is never left dangling. */
  close(): Promise<void>;
}

function bufferSource(buffer: Buffer, partSize: number): PartSource {
  return {
    async next(index: number) {
      return buffer.subarray(index * partSize, Math.min((index + 1) * partSize, buffer.length));
    },
    async verifyExhausted() {
      /* The buffer's length was the declared size by construction. */
    },
    async close() {
      /* Nothing to release. */
    },
  };
}

function streamSource(stream: Readable, partSize: number, declared: number): PartSource {
  const reader = new ChunkReader(stream);
  let read = 0;

  return {
    async next() {
      const chunk = await reader.next(partSize);
      read += chunk.length;
      return chunk;
    },
    async verifyExhausted() {
      let complaint = '';
      if (read !== declared) {
        complaint = `held ${read} bytes, not the ${declared} Strapi declared`;
      } else if (!(await reader.exhausted())) {
        complaint = `held more than the ${declared} bytes Strapi declared`;
      } else {
        return;
      }
      throw new TranscodelyUploadError(
        `The uploaded stream ${complaint}; the multipart upload was aborted rather than ` +
          'completed with a corrupt file',
        { code: 'size_mismatch' },
      );
    },
    async close() {
      await reader.close();
      stream.destroy();
    },
  };
}

/**
 * Creates a hosted video from a Strapi file and returns it once the bytes are in.
 *
 * The path is `CreateMultipartUpload`, a PUT of every part to its presigned
 * URL, then `CompleteMultipartUpload`. Any failure aborts the multipart upload,
 * which also soft-deletes the half-made video record, so a failed Strapi upload
 * leaves nothing behind.
 *
 * `CreateMultipartUpload` turns managed hosting on for the app if it is not on
 * already — asking to store a video IS the request to be hosted, so there is no
 * `AppService.EnableHosting` round trip to make first. The cost is that the
 * first upload for an app provisions a bucket, a managed origin and a CDN pull
 * zone, so it takes a few seconds longer and can come back
 * `hosting_provisioning_failed`; that answer creates no video and is safe to
 * retry unchanged.
 *
 * Parts are produced lazily and in order, then PUT in windows — the file is
 * never held in memory in full. Peak memory is `partSizeBytes ×
 * uploadConcurrency`.
 */
export async function uploadVideo(
  config: ResolvedConfig,
  client: TranscodelyClient,
  file: StrapiFile,
  source: { buffer?: Buffer; stream?: Readable },
): Promise<UploadResult> {
  const declared = source.buffer ? source.buffer.length : declaredByteSize(file);
  if (declared === undefined) {
    throw new TranscodelyUploadError(
      `Strapi gave no size for "${file.name}", so the upload cannot be split into parts`,
      { code: 'size_unknown' },
    );
  }
  if (declared > MAX_UPLOAD_BYTES) {
    throw new TranscodelyUploadError(
      `"${file.name}" is ${declared} bytes; Transcodely accepts at most ${MAX_UPLOAD_BYTES} bytes (5 GiB)`,
      { code: 'file_too_large' },
    );
  }
  if (!source.buffer && !source.stream) {
    throw new TranscodelyUploadError(`No buffer or stream was given for "${file.name}"`, {
      code: 'missing_payload',
    });
  }

  const partSize = config.partSizeBytes;
  const totalParts = partCount(declared, partSize);

  // No `app_id`: the API key already names exactly one app and the handler
  // resolves it. The client adds one only when the operator configured it, or
  // when a pre-5.20.0 server has refused the key-only call.
  const request: Record<string, unknown> = {
    filename: file.name,
    content_type: file.mime,
    size_bytes: declared,
    total_parts: totalParts,
    part_size_bytes: partSize,
    hover_previews: config.hoverPreviews,
    auto_captions: config.autoCaptions,
  };
  if (config.visibility !== undefined) {
    request.visibility = config.visibility;
  }
  if (config.preset !== undefined) {
    request.preset = config.preset;
  }

  const created = await client.createMultipartUpload(request);
  const videoId = created.video?.id;
  const uploadId = created.upload_id;
  if (!videoId || !uploadId) {
    // A response carrying a video id but no upload id would otherwise strand
    // that video in "uploading" forever. Abort needs the upload id, so the
    // cleanup here is a delete — the only lever that works without one.
    if (videoId) {
      await client.deleteVideo(videoId).catch(() => undefined);
    }
    throw new TranscodelyUploadError(
      'Transcodely did not return a video id and upload id for the multipart upload',
      { code: 'unexpected_response' },
    );
  }

  const parts: PartSource = source.buffer
    ? bufferSource(source.buffer, partSize)
    : streamSource(source.stream as Readable, partSize, declared);

  const urls = new Map<number, string>();
  for (const part of created.parts ?? []) {
    urls.set(part.part_number, part.upload_url);
  }

  try {
    const completed: Array<{ part_number: number; etag: string }> = [];
    let uploaded = 0;

    for (let start = 0; start < totalParts; start += config.uploadConcurrency) {
      const end = Math.min(start + config.uploadConcurrency, totalParts);

      const window: Array<{ number: number; body: Buffer }> = [];
      for (let i = start; i < end; i += 1) {
        window.push({ number: i + 1, body: await parts.next(i) });
      }

      await ensureUrls(
        client,
        videoId,
        uploadId,
        urls,
        totalParts,
        window.map((part) => part.number),
      );

      const etags = await Promise.all(
        window.map((part) => putPart(client, videoId, uploadId, urls, totalParts, part)),
      );

      window.forEach((part, index) => {
        completed.push({ part_number: part.number, etag: etags[index] });
        uploaded += part.body.length;
      });
    }

    await parts.verifyExhausted();

    const response = await client.completeMultipartUpload(videoId, uploadId, completed);
    return { video: response.video ?? created.video, bytesUploaded: uploaded };
  } catch (error) {
    // Abort releases the storage parts and soft-deletes the video record. A
    // failure to abort must not mask the original error, which is the one that
    // explains what went wrong.
    try {
      await client.abortMultipartUpload(videoId, uploadId);
    } catch {
      /* deliberately ignored — see above */
    }
    throw error;
  } finally {
    // Runs on the success path too: the source is fully read by then, and
    // releasing it is what keeps Strapi's temp-file descriptor from outliving
    // the request on every failure path.
    await parts.close();
  }
}

/**
 * PUTs one part, re-minting its presigned URL once if storage refuses it.
 *
 * Presigned URLs last about an hour. A multi-gigabyte upload over a slow link
 * can outlive the batch it was issued in, and an expired URL comes back as a
 * 403 that reads exactly like a permissions problem. One refresh-and-retry
 * turns that into a non-event; a second failure is a real one and propagates.
 */
async function putPart(
  client: TranscodelyClient,
  videoId: string,
  uploadId: string,
  urls: Map<number, string>,
  totalParts: number,
  part: { number: number; body: Buffer },
): Promise<string> {
  const url = urls.get(part.number);
  if (url === undefined) {
    throw new TranscodelyUploadError(
      `Transcodely returned no upload URL for part ${part.number}`,
      { code: 'unexpected_response' },
    );
  }

  try {
    return await client.putPart(url, part.body);
  } catch (error) {
    const status = error instanceof TranscodelyUploadError ? error.statusCode : undefined;
    if (status !== 403 && status !== 400) {
      throw error;
    }
    // Evict EVERY cached URL, not just this one. Presigned URLs are minted in
    // forward batches with a shared expiry, so one expiring means the rest of
    // the batch has too; dropping only the failing part would pay a 403 plus a
    // refresh round trip for every remaining part instead of once.
    urls.clear();
    await ensureUrls(client, videoId, uploadId, urls, totalParts, [part.number]);
    const refreshed = urls.get(part.number);
    if (refreshed === undefined) {
      throw error;
    }
    return client.putPart(refreshed, part.body);
  }
}

/**
 * Makes sure every part in `needed` has a cached presigned URL, minting a
 * forward batch from the first gap. Fetching ahead rather than exactly is what
 * keeps a 200-part upload at two extra RPCs instead of one per window.
 */
async function ensureUrls(
  client: TranscodelyClient,
  videoId: string,
  uploadId: string,
  urls: Map<number, string>,
  totalParts: number,
  needed: number[],
): Promise<void> {
  for (;;) {
    const firstGap = needed.find((n) => !urls.has(n));
    if (firstGap === undefined) {
      return;
    }

    const wanted: number[] = [];
    for (let n = firstGap; n <= totalParts && wanted.length < PART_URL_BATCH; n += 1) {
      if (!urls.has(n)) {
        wanted.push(n);
      }
    }

    const before = urls.size;
    const response = await client.getUploadPartUrls(videoId, uploadId, wanted);
    for (const part of (response.parts ?? []) as UploadPart[]) {
      urls.set(part.part_number, part.upload_url);
    }

    // Nothing new came back: stop rather than loop forever. The caller raises a
    // clear "no upload URL for part N" error.
    if (urls.size === before) {
      return;
    }
  }
}
