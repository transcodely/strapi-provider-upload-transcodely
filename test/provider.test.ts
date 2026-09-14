import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { after, describe, it } from 'node:test';

import { init, isVideoFile, providerMetadata } from '../src/provider';
import { resolveConfig } from '../src/config';
import { TranscodelyUploadError } from '../src/errors';
import { createFallbackStub } from './helpers/fallback-stub';
import { chunkedStream, makeImageFile, makeVideoFile, pattern } from './helpers/file';
import { startMockServer } from './helpers/mock-server';
import type { FallbackStub } from './helpers/fallback-stub';
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
  overrides: Partial<TranscodelyProviderOptions> = {},
): Promise<{ server: MockServer; fallback: FallbackStub; provider: ReturnType<typeof init> }> {
  const server = await startMockServer(serverOptions);
  servers.push(server);
  const fallback = createFallbackStub({ withSignedUrl: true });
  const provider = init({
    apiKey: 'ak_secret',
    baseUrl: server.baseUrl,
    playerBaseUrl: 'https://play.transcodely.com',
    appId: 'app_k1l2m3n4o5',
    partSizeBytes: PART,
    fallbackProvider: fallback,
    fallbackProviderOptions: { sizeLimit: 1_000_000 },
    ...overrides,
  });
  return { server, fallback, provider };
}

describe('isVideoFile', () => {
  const config = resolveConfig({ apiKey: 'ak_test', videoExtensions: ['mkv'] });

  it('routes on the MIME type first', () => {
    assert.equal(isVideoFile(config, makeVideoFile(Buffer.alloc(0))), true);
    assert.equal(isVideoFile(config, makeImageFile(Buffer.alloc(0))), false);
  });

  it('routes a configured extension even when the MIME type is generic', () => {
    const file = makeVideoFile(Buffer.alloc(0), {
      name: 'clip.mkv',
      ext: '.MKV',
      mime: 'application/octet-stream',
    });
    assert.equal(isVideoFile(config, file), true);
  });

  it('leaves an unconfigured extension with a generic MIME type to the fallback', () => {
    const file = makeVideoFile(Buffer.alloc(0), {
      name: 'clip.ts',
      ext: '.ts',
      mime: 'application/octet-stream',
    });
    assert.equal(isVideoFile(config, file), false);
  });
});

describe('init', () => {
  it('refuses to boot without an API key', () => {
    assert.throws(() => init({ fallbackProvider: createFallbackStub() }), /apiKey is required/);
  });

  it('passes the fallback options straight to the fallback provider', async () => {
    const { fallback } = await harness();
    assert.deepEqual(fallback.initOptions, { sizeLimit: 1_000_000 });
  });

  it('refuses a fallback that cannot delete', () => {
    assert.throws(
      () =>
        init({
          apiKey: 'ak_secret',
          fallbackProvider: { init: () => ({ upload: async () => {} }) },
        }),
      /does not implement delete\(\)/,
    );
  });
});

describe('routing', () => {
  it('sends a video through the multipart RPCs and never to the fallback', async () => {
    const { server, fallback, provider } = await harness();
    const bytes = pattern(PART + 2048);
    const file = makeVideoFile(bytes);
    file.stream = chunkedStream(bytes, 8192);

    await provider.uploadStream!(file);

    assert.equal(fallback.streamUploads.length, 0);
    assert.equal(fallback.uploads.length, 0);
    assert.equal(server.callsTo('VideoService/CreateMultipartUpload').length, 1);

    const metadata = providerMetadata(file)!;
    assert.deepEqual(server.uploaded.get(metadata.video_id), bytes);
  });

  it('sends an image straight to the fallback and calls no RPC', async () => {
    const { server, fallback, provider } = await harness();
    const bytes = pattern(4096);
    const file = makeImageFile(bytes);
    file.stream = chunkedStream(bytes, 1024);

    await provider.uploadStream!(file);

    assert.equal(fallback.streamUploads.length, 1);
    assert.equal(file.url, '/uploads/photo_abc123.png');
    assert.equal(file.provider_metadata, undefined);
    assert.equal(server.calls.length, 0);
  });

  it('adapts a buffer for a fallback that only implements uploadStream', async () => {
    const server = await startMockServer();
    servers.push(server);
    const fallback = createFallbackStub({ withUpload: false });
    const provider = init({
      apiKey: 'ak_secret',
      baseUrl: server.baseUrl,
      appId: 'app_x',
      fallbackProvider: fallback,
    });

    const bytes = pattern(512);
    const file = makeImageFile(bytes);
    file.buffer = bytes;

    await provider.upload!(file);

    assert.equal(fallback.streamUploads.length, 1);
    assert.equal(file.stream, undefined, 'the synthetic stream is cleaned up');
  });

  it('adapts a stream for a fallback that only implements upload', async () => {
    const server = await startMockServer();
    servers.push(server);
    const fallback = createFallbackStub({ withUploadStream: false });
    const provider = init({
      apiKey: 'ak_secret',
      baseUrl: server.baseUrl,
      appId: 'app_x',
      fallbackProvider: fallback,
    });

    const bytes = pattern(512);
    const file = makeImageFile(bytes);
    file.stream = Readable.from([bytes]);

    await provider.uploadStream!(file);

    assert.equal(fallback.uploads.length, 1);
    assert.equal(file.buffer, undefined, 'the materialised buffer is cleaned up');
  });
});

