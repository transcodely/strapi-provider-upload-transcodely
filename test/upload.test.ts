import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { TranscodelyClient } from '../src/client';
import { resolveConfig } from '../src/config';
import { TranscodelyUploadError } from '../src/errors';
import { declaredByteSize, partCount, uploadVideo } from '../src/upload';
import { chunkedStream, makeFile, makeVideoFile, pattern } from './helpers/file';
import { startMockServer } from './helpers/mock-server';
import type { MockServer, MockServerOptions } from './helpers/mock-server';
import type { TranscodelyProviderOptions } from '../src/config';

const MIB = 1024 * 1024;
const PART = 5 * MIB;

const servers: MockServer[] = [];

after(async () => {
  await Promise.all(servers.map((s) => s.close()));
});

async function harness(
  serverOptions: MockServerOptions = {},
  configOverrides: Partial<TranscodelyProviderOptions> = {},
) {
  const server = await startMockServer(serverOptions);
  servers.push(server);
  const config = resolveConfig({
    apiKey: 'ak_secret',
    baseUrl: server.baseUrl,
    appId: 'app_k1l2m3n4o5',
    partSizeBytes: PART,
    ...configOverrides,
  });
  return { server, config, client: new TranscodelyClient(config) };
}

describe('declaredByteSize', () => {
  it('prefers the exact byte count over the kilobyte field', () => {
    assert.equal(declaredByteSize(makeFile({ size: 12.35, sizeInBytes: 12_345 })), 12_345);
  });

  it('recovers bytes from kilobytes when Strapi set no byte count', () => {
    // Strapi's bytesToKbytes divides by 1000, so the inverse multiplies by 1000.
    const file = makeFile({ size: 12.35, sizeInBytes: undefined });
    assert.equal(declaredByteSize(file), 12_350);
  });

  it('returns undefined when there is no size at all', () => {
    assert.equal(declaredByteSize(makeFile({ size: 0, sizeInBytes: undefined })), undefined);
  });
});

describe('partCount', () => {
  it('always asks for at least one part, even for an empty file', () => {
    assert.equal(partCount(0, PART), 1);
    assert.equal(partCount(1, PART), 1);
  });

  it('rounds up', () => {
    assert.equal(partCount(PART, PART), 1);
    assert.equal(partCount(PART + 1, PART), 2);
    assert.equal(partCount(PART * 3 - 1, PART), 3);
  });
});

