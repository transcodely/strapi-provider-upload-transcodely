import { Readable } from 'node:stream';

import { MAX_UPLOAD_BYTES, resolveConfig } from './config';
import { TranscodelyClient } from './client';
import { TranscodelyUploadError, payloadTooLarge } from './errors';
import { initFallback } from './fallback';
import { playerPageUrl, resolveVideoUrl } from './urls';
import { uploadVideo } from './upload';
import type { ResolvedConfig, TranscodelyProviderOptions } from './config';
import type {
  CheckFileSizeOptions,
  StrapiFile,
  StrapiUploadProvider,
  TranscodelyProviderMetadata,
} from './types';

/** Reads the provider metadata this package wrote, if it wrote any. */
export function providerMetadata(file: StrapiFile): TranscodelyProviderMetadata | undefined {
  const metadata = file.provider_metadata;
  if (
    typeof metadata === 'object' &&
    metadata !== null &&
    typeof (metadata as { video_id?: unknown }).video_id === 'string'
  ) {
    return metadata as TranscodelyProviderMetadata;
  }
  return undefined;
}

/**
 * Decides whether a file is a video this provider should host.
 *
 * MIME type is the primary signal, because it is what Strapi derives from the
 * upload itself. Extensions are the escape hatch for containers a given Node
 * build types as `application/octet-stream` (`.mkv` and `.ts` are the usual
 * offenders).
 */
export function isVideoFile(config: ResolvedConfig, file: StrapiFile): boolean {
  const mime = (file.mime ?? '').toLowerCase();
  if (config.videoMimePrefixes.some((prefix) => prefix !== '' && mime.startsWith(prefix))) {
    return true;
  }
  const ext = (file.ext ?? '').toLowerCase();
  return ext !== '' && config.videoExtensions.includes(ext);
}

/**
 * Points out configurations that will produce URLs nobody can play.
 *
 * A warning rather than a boot failure: both combinations are legal, and an
 * operator mid-migration may hold one on purpose.
 */
export function configWarnings(config: ResolvedConfig): string[] {
  const warnings: string[] = [];
  if (config.visibility === 'private' && config.playbackUrlKind === 'player') {
    warnings.push(
      'visibility "private" with playbackUrlKind "player": the public player page returns 404 ' +
        'for private videos. Use playbackUrlKind "hls" with private: true.',
    );
  }
  if (config.playbackUrlKind === 'hls' && !config.private) {
    warnings.push(
      'playbackUrlKind "hls" without private: true: on an app with CDN token auth the manifest ' +
        'URL is signed and expires, and a stored copy stops working. Set private: true so ' +
        'Strapi asks for a fresh URL on every read.',
    );
  }
  return warnings;
}

/**
 * Hands a non-video file to the fallback provider.
 *
 * Strapi picks `uploadStream` over `upload` based on what the *outer* provider
 * implements — this one implements both, so a fallback that implements only the
 * other half would otherwise be called with the wrong payload present. Images
 * are small, so converting between the two is cheap and keeps any fallback
 * provider usable.
 */
async function delegate(
  fallback: StrapiUploadProvider,
  method: 'upload' | 'uploadStream',
  file: StrapiFile,
): Promise<void> {
  if (method === 'uploadStream') {
    if (typeof fallback.uploadStream === 'function') {
      await fallback.uploadStream(file);
      return;
    }
    if (typeof fallback.upload === 'function' && file.stream) {
      const chunks: Buffer[] = [];
      for await (const chunk of file.stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
      }
      file.buffer = Buffer.concat(chunks);
      try {
        await fallback.upload(file);
      } finally {
        delete file.buffer;
      }
      return;
    }
  } else {
    if (typeof fallback.upload === 'function') {
      await fallback.upload(file);
      return;
    }
    if (typeof fallback.uploadStream === 'function' && file.buffer) {
      file.stream = Readable.from(file.buffer);
      try {
        await fallback.uploadStream(file);
      } finally {
        delete file.stream;
      }
      return;
    }
  }

  throw new TranscodelyUploadError('The fallback upload provider cannot store this file', {
    code: 'fallback_provider_invalid',
  });
}

/**
 * Builds the Strapi upload provider.
 *
 * Called once, synchronously, when Strapi registers the upload plugin — so it
 * validates configuration and initialises the fallback provider here rather
 * than on first use.
 */
