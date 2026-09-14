import { API_VERSION } from './config';
import { TranscodelyUploadError, describeApiError, formatApiError } from './errors';
import type { ResolvedConfig } from './config';

/**
 * Transcodely speaks Connect-RPC over plain JSON:
 *
 *   POST {baseUrl}/transcodely.v1.{Service}/{Method}
 *   Authorization: Bearer ak_…
 *   Content-Type: application/json
 *
 * Bodies are snake_case and enum values are simple lowercase strings
 * (`unlisted`, never `VIDEO_VISIBILITY_UNLISTED`). No protobuf runtime and no
 * HTTP client dependency: Node's built-in fetch carries all of it.
 */
export function rpcUrl(baseUrl: string, service: string, method: string): string {
  return `${baseUrl}/transcodely.v1.${service}/${method}`;
}

export interface UploadPart {
  part_number: number;
  upload_url: string;
}

export interface VideoResource {
  id: string;
  app_id?: string;
  status?: string;
  visibility?: string;
  job_id?: string | null;
  playback_url?: string;
  embed_url?: string;
  poster_url?: string;
  hover_preview_url?: string;
  hover_preview_mp4_url?: string;
  duration_seconds?: number;
  [key: string]: unknown;
}

export interface CreateMultipartUploadResult {
  video: VideoResource;
  upload_id: string;
  parts: UploadPart[];
}

/** Minimal Connect-RPC client for the handful of procedures this provider uses. */
export class TranscodelyClient {
  private readonly config: ResolvedConfig;
  private resolvedAppId: string;

  constructor(config: ResolvedConfig) {
    this.config = config;
    this.resolvedAppId = config.appId;
  }

  private async call<T>(service: string, method: string, body: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);

    let response: Response;
    try {
      response = await this.config.fetch(rpcUrl(this.config.baseUrl, service, method), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
          'Transcodely-Version': API_VERSION,
        },
        body: JSON.stringify(body ?? {}),
        signal: controller.signal,
      });
    } catch (cause) {
      throw new TranscodelyUploadError(
        `Transcodely ${service}.${method} could not be reached`,
        { code: 'unavailable', cause },
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let parsed: unknown = undefined;
    if (text !== '') {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
    }

    if (!response.ok) {
      const info = describeApiError(response.status, response.headers, parsed);
      throw new TranscodelyUploadError(formatApiError(`${service}.${method}`, info), {
        code: info.code,
        statusCode: info.statusCode,
      });
    }

    return (parsed ?? {}) as T;
  }

  /**
   * Returns the app id the upload RPCs must carry.
   *
   * `app_id` is protovalidate-required on `CreateMultipartUploadRequest` even
   * though the handler derives the app from the API key anyway, so a key-only
   * configuration is rejected before the handler runs. Until that changes
   * (S10-pre), read the app off the most recent job — the only self-discovery
   * an app-scoped key has, since `AppService.List` needs an org id the key
   * holder does not know. Resolved once per provider instance.
   */
  async appId(): Promise<string> {
    if (this.resolvedAppId !== '') {
      return this.resolvedAppId;
    }

    const response = await this.call<{ jobs?: Array<{ app_id?: string }> }>('JobService', 'List', {
      pagination: { limit: 1 },
    });
    const discovered = response.jobs?.[0]?.app_id ?? '';
    if (discovered === '') {
      throw new TranscodelyUploadError(
        'Could not determine which Transcodely app to upload to. Set `appId` in the ' +
          'provider options (it looks like app_xxxxxxxxxx).',
        { code: 'app_id_required' },
      );
    }

    this.resolvedAppId = discovered;
    return discovered;
  }

  async createMultipartUpload(body: Record<string, unknown>): Promise<CreateMultipartUploadResult> {
    return this.call<CreateMultipartUploadResult>('VideoService', 'CreateMultipartUpload', body);
  }

  async getUploadPartUrls(
    id: string,
    uploadId: string,
    partNumbers: number[],
  ): Promise<{ parts: UploadPart[] }> {
    return this.call<{ parts: UploadPart[] }>('VideoService', 'GetUploadPartUrls', {
      id,
      upload_id: uploadId,
      part_numbers: partNumbers,
    });
  }

  async completeMultipartUpload(
    id: string,
    uploadId: string,
    parts: Array<{ part_number: number; etag: string }>,
  ): Promise<{ video: VideoResource }> {
    return this.call<{ video: VideoResource }>('VideoService', 'CompleteMultipartUpload', {
      id,
      upload_id: uploadId,
      parts,
    });
  }

  async abortMultipartUpload(id: string, uploadId: string): Promise<void> {
    await this.call('VideoService', 'AbortMultipartUpload', { id, upload_id: uploadId });
  }

  async getVideo(id: string): Promise<VideoResource | undefined> {
    const response = await this.call<{ video?: VideoResource }>('VideoService', 'Get', { id });
    return response.video;
  }

  async deleteVideo(id: string): Promise<void> {
    await this.call('VideoService', 'Delete', { id });
  }

  /**
   * PUTs one part to its presigned URL and returns the ETag.
   *
   * The ETag is forwarded to `CompleteMultipartUpload` exactly as the storage
   * provider returned it, quotes included: S3 compares the value byte for byte
   * and the API passes it straight through.
   */
  async putPart(url: string, body: Buffer): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.partTimeoutMs);

    let response: Response;
    try {
      response = await this.config.fetch(url, {
        method: 'PUT',
        // The Buffer goes in as-is. `new Uint8Array(buffer)` COPIES, which
        // would double this upload's peak memory to partSize x concurrency x 2;
        // fetch accepts any ArrayBufferView, and a Buffer is one.
        body,
        signal: controller.signal,
      });
    } catch (cause) {
      throw new TranscodelyUploadError('Uploading a part to managed storage failed', {
        code: 'part_upload_failed',
        cause,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      // The presigned URL is a bearer credential for the object — it never
      // enters the message, and neither does the storage provider's XML body.
      throw new TranscodelyUploadError(
        `Managed storage refused a part upload (HTTP ${response.status})`,
        { code: 'part_upload_failed', statusCode: response.status },
      );
    }

    const etag = response.headers.get('etag') ?? response.headers.get('ETag');
    if (!etag) {
      throw new TranscodelyUploadError(
        'Managed storage accepted a part but returned no ETag, so the upload cannot be completed',
        { code: 'part_upload_failed' },
      );
    }
    return etag;
  }
}