describe('uploadVideo', () => {
  it('creates, uploads every part and completes, reassembling the exact bytes', async () => {
    const { server, config, client } = await harness();
    const bytes = pattern(PART * 2 + 1234);
    const file = makeVideoFile(bytes);

    const { video, bytesUploaded } = await uploadVideo(config, client, file, { buffer: bytes });

    assert.equal(bytesUploaded, bytes.length);
    assert.equal(video.status, 'processing');
    assert.deepEqual(server.uploaded.get(video.id), bytes);

    const [create] = server.callsTo('VideoService/CreateMultipartUpload');
    assert.equal(create.body.app_id, 'app_k1l2m3n4o5');
    assert.equal(create.body.filename, 'clip.mp4');
    assert.equal(create.body.content_type, 'video/mp4');
    assert.equal(create.body.size_bytes, bytes.length);
    assert.equal(create.body.total_parts, 3);
    assert.equal(create.body.part_size_bytes, PART);
    assert.equal(server.callsTo('VideoService/AbortMultipartUpload').length, 0);
  });

  it('streams the same bytes without ever holding the whole file', async () => {
    const { server, config, client } = await harness();
    const bytes = pattern(PART * 2 + 4096, 99);
    const file = makeVideoFile(bytes);

    // 64 KiB chunks: part boundaries never coincide with stream chunks.
    const { video } = await uploadVideo(config, client, file, {
      stream: chunkedStream(bytes, 64 * 1024),
    });

    assert.deepEqual(server.uploaded.get(video.id), bytes);
  });

  it('sends exactly total_parts parts, which the API validates', async () => {
    const { server, config, client } = await harness();
    const bytes = pattern(PART * 3);
    const file = makeVideoFile(bytes);

    const { video } = await uploadVideo(config, client, file, { buffer: bytes });

    const [complete] = server.callsTo('VideoService/CompleteMultipartUpload');
    assert.equal(complete.body.id, video.id);
    assert.equal(complete.body.parts.length, 3);
    assert.deepEqual(
      complete.body.parts.map((p: { part_number: number }) => p.part_number),
      [1, 2, 3],
    );
    for (const part of complete.body.parts) {
      assert.match(part.etag, /^"[0-9a-f]{32}"$/);
    }
  });

  it('fetches presigned URLs for parts beyond the first batch', async () => {
    const { server, config, client } = await harness({ initialPartUrls: 2 });
    const bytes = pattern(PART * 5);
    const file = makeVideoFile(bytes);

    const { video } = await uploadVideo(config, client, file, { buffer: bytes });

    assert.deepEqual(server.uploaded.get(video.id), bytes);
    const refills = server.callsTo('VideoService/GetUploadPartUrls');
    assert.equal(refills.length, 1, 'one forward batch covers every remaining part');
    assert.deepEqual(refills[0].body.part_numbers, [3, 4, 5]);
  });

  it('re-mints a presigned URL that expired mid-upload and retries the part once', async () => {
    const { server, config, client } = await harness({ expirePartsOnce: [2] });
    const bytes = pattern(PART * 2);
    const file = makeVideoFile(bytes);

    const { video } = await uploadVideo(config, client, file, { buffer: bytes });

    assert.deepEqual(server.uploaded.get(video.id), bytes);
    const refills = server.callsTo('VideoService/GetUploadPartUrls');
    assert.equal(refills.length, 1);
    assert.deepEqual(refills[0].body.part_numbers, [2]);
  });

  it('aborts the upload when a part cannot be stored, leaving no video behind', async () => {
    const { server, config, client } = await harness({ expirePartsOnce: [1, 1] });
    const bytes = pattern(PART + 10);
    const file = makeVideoFile(bytes);

    // The first PUT 403s, the retry 403s too; the abort must follow.
    await assert.rejects(uploadVideo(config, client, file, { buffer: bytes }));
    assert.equal(server.callsTo('VideoService/AbortMultipartUpload').length, 1);
    assert.equal(server.aborted.length, 1);
    assert.equal(server.videos.size, 0);
  });

  it('aborts rather than completing a stream that held fewer bytes than declared', async () => {
    const { server, config, client } = await harness();
    const bytes = pattern(PART * 2);
    const file = makeVideoFile(bytes);

    await assert.rejects(
      // The stream is a byte short of what the file record claims.
      uploadVideo(config, client, file, { stream: chunkedStream(bytes.subarray(0, bytes.length - 1), 4096) }),
      (error: unknown) => {
        assert.ok(error instanceof TranscodelyUploadError);
        assert.equal(error.code, 'size_mismatch');
        return true;
      },
    );
    assert.equal(server.callsTo('VideoService/CompleteMultipartUpload').length, 0);
    assert.equal(server.aborted.length, 1);
  });

  it('aborts rather than completing a stream that held more bytes than declared', async () => {
    const { server, config, client } = await harness();
    const bytes = pattern(PART * 2);
    const file = makeVideoFile(bytes);

    await assert.rejects(
      uploadVideo(config, client, file, {
        stream: chunkedStream(Buffer.concat([bytes, Buffer.alloc(16)]), 4096),
      }),
      (error: unknown) => {
        assert.ok(error instanceof TranscodelyUploadError);
        assert.equal(error.code, 'size_mismatch');
        return true;
      },
    );
    assert.equal(server.callsTo('VideoService/CompleteMultipartUpload').length, 0);
    assert.equal(server.aborted.length, 1);
  });

  it('destroys the source stream on the failure path, not just on success', async () => {
    // The chunk reader drives the iterator by hand, so `for await`'s implicit
    // cleanup never runs. Strapi does not clean up either — it only deletes
    // file.stream after a successful await — and the source is a read stream
    // over a temp file, so an abandoned stream pins a file descriptor.
    const { config, client } = await harness({ expirePartsOnce: [1, 1] });
    const bytes = pattern(PART + 10);
    const stream = chunkedStream(bytes, 4096);

    await assert.rejects(uploadVideo(config, client, makeVideoFile(bytes), { stream }));
    assert.equal(stream.destroyed, true);
  });

  it('destroys the source stream on the success path too', async () => {
    const { config, client } = await harness();
    const bytes = pattern(PART + 10);
    const stream = chunkedStream(bytes, 4096);

    await uploadVideo(config, client, makeVideoFile(bytes), { stream });
    assert.equal(stream.destroyed, true);
  });

  it('deletes an orphaned video when the create response carries no upload id', async () => {
    const { server, config, client } = await harness({ omitUploadId: true });
    const bytes = pattern(1024);

    await assert.rejects(
      uploadVideo(config, client, makeVideoFile(bytes), { buffer: bytes }),
      /did not return a video id and upload id/,
    );
    assert.equal(server.deleted.length, 1, 'the half-made video was removed');
  });

  it('refuses a file over the 5 GiB API ceiling before creating anything', async () => {
    const { server, config, client } = await harness();
    const file = makeFile({ size: 6_000_000_000 / 1000, sizeInBytes: 6_000_000_000 });

    await assert.rejects(
      uploadVideo(config, client, file, { stream: chunkedStream(Buffer.alloc(0), 1) }),
      (error: unknown) => {
        assert.ok(error instanceof TranscodelyUploadError);
        assert.equal(error.code, 'file_too_large');
        return true;
      },
    );
    assert.equal(server.callsTo('VideoService/CreateMultipartUpload').length, 0);
  });

  it('passes visibility, preset and the free/billed flags through', async () => {
    const { server, config, client } = await harness(
      {},
      {
        visibility: 'private',
        preset: 'gaming_1080p_60_standard',
        hoverPreviews: true,
        autoCaptions: true,
      },
    );
    const bytes = pattern(1024);

    await uploadVideo(config, client, makeVideoFile(bytes), { buffer: bytes });

    const [create] = server.callsTo('VideoService/CreateMultipartUpload');
    assert.equal(create.body.visibility, 'private');
    assert.equal(create.body.preset, 'gaming_1080p_60_standard');
    assert.equal(create.body.hover_previews, true);
    assert.equal(create.body.auto_captions, true);
  });

  it('omits visibility entirely when none is configured, so the app default applies', async () => {
    const { server, config, client } = await harness();
    const bytes = pattern(1024);

    await uploadVideo(config, client, makeVideoFile(bytes), { buffer: bytes });

    const [create] = server.callsTo('VideoService/CreateMultipartUpload');
    assert.ok(!('visibility' in create.body));
  });

  it('uploads with no app_id at all against a current server', async () => {
    const { server, config, client } = await harness({}, { appId: undefined });
    const bytes = pattern(PART + 512);

    const { video } = await uploadVideo(config, client, makeVideoFile(bytes), { buffer: bytes });

    const [create] = server.callsTo('VideoService/CreateMultipartUpload');
    assert.ok(!('app_id' in create.body), 'the key names the app');
    assert.equal(server.callsTo('JobService/List').length, 0);
    assert.deepEqual(server.uploaded.get(video.id), bytes);
  });

  it('still uploads against a pre-5.20.0 server that insists on app_id', async () => {
    const { server, config, client } = await harness(
      { requireAppId: true, jobs: [{ id: 'job_1', app_id: 'app_from_job' }] },
      { appId: undefined },
    );
    const bytes = pattern(PART + 512);

    const { video } = await uploadVideo(config, client, makeVideoFile(bytes), { buffer: bytes });

    const creates = server.callsTo('VideoService/CreateMultipartUpload');
    assert.equal(creates.length, 2, 'key-only attempt, then the retry');
    assert.equal(creates[1].body.app_id, 'app_from_job');
    assert.deepEqual(server.uploaded.get(video.id), bytes);
  });

  it('surfaces the API’s own error when app_id is missing', async () => {
    const { config, client } = await harness({ requireAppId: true, jobs: [] }, { appId: undefined });
    const bytes = pattern(1024);

    await assert.rejects(
      uploadVideo(config, client, makeVideoFile(bytes), { buffer: bytes }),
      (error: unknown) => {
        assert.ok(error instanceof TranscodelyUploadError);
        assert.equal(error.code, 'app_id_required');
        return true;
      },
    );
  });
});
