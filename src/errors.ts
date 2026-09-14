/**
 * Error shaping.
 *
 * Two rules hold everywhere in this file:
 *
 * 1. A raw API response body is never surfaced. Only the documented `code`,
 *    `message` and field-violation fields reach a Strapi log or admin toast.
 * 2. Nothing here ever prints the API key, the presigned URLs, or a storage
 *    key — a presigned URL is a bearer credential for the object it points at.
 */

/** Machine-readable code plus the customer-facing message for a failed RPC. */
export interface ApiErrorInfo {
  code: string;
  message: string;
  statusCode: number;
}

const STATUS_FALLBACKS: Record<number, { code: string; message: string }> = {
  400: { code: 'invalid_argument', message: 'Transcodely rejected the request' },
  401: { code: 'unauthenticated', message: 'The API key was rejected' },
  403: { code: 'permission_denied', message: 'The API key may not act on this resource' },
  404: { code: 'not_found', message: 'The requested resource does not exist' },
  409: { code: 'aborted', message: 'The request conflicted with the resource state' },
  429: { code: 'resource_exhausted', message: 'A Transcodely limit was reached' },
  500: { code: 'internal', message: 'Transcodely could not complete the request' },
  503: { code: 'unavailable', message: 'Transcodely is temporarily unavailable' },
};

/** An error raised by this provider. Carries the API's code when it has one. */
export class TranscodelyUploadError extends Error {
  readonly code: string;
  readonly statusCode?: number;

  constructor(message: string, options: { code?: string; statusCode?: number; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'TranscodelyUploadError';
    this.code = options.code ?? 'provider_error';
    this.statusCode = options.statusCode;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Pulls `field: description` pairs out of a Connect error's `details`.
 *
 * protovalidate failures ride there, and they are the difference between
 * "invalid_argument" and "app_id must match ^app_[a-zA-Z0-9_-]+$".
 */
function fieldViolations(body: Record<string, unknown>): string[] {
  const details = body.details;
  if (!Array.isArray(details)) {
    return [];
  }

  const messages: string[] = [];
  for (const detail of details) {
    if (!isRecord(detail)) {
      continue;
    }
    const violations = detail.field_violations ?? detail.fieldViolations;
    if (!Array.isArray(violations)) {
      continue;
    }
    for (const violation of violations) {
      if (!isRecord(violation)) {
        continue;
      }
      const field = typeof violation.field === 'string' ? violation.field : '';
      const description = typeof violation.description === 'string' ? violation.description : '';
      if (field && description) {
        messages.push(`${field}: ${description}`);
      } else if (description) {
        messages.push(description);
      }
    }
  }
  return messages;
}

/**
 * Turns a Connect-RPC error response into the code and message a Strapi
 * operator should see.
 *
 * The API stamps a stable discriminator on the `error-code` response header and
 * repeats a broader Connect code in the body. The header wins: it names the
 * domain error (`hosting_provisioning_failed`) rather than its class
 * (`unavailable`).
 */
export function describeApiError(
  statusCode: number,
  headers: { get(name: string): string | null } | undefined,
  body: unknown,
): ApiErrorInfo {
  const parsed = isRecord(body) ? body : {};
  const headerCode = headers?.get('error-code') ?? '';
  const bodyCode = typeof parsed.code === 'string' ? parsed.code : '';
  const fallback = STATUS_FALLBACKS[statusCode] ?? {
    code: 'unknown',
    message: 'Transcodely rejected the request',
  };

  const code = headerCode || bodyCode || fallback.code;

  let message =
    typeof parsed.message === 'string' && parsed.message ? parsed.message : fallback.message;
  const violations = fieldViolations(parsed);
  if (violations.length > 0) {
    message = `${message} (${violations.join('; ')})`;
  }

  return { code, message, statusCode };
}

/** One-line summary suitable for a thrown error's message. */
export function formatApiError(procedure: string, info: ApiErrorInfo): string {
  return `Transcodely ${procedure} failed [${info.code}]: ${info.message}`;
}

/**
 * Builds the error Strapi turns into a 413.
 *
 * `@strapi/utils` is a transitive dependency of every Strapi project, but it is
 * not a dependency of this package: requiring it is best-effort so the provider
 * still works (with a plain Error, surfacing as a 500 instead of a 413) outside
 * a Strapi runtime and in this repo's own tests.
 */
export function payloadTooLarge(message: string): Error {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const utils = require('@strapi/utils') as { errors?: { PayloadTooLargeError?: new (m: string) => Error } };
    const ctor = utils?.errors?.PayloadTooLargeError;
    if (typeof ctor === 'function') {
      return new ctor(message);
    }
  } catch {
    // Not running inside a Strapi project; fall through.
  }
  return new TranscodelyUploadError(message, { code: 'file_too_large' });
}
