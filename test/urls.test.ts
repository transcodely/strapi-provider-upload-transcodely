import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveConfig } from '../src/config';
import { playerPageUrl, resolveVideoUrl } from '../src/urls';

const base = { apiKey: 'ak_test', playerBaseUrl: 'https://play.transcodely.com' };

describe('playerPageUrl', () => {
  it('matches the API’s own embed URL construction', () => {
    const config = resolveConfig(base);
    assert.equal(
      playerPageUrl(config, 'vid_a1b2c3d4e5f6g7'),
      'https://play.transcodely.com/v/vid_a1b2c3d4e5f6g7',
    );
  });

  it('tolerates a trailing slash in the configured base', () => {
    const config = resolveConfig({ ...base, playerBaseUrl: 'https://play.example.com/' });
    assert.equal(playerPageUrl(config, 'vid_x'), 'https://play.example.com/v/vid_x');
  });
});

describe('resolveVideoUrl', () => {
  it('prefers the API’s embed_url when the video is ready', () => {
    const config = resolveConfig(base);
    const resolved = resolveVideoUrl(
      config,
      { id: 'vid_x', embed_url: 'https://play.transcodely.com/v/vid_x' },
      'vid_x',
    );
    assert.deepEqual(resolved, {
      url: 'https://play.transcodely.com/v/vid_x',
      kind: 'player',
      pending: false,
    });
  });

  it('composes the player URL while the video is still processing', () => {
    const config = resolveConfig(base);
    const resolved = resolveVideoUrl(config, { id: 'vid_x', status: 'processing' }, 'vid_x');
    assert.equal(resolved.url, 'https://play.transcodely.com/v/vid_x');
    assert.equal(resolved.pending, false);
  });

  it('returns the HLS manifest when asked for it and it exists', () => {
    const config = resolveConfig({ ...base, playbackUrlKind: 'hls', private: true });
    const resolved = resolveVideoUrl(
      config,
      { id: 'vid_x', playback_url: 'https://cdn.example.com/vid_x/hls/master.m3u8?token=abc' },
      'vid_x',
    );
    assert.deepEqual(resolved, {
      url: 'https://cdn.example.com/vid_x/hls/master.m3u8?token=abc',
      kind: 'hls',
      pending: false,
    });
  });

  it('falls back to the player page and flags it pending when no manifest exists yet', () => {
    const config = resolveConfig({ ...base, playbackUrlKind: 'hls', private: true });
    const resolved = resolveVideoUrl(config, { id: 'vid_x', status: 'processing' }, 'vid_x');
    assert.equal(resolved.url, 'https://play.transcodely.com/v/vid_x');
    assert.equal(resolved.kind, 'hls');
    assert.equal(resolved.pending, true);
  });

  it('composes from the id when the API returned no video at all', () => {
    const config = resolveConfig(base);
    assert.equal(resolveVideoUrl(config, undefined, 'vid_x').url, 'https://play.transcodely.com/v/vid_x');
  });
});
