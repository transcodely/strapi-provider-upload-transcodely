import { TranscodelyUploadError } from './errors';
import type { StrapiUploadProviderModule } from './types';

/** Hard ceiling the API enforces on a single upload: 5 GiB. */
export const MAX_UPLOAD_BYTES = 5_368_709_120;

/** The API's own default part size, and the one this provider sends. */
export const DEFAULT_PART_SIZE_BYTES = 25 * 1024 * 1024;

/** S3's minimum part size for every part except the last. */
export const MIN_PART_SIZE_BYTES = 5 * 1024 * 1024;

/**
 * Calendar API version this provider is written against.
 *
 * An unpinned request resolves to whatever the API considers current, so
 * pinning is what keeps a future breaking date from changing the wire shape
 * under a running Strapi.
 */
export const API_VERSION = '2026-05-03';

export const DEFAULT_BASE_URL = 'https://api.transcodely.com';
export const DEFAULT_PLAYER_BASE_URL = 'https://play.transcodely.com';

export type PlaybackUrlKind = 'player' | 'hls';
export type Visibility = 'public' | 'unlisted' | 'private';

/** What an operator writes in `config/plugins.js` under `providerOptions`. */
export interface TranscodelyProviderOptions {
  /** Secret API key (`ak_…`). Required. */
  apiKey?: string;
  /** API base URL. Defaults to https://api.transcodely.com */
  baseUrl?: string;
  /** Player base URL used to compose player-page URLs. */
  playerBaseUrl?: string;
  /**
   * App the videos are created under (`app_…`).
   *
   * Usually unnecessary. The upload RPCs still require an `app_id` today, but
   * the provider recovers by reading the app off the caller's most recent job;
   * only an account with no jobs at all has to set this. From api 5.20.0 the
   * RPCs resolve the app from the key and nothing is probed, leaving this as a
   * way to pin a specific app.
   */
  appId?: string;
  /** Visibility for created videos. Defaults to `unlisted`. */
  visibility?: Visibility;
  /** Which URL lands in `file.url`. Defaults to `player`. */
  playbackUrlKind?: PlaybackUrlKind;
  /**
   * Set true when the app has CDN token auth enabled, so Strapi asks the
   * provider for a fresh signed URL on every read instead of serving a stored
   * one that will expire.
   */
  private?: boolean;
  /** Extra MIME prefixes treated as video, beyond `video/`. */
  videoMimePrefixes?: string[];
  /**
   * File extensions treated as video regardless of MIME type, with or without
   * the leading dot. Replaces the default list, it does not add to it.
   */
  videoExtensions?: string[];
  /** Part size for multipart uploads. Defaults to 25 MiB, minimum 5 MiB. */
  partSizeBytes?: number;
  /** How many parts to PUT concurrently. Defaults to 3. */
  uploadConcurrency?: number;
  /** Per-request timeout in milliseconds. Defaults to 60000 for RPCs. */
  requestTimeoutMs?: number;
  /** Timeout for a single part PUT. Defaults to 300000. */
  partTimeoutMs?: number;
  /** Attach an animated hover preview to the managed transcode. Free. */
  hoverPreviews?: boolean;
  /** Generate AI captions inline with the transcode. Billed per source minute. */
  autoCaptions?: boolean;
  /** Preset id or slug driving the encode instead of the app's auto-profile. */
  preset?: string;
  /** Provider handling non-video files: a module name, or a required module. */
  fallbackProvider?: string | StrapiUploadProviderModule;
  /** Options passed to the fallback provider's `init`. */
  fallbackProviderOptions?: Record<string, unknown>;
  /** Injected in tests. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

/** The same options after defaulting and validation. */
export interface ResolvedConfig {
  apiKey: string;
  baseUrl: string;
  playerBaseUrl: string;
  appId: string;
  visibility?: Visibility;
  playbackUrlKind: PlaybackUrlKind;
  private: boolean;
  videoMimePrefixes: string[];
  videoExtensions: string[];
  partSizeBytes: number;
  uploadConcurrency: number;
  requestTimeoutMs: number;
  partTimeoutMs: number;
  hoverPreviews: boolean;
  autoCaptions: boolean;
  preset?: string;
  fallbackProvider: string | StrapiUploadProviderModule;
  fallbackProviderOptions: Record<string, unknown>;
  fetch: typeof fetch;
}

const VISIBILITIES: Visibility[] = ['public', 'unlisted', 'private'];
const URL_KINDS: PlaybackUrlKind[] = ['player', 'hls'];

/**
 * Containers whose MIME type cannot be relied on to start with `video/`.
 *
 * An empty default was the wrong call: a file that sniffs as
 * `application/octet-stream` lands silently on the disk provider and the editor
 * gets a broken link with no error anywhere. These are the extensions where
 * that actually happens.
 */
const DEFAULT_VIDEO_EXTENSIONS = ['.mkv', '.m2ts', '.mts', '.ts', '.mxf'];

function configError(message: string): TranscodelyUploadError {
  return new TranscodelyUploadError(`strapi-provider-upload-transcodely: ${message}`, {
    code: 'invalid_provider_config',
  });
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Validates a base URL and strips its trailing slash so URLs compose by
 * concatenation.
 *
 * Plain HTTP is refused off-loopback: the API key rides an `Authorization`
 * header on every request, so a typo'd or deliberately plaintext `baseUrl`
 * would put a secret credential on the wire in the clear. Loopback stays
 * allowed for a local mock or a dev stack, which is also what this package's
 * own tests run against.
 */
export function normalizeBaseUrl(value: string | undefined, fallback: string): string {
  const raw = (value ?? '').trim();
  const base = raw === '' ? fallback : raw;

  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    throw configError(`"${base}" is not a valid URL`);
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw configError(`"${base}" is not an http(s) URL`);
  }
  if (parsed.protocol === 'http:' && !LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw configError(
      `"${base}" is plain HTTP. The API key is sent on every request, so an https:// URL is ` +
        'required for any host but loopback.',
    );
  }

  return base.replace(/\/+$/, '');
}

function normalizeExtension(ext: string): string {
  const trimmed = ext.trim().toLowerCase();
  if (trimmed === '') {
    return '';
  }
  return trimmed.startsWith('.') ? trimmed : `.${trimmed}`;
}

function positiveInt(value: unknown, fallback: number, label: string): number {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw configError(`${label} must be a positive number`);
  }
  return Math.floor(value);
}

