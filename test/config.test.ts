import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_BASE_URL,
  DEFAULT_PART_SIZE_BYTES,
  DEFAULT_PLAYER_BASE_URL,
  MIN_PART_SIZE_BYTES,
  normalizeBaseUrl,
  resolveConfig,
} from '../src/config';
import { configWarnings } from '../src/provider';

describe('resolveConfig', () => {
  it('defaults everything an operator did not set', () => {
    const config = resolveConfig({ apiKey: 'ak_test' });

    assert.equal(config.baseUrl, DEFAULT_BASE_URL);
    assert.equal(config.playerBaseUrl, DEFAULT_PLAYER_BASE_URL);
    assert.equal(config.playbackUrlKind, 'player');
    assert.equal(config.private, false);
    assert.equal(config.partSizeBytes, DEFAULT_PART_SIZE_BYTES);
    assert.equal(config.uploadConcurrency, 3);
    assert.equal(config.fallbackProvider, 'local');
    assert.deepEqual(config.videoMimePrefixes, ['video/']);
  });

  it('leaves visibility unset so the app default applies', () => {
    assert.equal(resolveConfig({ apiKey: 'ak_test' }).visibility, undefined);
    assert.equal(resolveConfig({ apiKey: 'ak_test', visibility: 'public' }).visibility, 'public');
  });

  it('requires an API key', () => {
    assert.throws(() => resolveConfig({}), /apiKey is required/);
    assert.throws(() => resolveConfig({ apiKey: '   ' }), /apiKey is required/);
  });

  it('rejects a malformed app id', () => {
    assert.throws(() => resolveConfig({ apiKey: 'ak_test', appId: 'nope' }), /does not look like/);
    assert.equal(resolveConfig({ apiKey: 'ak_test', appId: 'app_k1l2m3n4o5' }).appId, 'app_k1l2m3n4o5');
  });

  it('rejects an unknown visibility or url kind', () => {
    assert.throws(
      () => resolveConfig({ apiKey: 'ak_test', visibility: 'secret' as never }),
      /visibility must be one of/,
    );
    assert.throws(
      () => resolveConfig({ apiKey: 'ak_test', playbackUrlKind: 'dash' as never }),
      /playbackUrlKind must be one of/,
    );
  });

  it("rejects a part size below S3's 5 MiB minimum", () => {
    assert.throws(
      () => resolveConfig({ apiKey: 'ak_test', partSizeBytes: MIN_PART_SIZE_BYTES - 1 }),
      /at least 5242880/,
    );
  });

  it('normalizes base URLs and refuses non-http schemes', () => {
    assert.equal(normalizeBaseUrl('https://api.example.com/', DEFAULT_BASE_URL), 'https://api.example.com');
    assert.equal(normalizeBaseUrl('', DEFAULT_BASE_URL), DEFAULT_BASE_URL);
    assert.throws(() => normalizeBaseUrl('ftp://x', DEFAULT_BASE_URL), /not an http\(s\) URL/);
    assert.throws(() => normalizeBaseUrl('not a url', DEFAULT_BASE_URL), /not a valid URL/);
  });

  it('refuses plain HTTP off loopback, because the API key rides every request', () => {
    assert.throws(() => normalizeBaseUrl('http://api.example.com', DEFAULT_BASE_URL), /plain HTTP/);
    // A local mock or dev stack stays usable.
    assert.equal(normalizeBaseUrl('http://127.0.0.1:8080', DEFAULT_BASE_URL), 'http://127.0.0.1:8080');
    assert.equal(normalizeBaseUrl('http://localhost:1337', DEFAULT_BASE_URL), 'http://localhost:1337');
  });

  it('treats the containers that sniff as octet-stream as video by default', () => {
    const config = resolveConfig({ apiKey: 'ak_test' });
    assert.deepEqual(config.videoExtensions, ['.mkv', '.m2ts', '.mts', '.ts', '.mxf']);
  });

  it('normalizes configured video extensions to a leading dot, lowercased', () => {
    const config = resolveConfig({ apiKey: 'ak_test', videoExtensions: ['MKV', '.TS', '  '] });
    assert.deepEqual(config.videoExtensions, ['.mkv', '.ts']);
  });
});

describe('configWarnings', () => {
  it('warns that a private video has no playable player page', () => {
    const warnings = configWarnings(
      resolveConfig({ apiKey: 'ak_test', visibility: 'private', playbackUrlKind: 'player' }),
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /returns 404 for private videos/);
  });

  it('warns that a stored HLS URL expires without private: true', () => {
    const warnings = configWarnings(resolveConfig({ apiKey: 'ak_test', playbackUrlKind: 'hls' }));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /signed and expires/);
  });

  it('stays quiet for the recommended combinations', () => {
    assert.deepEqual(configWarnings(resolveConfig({ apiKey: 'ak_test' })), []);
    assert.deepEqual(
      configWarnings(resolveConfig({ apiKey: 'ak_test', playbackUrlKind: 'hls', private: true })),
      [],
    );
  });
});
