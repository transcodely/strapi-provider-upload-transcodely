import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

/**
 * A stand-in for the Transcodely API and its presigned storage URLs.
 *
 * It speaks the same wire shape the real API does — Connect-RPC over JSON at
 * `/transcodely.v1.{Service}/{Method}`, snake_case bodies, lowercase enums, an
 * `error-code` header on failures — and it enforces the two constraints that
 * actually bite: `CompleteMultipartUpload` refuses a part count that does not
 * match `total_parts`, and a part PUT answers with an `ETag`.
 *
 * No network leaves the machine: it listens on 127.0.0.1 on an ephemeral port.
 */
export interface RecordedCall {
  procedure: string;
  body: any;
  headers: Record<string, string | string[] | undefined>;
}

export interface MockVideo {
  id: string;
  app_id: string;
  status: string;
  visibility: string;
  job_id?: string;
  playback_url?: string;
  embed_url?: string;
  poster_url?: string;
  [key: string]: unknown;
}

export interface MockServerOptions {
  /** Parts held back from `CreateMultipartUpload`, mirroring the API's 50 cap. */
  initialPartUrls?: number;
  /** Videos already present, keyed by id, for Get/Delete. */
  videos?: Record<string, MockVideo>;
  /** Jobs `JobService/List` returns, for app-id discovery. */
  jobs?: Array<{ id: string; app_id: string }>;
  /** Force a failure for one procedure. */
  failures?: Record<string, { status: number; code?: string; message?: string; details?: unknown }>;
  /**
   * Part numbers whose PUT answers 403, as an expired presigned URL would.
   * Listing the same part twice makes it fail twice, which is what exercises
   * the "one refresh, then give up" path.
   */
  expirePartsOnce?: number[];
  /** Fail `CreateMultipartUpload` unless an app_id is present. */
  requireAppId?: boolean;
}

export interface MockServer {
  baseUrl: string;
  calls: RecordedCall[];
  /** Bytes received per video id, in part order. */
  uploaded: Map<string, Buffer>;
  videos: Map<string, MockVideo>;
  deleted: string[];
  aborted: string[];
  close(): Promise<void>;
  callsTo(procedure: string): RecordedCall[];
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(payload);
}