export function init(options: TranscodelyProviderOptions = {}): StrapiUploadProvider {
  const config = resolveConfig(options);
  for (const warning of configWarnings(config)) {
    process.emitWarning(`strapi-provider-upload-transcodely: ${warning}`);
  }

  const client = new TranscodelyClient(config);
  const fallback = initFallback(config.fallbackProvider, config.fallbackProviderOptions);

  /** Writes the video's URL and metadata onto the Strapi file record. */
  function applyVideo(file: StrapiFile, video: { id: string; [key: string]: unknown }): void {
    const resolved = resolveVideoUrl(config, video, video.id);
    const jobId = video.job_id;
    const metadata: TranscodelyProviderMetadata = {
      provider: 'transcodely',
      video_id: video.id,
      job_id: typeof jobId === 'string' && jobId !== '' ? jobId : null,
      status: typeof video.status === 'string' ? video.status : 'processing',
      url_kind: resolved.kind,
    };
    if (resolved.pending) {
      metadata.url_pending = true;
    }

    file.url = resolved.url;
    file.provider_metadata = metadata;

    // A freshly completed upload has no poster yet — the worker generates it
    // during the transcode — so this is normally skipped and `previewUrl` stays
    // empty. It fires for the paths that do hand back a ready video.
    const poster = video.poster_url;
    if (typeof poster === 'string' && poster !== '') {
      file.previewUrl = poster;
    }
  }

  return {
    async upload(file: StrapiFile): Promise<void> {
      if (!isVideoFile(config, file)) {
        await delegate(fallback, 'upload', file);
        return;
      }
      if (!file.buffer) {
        throw new TranscodelyUploadError(`No buffer was given for "${file.name}"`, {
          code: 'missing_payload',
        });
      }
      const { video } = await uploadVideo(config, client, file, { buffer: file.buffer });
      applyVideo(file, video);
    },

    /**
     * Strapi v5 prefers this over `upload` whenever a provider defines it, so
     * this is the path essentially every upload takes.
     *
     * The stream is consumed part by part and PUT as it is read — never spooled
     * to a temp file and never held in memory in full. That is possible because
     * Strapi hands over the exact byte count in `file.sizeInBytes`, which is
     * what `CreateMultipartUpload` needs to declare `total_parts`; the actual
     * bytes read are checked against it before the upload is completed.
     */
    async uploadStream(file: StrapiFile): Promise<void> {
      if (!isVideoFile(config, file)) {
        await delegate(fallback, 'uploadStream', file);
        return;
      }
      if (!file.stream) {
        throw new TranscodelyUploadError(`No stream was given for "${file.name}"`, {
          code: 'missing_payload',
        });
      }
      const { video } = await uploadVideo(config, client, file, { stream: file.stream });
      applyVideo(file, video);
    },

    async delete(file: StrapiFile): Promise<void> {
      const metadata = providerMetadata(file);
      if (metadata === undefined) {
        // No metadata means this record was not stored as a hosted video —
        // an image, or a file that predates this provider. The fallback owns
        // it, and the local provider treats a missing file as already deleted.
        await fallback.delete?.(file);
        return;
      }

      try {
        await client.deleteVideo(metadata.video_id);
      } catch (error) {
        // Deleting a video that is already gone is the outcome Strapi wants.
        if (error instanceof TranscodelyUploadError && error.statusCode === 404) {
          return;
        }
        throw error;
      }
    },

    /**
     * Rejects a file Transcodely would refuse anyway, before any bytes move.
     *
     * Strapi's own limit (`plugin::upload.sizeLimit`) still applies to every
     * file; this only adds the API's hard 5 GiB ceiling for videos.
     */
    checkFileSize(file: StrapiFile, options?: CheckFileSizeOptions): void {
      if (!isVideoFile(config, file)) {
        fallback.checkFileSize?.(file, options);
        return;
      }

      // `file.size` is kilobytes; `sizeLimit` is bytes.
      const bytes =
        typeof file.sizeInBytes === 'number' && file.sizeInBytes > 0
          ? file.sizeInBytes
          : Math.round((file.size ?? 0) * 1000);

      const limit = Math.min(options?.sizeLimit ?? MAX_UPLOAD_BYTES, MAX_UPLOAD_BYTES);
      if (bytes > limit) {
        throw payloadTooLarge(
          `${file.name} is larger than the ${limit}-byte limit for video uploads`,
        );
      }
    },

    /**
     * True when stored URLs must not be served as-is.
     *
     * Set `private: true` for an app with CDN token auth enabled, or one whose
     * videos are created `private`: in both cases the usable URL is signed and
     * expiring, and Strapi has to ask for a fresh one on every read. It is off
     * by default because the default `playbackUrlKind` is the player page,
     * which is a stable URL that re-signs itself on load.
     */
    isPrivate(): boolean {
      return config.private;
    },

    /**
     * Returns a URL that works right now.
     *
     * Strapi calls this for every read while `isPrivate()` is true, which is
     * also what lets a record written while the video was still processing pick
     * up its real manifest URL once the video is ready.
     */
    async getSignedUrl(file: StrapiFile): Promise<{ url: string }> {
      const metadata = providerMetadata(file);
      if (metadata === undefined) {
        const signed = await fallback.getSignedUrl?.(file);
        return { url: signed?.url ?? file.url ?? '' };
      }

      const video = await client.getVideo(metadata.video_id);
      const resolved = resolveVideoUrl(config, video, metadata.video_id);
      if (resolved.pending && config.playbackUrlKind === 'hls') {
        // Still processing: the player page is the only URL that resolves.
        return { url: playerPageUrl(config, metadata.video_id) };
      }
      return { url: resolved.url };
    },
  };
}
