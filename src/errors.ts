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
  /** Field paths the API named as invalid, when it named any. */
  fields: string[];
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
  /** Field paths the API named as invalid, when it named any. */
  readonly fields: string[];

  constructor(
    message: string,
    options: { code?: string; statusCode?: number; fields?: string[]; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'TranscodelyUploadError';
    this.code = options.code ?? 'provider_error';
    this.statusCode = options.statusCode;
    this.fields = options.fields ?? [];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Pulls `field: description` pairs out of a Connect error's `details`.
 *
 * The shape matters and is easy to get wrong. connect-go serialises each entry
 * in `details` as `{type, value: "<base64 proto>", debug: {…}}`, where `debug`
 * is the protojson of the message — so the violations live at
 * `detail.debug.fieldViolations`, in protojson's camelCase, NOT at the top
 * level of the entry and NOT in the API's own snake_case wire casing. connect
 * uses its own default protojson codec for `debug`, not the API's codec.
 *
 * Only the API's *domain* errors attach a detail at all. protovalidate
 * failures carry none — the interceptor flattens every violation into the
 * message and into the `x-validation-fields` response header, which is why
 * `describeApiError` reads that header separately.
 */
function fieldViolations(body: Record<string, unknown>): Array<{ field: string; text: string }> {
  const details = body.details;
  if (!Array.isArray(details)) {
    return [];
  }

  const found: Array<{ field: string; text: string }> = [];
  for (const detail of details) {
    if (!isRecord(detail)) {
      continue;
    }
    // `debug` is where connect-go puts the decoded message; the top level is
    // accepted too so a proxy that rewrote the envelope still parses.
    const debug = isRecord(detail.debug) ? detail.debug : detail;
    const violations = debug.fieldViolations ?? debug.field_violations;
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
        found.push({ field, text: `${field}: ${description}` });
      } else if (description) {
        found.push({ field, text: description });
      }
    }
  }
  return found;
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

  // protovalidate rejections attach no detail at all — the offending field
  // paths ride the `x-validation-fields` header instead. Domain errors carry
  // them inside the detail. Both are collected, because callers branch on the
  // field (the app_id compatibility path is the live example).
  const headerFields = (headers?.get('x-validation-fields') ?? '')
    .split(',')
    .map((f) => f.trim())
    .filter((f) => f !== '');

  const violations = fieldViolations(parsed);
  if (violations.length > 0) {
    message = `${message} (${violations.map((v) => v.text).join('; ')})`;
  } else if (headerFields.length > 0 && !message.includes(headerFields[0])) {
    message = `${message} (fields: ${headerFields.join(',')})`;
  }

  const fields = [
    ...new Set([...headerFields, ...violations.map((v) => v.field).filter((f) => f !== '')]),
  ];

  return { code, message, statusCode, fields };
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