describe('url composition and metadata', () => {
  it('writes the player page URL and the video/job ids', async () => {
    const { provider } = await harness();
    const bytes = pattern(2048);
    const file = makeVideoFile(bytes);
    file.buffer = bytes;

    await provider.upload!(file);

    const metadata = providerMetadata(file)!;
    assert.equal(metadata.provider, 'transcodely');
    assert.match(metadata.video_id, /^vid_/);
    assert.match(metadata.job_id!, /^job_/);
    assert.equal(metadata.status, 'processing');
    assert.equal(metadata.url_kind, 'player');
    assert.equal(metadata.url_pending, undefined);
    assert.equal(file.url, `https://play.transcodely.com/v/${metadata.video_id}`);
  });

  it('flags the record pending when HLS was asked for and the video is still processing', async () => {
    const { provider } = await harness({}, { playbackUrlKind: 'hls', private: true });
    const bytes = pattern(2048);
    const file = makeVideoFile(bytes);
    file.buffer = bytes;

    await provider.upload!(file);

    const metadata = providerMetadata(file)!;
    assert.equal(metadata.url_kind, 'hls');
    assert.equal(metadata.url_pending, true);
    assert.equal(file.url, `https://play.transcodely.com/v/${metadata.video_id}`);
  });
});

describe('delete', () => {
  it('deletes the hosted video through the video RPC', async () => {
    const { server, fallback, provider } = await harness();
    const bytes = pattern(2048);
    const file = makeVideoFile(bytes);
    file.buffer = bytes;
    await provider.upload!(file);

    const videoId = providerMetadata(file)!.video_id;
    await provider.delete!(file);

    assert.deepEqual(server.deleted, [videoId]);
    assert.equal(fallback.deletes.length, 0);
  });

  it('treats an already-deleted video as deleted', async () => {
    const { provider } = await harness();
    const file = makeVideoFile(Buffer.alloc(0));
    file.provider_metadata = {
      provider: 'transcodely',
      video_id: 'vid_gone',
      job_id: null,
      status: 'processing',
      url_kind: 'player',
    };

    await provider.delete!(file);
  });

  it('sends a file with no provider metadata to the fallback', async () => {
    const { server, fallback, provider } = await harness();
    const file = makeImageFile(pattern(128));

    await provider.delete!(file);

    assert.equal(fallback.deletes.length, 1);
    assert.equal(server.calls.length, 0);
  });

  it('propagates a real API failure instead of swallowing it', async () => {
    const { provider } = await harness({
      failures: {
        'VideoService/Delete': { status: 403, code: 'permission_denied', message: 'not your app' },
      },
    });
    const file = makeVideoFile(Buffer.alloc(0));
    file.provider_metadata = {
      provider: 'transcodely',
      video_id: 'vid_other',
      job_id: null,
      status: 'ready',
      url_kind: 'player',
    };

    await assert.rejects(provider.delete!(file), (error: unknown) => {
      assert.ok(error instanceof TranscodelyUploadError);
      assert.equal(error.code, 'permission_denied');
      return true;
    });
  });
});