/**
 * Validates and defaults the operator's `providerOptions`.
 *
 * Everything that can be wrong is caught here, at Strapi boot, rather than on
 * the first upload — a provider that boots and then fails on every video is
 * much harder to diagnose than one that refuses to boot.
 */
export function resolveConfig(options: TranscodelyProviderOptions = {}): ResolvedConfig {
  const apiKey = (options.apiKey ?? '').trim();
  if (apiKey === '') {
    throw configError('apiKey is required (a secret ak_… key)');
  }

  const appId = (options.appId ?? '').trim();
  if (appId !== '' && !/^app_[a-zA-Z0-9_-]+$/.test(appId)) {
    throw configError(`appId "${appId}" does not look like an app id (app_…)`);
  }

  const visibility = options.visibility;
  if (visibility !== undefined && !VISIBILITIES.includes(visibility)) {
    throw configError(`visibility must be one of ${VISIBILITIES.join(', ')}`);
  }

  const playbackUrlKind = options.playbackUrlKind ?? 'player';
  if (!URL_KINDS.includes(playbackUrlKind)) {
    throw configError(`playbackUrlKind must be one of ${URL_KINDS.join(', ')}`);
  }

  const partSizeBytes = positiveInt(options.partSizeBytes, DEFAULT_PART_SIZE_BYTES, 'partSizeBytes');
  if (partSizeBytes < MIN_PART_SIZE_BYTES) {
    throw configError(`partSizeBytes must be at least ${MIN_PART_SIZE_BYTES} (5 MiB)`);
  }

  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw configError('global fetch is unavailable; Node 18.17+ is required');
  }

  return {
    apiKey,
    baseUrl: normalizeBaseUrl(options.baseUrl, DEFAULT_BASE_URL),
    playerBaseUrl: normalizeBaseUrl(options.playerBaseUrl, DEFAULT_PLAYER_BASE_URL),
    appId,
    visibility,
    playbackUrlKind,
    private: options.private === true,
    videoMimePrefixes: ['video/', ...(options.videoMimePrefixes ?? [])].map((p) =>
      p.trim().toLowerCase(),
    ),
    videoExtensions: (options.videoExtensions ?? DEFAULT_VIDEO_EXTENSIONS)
      .map(normalizeExtension)
      .filter((e) => e !== ''),
    partSizeBytes,
    uploadConcurrency: positiveInt(options.uploadConcurrency, 3, 'uploadConcurrency'),
    requestTimeoutMs: positiveInt(options.requestTimeoutMs, 60_000, 'requestTimeoutMs'),
    partTimeoutMs: positiveInt(options.partTimeoutMs, 300_000, 'partTimeoutMs'),
    hoverPreviews: options.hoverPreviews === true,
    autoCaptions: options.autoCaptions === true,
    preset: options.preset?.trim() === '' ? undefined : options.preset,
    fallbackProvider: options.fallbackProvider ?? 'local',
    fallbackProviderOptions: options.fallbackProviderOptions ?? {},
    fetch: fetchImpl,
  };
}
