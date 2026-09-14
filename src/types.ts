import type { Readable } from 'node:stream';

/**
 * The file object Strapi hands an upload provider.
 *
 * Two size fields exist and they are NOT the same unit. `size` is kilobytes
 * (`@strapi/utils` `bytesToKbytes`, which divides by 1000 and rounds to two
 * decimals) while `sizeInBytes` is the exact byte count. Anything that has to
 * be byte-exact — the multipart part count, above all — must read
 * `sizeInBytes`.
 */
export interface StrapiFile {
  name: string;
  hash: string;
  ext?: string;
  mime: string;
  /** Size in KILOBYTES. See the note above. */
  size: number;
  /** Exact size in bytes. Set by Strapi v5 for every uploaded file. */
  sizeInBytes?: number;
  url?: string;
  previewUrl?: string;
  path?: string;
  provider?: string;
  provider_metadata?: Record<string, unknown>;
  stream?: Readable;
  buffer?: Buffer;
  formats?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Options Strapi passes to `checkFileSize`. `sizeLimit` is in bytes. */
export interface CheckFileSizeOptions {
  sizeLimit?: number;
}

/**
 * The subset of the Strapi upload-provider contract this package implements or
 * delegates to. Every method is optional because a fallback provider may
 * implement only part of it.
 */
export interface StrapiUploadProvider {
  upload?(file: StrapiFile): Promise<void>;
  uploadStream?(file: StrapiFile): Promise<void>;
  delete?(file: StrapiFile): Promise<unknown>;
  checkFileSize?(file: StrapiFile, options?: CheckFileSizeOptions): void;
  getSignedUrl?(file: StrapiFile): Promise<{ url: string }>;
  isPrivate?(): boolean;
}

/** A provider module, as `require()` returns it. */
export interface StrapiUploadProviderModule {
  init(options?: Record<string, unknown>): StrapiUploadProvider;
}

/** The shape this package's `provider_metadata` takes for a hosted video. */
export interface TranscodelyProviderMetadata {
  /** Marks the record as owned by this provider, so `delete` can route on it. */
  provider: 'transcodely';
  video_id: string;
  job_id: string | null;
  status: string;
  /** Which URL shape `file.url` was written with. */
  url_kind: 'player' | 'hls';
  /**
   * True when `file.url` holds a player-page URL even though `playbackUrlKind`
   * is `hls`, because the video was still processing and had no manifest yet.
   */
  url_pending?: boolean;
  [key: string]: unknown;
}