describe('checkFileSize', () => {
  it('refuses a video over the 5 GiB API ceiling even with no Strapi limit', async () => {
    const { provider } = await harness();
    const file = makeVideoFile(Buffer.alloc(0));
    file.sizeInBytes = 6 * 1024 * 1024 * 1024;

    assert.throws(() => provider.checkFileSize!(file, {}), /larger than the 5368709120-byte limit/);
  });

  it('applies the tighter of the Strapi limit and the API ceiling', async () => {
    const { provider } = await harness();
    const file = makeVideoFile(Buffer.alloc(0));
    file.sizeInBytes = 2_000_000;

    assert.throws(() => provider.checkFileSize!(file, { sizeLimit: 1_000_000 }), /larger than/);
    provider.checkFileSize!(file, { sizeLimit: 10_000_000 });
  });

  it('reads kilobytes when Strapi set no byte count', async () => {
    const { provider } = await harness();
    const file = makeVideoFile(Buffer.alloc(0));
    file.sizeInBytes = undefined;
    file.size = 6_000_000_000 / 1000;

    assert.throws(() => provider.checkFileSize!(file, {}), /larger than/);
  });

  it('accepts a video at exactly the ceiling', async () => {
    const { provider } = await harness();
    const file = makeVideoFile(Buffer.alloc(0));
    file.sizeInBytes = 5_368_709_120;

    provider.checkFileSize!(file, {});
  });

  it('delegates a non-video file to the fallback', async () => {
    const { provider } = await harness();
    const file = makeImageFile(Buffer.alloc(0));
    file.sizeInBytes = 6 * 1024 * 1024 * 1024;

    provider.checkFileSize!(file, {});
  });
});

describe('isPrivate and getSignedUrl', () => {
  it('is not private by default, because the player page URL is stable', async () => {
    const { provider } = await harness();
    assert.equal(provider.isPrivate!(), false);
  });

  it('is private when the app uses CDN token auth', async () => {
    const { provider } = await harness({}, { private: true, playbackUrlKind: 'hls' });
    assert.equal(provider.isPrivate!(), true);
  });

  it('re-reads the video to return a freshly signed manifest URL', async () => {
    const { server, provider } = await harness(
      {
        videos: {
          vid_ready: {
            id: 'vid_ready',
            app_id: 'app_k1l2m3n4o5',
            status: 'ready',
            visibility: 'private',
            playback_url: 'https://cdn.example.com/vid_ready/hls/master.m3u8?token=fresh',
          },
        },
      },
      { private: true, playbackUrlKind: 'hls' },
    );

    const file = makeVideoFile(Buffer.alloc(0), {
      url: 'https://play.transcodely.com/v/vid_ready',
      provider_metadata: {
        provider: 'transcodely',
        video_id: 'vid_ready',
        job_id: null,
        status: 'processing',
        url_kind: 'hls',
        url_pending: true,
      },
    });

    const signed = await provider.getSignedUrl!(file);

    assert.equal(signed.url, 'https://cdn.example.com/vid_ready/hls/master.m3u8?token=fresh');
    assert.equal(server.callsTo('VideoService/Get').length, 1);
  });

  it('keeps returning the player page while the video is still processing', async () => {
    const { provider } = await harness(
      {
        videos: {
          vid_busy: {
            id: 'vid_busy',
            app_id: 'app_k1l2m3n4o5',
            status: 'processing',
            visibility: 'private',
          },
        },
      },
      { private: true, playbackUrlKind: 'hls' },
    );

    const file = makeVideoFile(Buffer.alloc(0), {
      provider_metadata: {
        provider: 'transcodely',
        video_id: 'vid_busy',
        job_id: null,
        status: 'processing',
        url_kind: 'hls',
        url_pending: true,
      },
    });

    assert.deepEqual(await provider.getSignedUrl!(file), {
      url: 'https://play.transcodely.com/v/vid_busy',
    });
  });

  it('delegates signing of a non-video file to the fallback', async () => {
    const { fallback, provider } = await harness({}, { private: true, playbackUrlKind: 'hls' });
    const file = makeImageFile(Buffer.alloc(0), { url: '/uploads/photo_abc123.png' });

    const signed = await provider.getSignedUrl!(file);

    assert.equal(signed.url, '/uploads/photo_abc123.png?stub-signature=1');
    assert.equal(fallback.signed.length, 1);
  });
});