export async function startMockServer(options: MockServerOptions = {}): Promise<MockServer> {
  const initialPartUrls = options.initialPartUrls ?? 50;
  const calls: RecordedCall[] = [];
  const videos = new Map<string, MockVideo>(Object.entries(options.videos ?? {}));
  const partBuffers = new Map<string, Map<number, Buffer>>();
  const uploads = new Map<string, { videoId: string; totalParts: number }>();
  const deleted: string[] = [];
  const aborted: string[] = [];
  const expiredRemaining = new Map<number, number>();
  for (const part of options.expirePartsOnce ?? []) {
    expiredRemaining.set(part, (expiredRemaining.get(part) ?? 0) + 1);
  }

  let baseUrl = '';

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', baseUrl || 'http://127.0.0.1');

    // Presigned part PUT: /_storage/{videoId}/{partNumber}
    if (req.method === 'PUT' && url.pathname.startsWith('/_storage/')) {
      const [, , videoId, partRaw] = url.pathname.split('/');
      const partNumber = Number(partRaw);
      const remaining = expiredRemaining.get(partNumber) ?? 0;
      if (remaining > 0) {
        expiredRemaining.set(partNumber, remaining - 1);
        res.writeHead(403, { 'Content-Type': 'application/xml' });
        res.end('<Error><Code>AccessDenied</Code></Error>');
        return;
      }
      const body = await readBody(req);
      const parts = partBuffers.get(videoId) ?? new Map<number, Buffer>();
      parts.set(partNumber, body);
      partBuffers.set(videoId, parts);
      res.writeHead(200, { ETag: `"${createHash('md5').update(body).digest('hex')}"` });
      res.end();
      return;
    }

    if (req.method !== 'POST') {
      send(res, 405, { code: 'unimplemented', message: 'method not allowed' });
      return;
    }

    const procedure = url.pathname.replace(/^\/transcodely\.v1\./, '');
    const raw = await readBody(req);
    const body = raw.length > 0 ? JSON.parse(raw.toString('utf8')) : {};
    calls.push({ procedure, body, headers: req.headers });

    const failure = options.failures?.[procedure];
    if (failure) {
      send(
        res,
        failure.status,
        {
          code: failure.code ?? 'internal',
          message: failure.message ?? 'forced failure',
          ...(failure.details === undefined ? {} : { details: failure.details }),
        },
        failure.code ? { 'error-code': failure.code } : {},
      );
      return;
    }

    switch (procedure) {
      case 'JobService/List': {
        send(res, 200, { jobs: options.jobs ?? [], pagination: { next_cursor: '' } });
        return;
      }

      case 'VideoService/CreateMultipartUpload': {
        if (options.requireAppId && !body.app_id) {
          send(
            res,
            400,
            {
              code: 'invalid_argument',
              message: 'validation failed',
              details: [
                {
                  field_violations: [{ field: 'app_id', description: 'value is required' }],
                },
              ],
            },
            { 'error-code': 'parameter_required' },
          );
          return;
        }

        const id = `vid_${randomUUID().replace(/-/g, '').slice(0, 14)}`;
        const uploadId = `mpu_${randomUUID()}`;
        const video: MockVideo = {
          id,
          app_id: body.app_id,
          status: 'uploading',
          visibility: body.visibility ?? 'unlisted',
        };
        videos.set(id, video);
        uploads.set(uploadId, { videoId: id, totalParts: body.total_parts });

        const parts = [];
        for (let n = 1; n <= Math.min(body.total_parts, initialPartUrls); n += 1) {
          parts.push({ part_number: n, upload_url: `${baseUrl}/_storage/${id}/${n}` });
        }
        send(res, 200, {
          video,
          upload_id: uploadId,
          parts,
          urls_expire_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
        return;
      }

      case 'VideoService/GetUploadPartUrls': {
        const upload = uploads.get(body.upload_id);
        if (!upload) {
          send(res, 404, { code: 'not_found', message: 'upload not found' }, {
            'error-code': 'not_found',
          });
          return;
        }
        send(res, 200, {
          parts: (body.part_numbers as number[]).map((n) => ({
            part_number: n,
            upload_url: `${baseUrl}/_storage/${upload.videoId}/${n}`,
          })),
          urls_expire_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
        return;
      }

      case 'VideoService/CompleteMultipartUpload': {
        const upload = uploads.get(body.upload_id);
        if (!upload || upload.videoId !== body.id) {
          send(res, 404, { code: 'not_found', message: 'multipart upload not found' }, {
            'error-code': 'multipart_upload_not_found',
          });
          return;
        }
        // The real API refuses a mismatched part count outright.
        if (body.parts.length !== upload.totalParts) {
          send(
            res,
            400,
            {
              code: 'invalid_argument',
              message: `expected ${upload.totalParts} parts, got ${body.parts.length}`,
            },
            { 'error-code': 'multipart_parts_mismatch' },
          );
          return;
        }
        const video = videos.get(upload.videoId)!;
        video.status = 'processing';
        video.job_id = `job_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
        uploads.delete(body.upload_id);
        send(res, 200, { video });
        return;
      }

      case 'VideoService/AbortMultipartUpload': {
        aborted.push(body.id);
        uploads.delete(body.upload_id);
        videos.delete(body.id);
        send(res, 200, {});
        return;
      }

      case 'VideoService/Get': {
        const video = videos.get(body.id);
        if (!video) {
          send(res, 404, { code: 'not_found', message: 'video not found' }, {
            'error-code': 'not_found',
          });
          return;
        }
        send(res, 200, { video });
        return;
      }

      case 'VideoService/Delete': {
        if (!videos.has(body.id)) {
          send(res, 404, { code: 'not_found', message: 'video not found' }, {
            'error-code': 'not_found',
          });
          return;
        }
        videos.delete(body.id);
        deleted.push(body.id);
        send(res, 200, {});
        return;
      }

      default:
        send(res, 404, { code: 'unimplemented', message: `no such procedure: ${procedure}` });
    }
  };

  const server: Server = createServer((req, res) => {
    handler(req, res).catch((error: unknown) => {
      send(res, 500, { code: 'internal', message: String(error) });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    calls,
    videos,
    deleted,
    aborted,
    get uploaded() {
      const assembled = new Map<string, Buffer>();
      for (const [videoId, parts] of partBuffers) {
        const ordered = [...parts.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
        assembled.set(videoId, Buffer.concat(ordered));
      }
      return assembled;
    },
    callsTo(procedure: string) {
      return calls.filter((c) => c.procedure === procedure);
    },
    close() {
      return new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
