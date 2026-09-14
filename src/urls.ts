import type { ResolvedConfig } from './config';
import type { VideoResource } from './client';

/**
 * The player-page URL for a video.
 *
 * This is the one URL that can be written the instant the video record exists:
 * the page is addressed by video id, so it needs nothing from the transcode,
 * and it stays valid for the life of the video. On a token-auth app the page
 * mints its own signed manifest URL on every load, so it never expires either.
 * That is why `player` is the default `playbackUrlKind`.
 *
 * It is not *playable* until the video is ready — until then the page answers
 * 404 with the branded "unavailable" body. It starts playing on its own once
 * the transcode lands, with no write-back here.
 *
 * Mirrors the API's own `embed_url` construction (`{playerBaseUrl}/v/{id}`).
 */
export function playerPageUrl(config: ResolvedConfig, videoId: string): string {
  return `${config.playerBaseUrl}/v/${videoId}`;
}

export interface ResolvedUrl {
  url: string;
  kind: 'player' | 'hls';
  /** True when `hls` was asked for but no manifest URL existed yet. */
  pending: boolean;
}

/**
 * Picks the URL to store in `file.url` for a video.
 *
 * `hls` returns the HLS manifest (`playback_url`), which the API populates only
 * once the video is `ready` — and which is signed and expiring on a token-auth
 * app. Right after an upload the video is `processing`, so there is nothing to
 * return; rather than block the editor's save, fall back to the player page and
 * mark the record `url_pending` so the situation is legible in the database.
 * Setting `private: true` is what makes Strapi re-resolve it later.
 */
export function resolveVideoUrl(
  config: ResolvedConfig,
  video: VideoResource | undefined,
  videoId: string,
): ResolvedUrl {
  if (config.playbackUrlKind === 'hls') {
    const manifest = video?.playback_url;
    if (typeof manifest === 'string' && manifest !== '') {
      return { url: manifest, kind: 'hls', pending: false };
    }
    return { url: playerPageUrl(config, videoId), kind: 'hls', pending: true };
  }

  // `embed_url` is the API's own player-page URL. It is absent for private
  // videos and for videos that are not ready yet, in which case the composed
  // URL is the same string the API would have returned.
  const embed = video?.embed_url;
  if (typeof embed === 'string' && embed !== '') {
    return { url: embed, kind: 'player', pending: false };
  }
  return { url: playerPageUrl(config, videoId), kind: 'player', pending: false };
}
