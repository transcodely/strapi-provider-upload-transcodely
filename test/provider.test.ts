import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { after, describe, it } from 'node:test';

import { init, isVideoFile, providerMetadata } from '../src/provider';
import { resolveConfig } from '../src/config';
import { TranscodelyUploadError } from '../src/errors';
import { createFallbackStub } from './helpers/fallback-stub';
import { chunkedStream, makeImageFile, makeVideoFile, pattern } from './helpers/file';
import { startMockServer } from './helpers/mock-server';
import type { FallbackStub, FallbackStubOptions } from './helpers/fallback-stub';
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
  stubOptions: FallbackStubOptions = {},
): Promise<{ server: MockServer; fallback: FallbackStub; provider: ReturnType<typeof init> }> {
  const server = await startMockServer(serverOptions);
  servers.push(server);
  // withCheckFileSize defaults to false: the recommended aws-s3 fallback does
  // not implement it, and that is the shape the provider has to survive.
  const fallback = createFallbackStub({ withSignedUrl: true, ...stubOptions });
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

  it('writes the MP4 hover preview into formats.thumbnail, the only thing the admin card plays', async () => {
    // The media-library card renders <video src={createAssetUrl(asset, true)}>,
    // and that helper prefers formats.thumbnail.url. A poster JPEG there would
    // not play; the animated hover preview is a progressive MP4, and free.
    const { provider } = await harness({
      completedVideoFields: {
        hover_preview_mp4_url: 'https://cdn.example.com/vid_x/preview.mp4',
        poster_url: 'https://cdn.example.com/vid_x/poster.jpg',
      },
    });
    const bytes = pattern(2048);
    const file = makeVideoFile(bytes);
    file.buffer = bytes;

    await provider.upload!(file);

    const thumbnail = (file.formats as any)?.thumbnail;
    assert.equal(thumbnail?.url, 'https://cdn.example.com/vid_x/preview.mp4');
    assert.equal(thumbnail?.mime, 'video/mp4');
    // Stamped so getSignedUrl routes the format to the video side rather than
    // handing a Transcodely key to the fallback provider.
    assert.equal((thumbnail?.provider_metadata as any)?.video_id, providerMetadata(file)!.video_id);
    assert.equal(file.previewUrl, 'https://cdn.example.com/vid_x/poster.jpg');
  });

  it('writes no thumbnail format when the transcode has produced nothing yet', async () => {
    const { provider } = await harness();
    const bytes = pattern(2048);
    const file = makeVideoFile(bytes);
    file.buffer = bytes;

    await provider.upload!(file);

    assert.equal(file.formats, undefined);
    assert.equal(file.previewUrl, undefined);
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

  it('keeps the API ceiling even when Strapi allows more than 5 GiB', async () => {
    // Pins the Math.min clamp: without it a 10 GiB sizeLimit would let a 6 GiB
    // video through to an API that refuses it.
    const { provider } = await harness();
    const file = makeVideoFile(Buffer.alloc(0));
    file.sizeInBytes = 6 * 1024 * 1024 * 1024;

    assert.throws(
      () => provider.checkFileSize!(file, { sizeLimit: 10 * 1024 * 1024 * 1024 }),
      /larger than the 5368709120-byte limit/,
    );
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

  it('still enforces the Strapi limit when the fallback has no checkFileSize', async () => {
    // This is the aws-s3 shape. Defining checkFileSize at all shadows Strapi's
    // own prototype check, so delegating into a provider that lacks the method
    // would turn the limit off for every non-video.
    const { fallback, provider } = await harness();
    assert.equal(typeof fallback.init({}).checkFileSize, 'undefined', 'stub models aws-s3');

    const file = makeImageFile(Buffer.alloc(0));
    file.sizeInBytes = 50 * 1024 * 1024;
    file.size = (50 * 1024 * 1024) / 1000;

    assert.throws(
      () => provider.checkFileSize!(file, { sizeLimit: 1024 * 1024 }),
      /exceeds the 1048576-byte upload size limit/,
    );
    provider.checkFileSize!(file, { sizeLimit: 100 * 1024 * 1024 });
    provider.checkFileSize!(file, {});
  });

  it('measures a non-video the way Strapi does, off `size` rather than `sizeInBytes`', async () => {
    // Standing in for Strapi's own rule must not change which files pass. The
    // two fields are fed inconsistently here on purpose: `size` is the one
    // `kbytesToBytes` reads, so it is the one that must decide.
    const { provider } = await harness();
    const file = makeImageFile(Buffer.alloc(0));
    file.size = (50 * 1024 * 1024) / 1000;
    file.sizeInBytes = 4096;

    assert.throws(
      () => provider.checkFileSize!(file, { sizeLimit: 1024 * 1024 }),
      /exceeds the 1048576-byte upload size limit/,
    );
  });

  it('refuses a video when either size field is over the limit', async () => {
    const { provider } = await harness();
    const file = makeVideoFile(Buffer.alloc(0));
    file.size = (6 * 1024 * 1024 * 1024) / 1000;
    file.sizeInBytes = 4096;

    assert.throws(() => provider.checkFileSize!(file, {}), /larger than/);
  });

  it('hands a non-video to the fallback when the fallback does implement the check', async () => {
    const { fallback, provider } = await harness({}, {}, { withCheckFileSize: true });
    const file = makeImageFile(Buffer.alloc(0));
    file.sizeInBytes = 6 * 1024 * 1024 * 1024;

    provider.checkFileSize!(file, { sizeLimit: 1024 });

    assert.equal(fallback.sizeChecks.length, 1, 'the fallback was actually called');
    assert.equal(fallback.sizeChecks[0].file, file);
    assert.deepEqual(fallback.sizeChecks[0].options, { sizeLimit: 1024 });
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

  it('is private when the FALLBACK bucket is private, even if Transcodely is not', async () => {
    // Strapi has one global answer for the whole provider. Answering with the
    // Transcodely flag alone left a private aws-s3 bucket serving unsigned
    // image URLs that 403 for every viewer, with nothing logged.
    const { provider } = await harness({}, {}, { isPrivate: true });
    assert.equal(provider.isPrivate!(), true);
  });

  it('stays public when neither half is private', async () => {
    const { provider } = await harness({}, {}, { isPrivate: false });
    assert.equal(provider.isPrivate!(), false);
  });

  it('signs images through the fallback while leaving videos alone', async () => {
    // isPrivate is on only because of the fallback, so a video must not pay a
    // VideoService/Get per read for a URL that never needed signing.
    const { server, fallback, provider } = await harness({}, {}, { isPrivate: true });

    const image = makeImageFile(Buffer.alloc(0), { url: '/uploads/photo_abc123.png' });
    const signedImage = await provider.getSignedUrl!(image);
    assert.equal(signedImage.url, '/uploads/photo_abc123.png?stub-signature=1');
    assert.equal(fallback.signed.length, 1);

    const video = makeVideoFile(Buffer.alloc(0), {
      url: 'https://play.transcodely.com/v/vid_stable',
      provider_metadata: {
        provider: 'transcodely',
        video_id: 'vid_stable',
        job_id: null,
        status: 'ready',
        url_kind: 'player',
      },
    });
    const signedVideo = await provider.getSignedUrl!(video);
    assert.equal(signedVideo.url, 'https://play.transcodely.com/v/vid_stable');
    assert.equal(server.callsTo('VideoService/Get').length, 0, 'no RPC for an unsigned video');
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
