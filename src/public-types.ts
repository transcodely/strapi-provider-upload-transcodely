/**
 * The package's public types, importable as
 * `strapi-provider-upload-transcodely/types`.
 *
 * They live here rather than in `index.ts` because that file uses `export =`
 * for Strapi's `require().init()` loader, and TypeScript forbids an export
 * assignment alongside other exports.
 */
export type {
  PlaybackUrlKind,
  ResolvedConfig,
  TranscodelyProviderOptions,
  Visibility,
} from './config';
export type {
  CheckFileSizeOptions,
  StrapiFile,
  StrapiUploadProvider,
  StrapiUploadProviderModule,
  TranscodelyProviderMetadata,
} from './types';
export { TranscodelyUploadError } from './errors';
export { MAX_UPLOAD_BYTES, API_VERSION } from './config';
