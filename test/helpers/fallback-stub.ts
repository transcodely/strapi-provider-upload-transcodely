import type { Readable } from 'node:stream';

import type { StrapiFile, StrapiUploadProvider, StrapiUploadProviderModule } from '../../src/types';

export interface FallbackStub extends StrapiUploadProviderModule {
  uploads: StrapiFile[];
  streamUploads: StrapiFile[];
  deletes: StrapiFile[];
  signed: StrapiFile[];
  sizeChecks: Array<{ file: StrapiFile; options?: { sizeLimit?: number } }>;
  initOptions: Record<string, unknown> | undefined;
}

/**
 * A stand-in for `@strapi/provider-upload-local`.
 *
 * The real one refuses to initialise outside a Strapi runtime (it reads
 * `strapi.dirs.static.public` and requires `public/uploads` to exist), so the
 * tests hand a module object in through `fallbackProvider` instead — which is
 * itself a supported configuration, not a test-only back door.
 */
export interface FallbackStubOptions {
  withUpload?: boolean;
  withUploadStream?: boolean;
  withSignedUrl?: boolean;
  /**
   * Whether the stub implements `checkFileSize` at all.
   *
   * **Default false, deliberately.** `@strapi/provider-upload-aws-s3` — the
   * fallback the README recommends for images — does not implement it, and a
   * stub that always did is exactly what hid the bug where delegating to it
   * turned Strapi's `sizeLimit` off for every non-video.
   */
  withCheckFileSize?: boolean;
  /** Whether the stub implements `isPrivate`, and what it answers. */
  isPrivate?: boolean;
}

export function createFallbackStub(options: FallbackStubOptions = {}): FallbackStub {
  const withUpload = options.withUpload ?? true;
  const withUploadStream = options.withUploadStream ?? true;

  const stub: FallbackStub = {
    uploads: [],
    streamUploads: [],
    deletes: [],
    signed: [],
    sizeChecks: [],
    initOptions: undefined,
    init(initOptions?: Record<string, unknown>): StrapiUploadProvider {
      stub.initOptions = initOptions;
      const provider: StrapiUploadProvider = {
        async delete(file: StrapiFile) {
          stub.deletes.push(file);
        },
      };
      if (withUpload) {
        provider.upload = async (file: StrapiFile) => {
          if (!file.buffer) {
            throw new Error('fallback upload() called without a buffer');
          }
          stub.uploads.push(file);
          file.url = `/uploads/${file.hash}${file.ext ?? ''}`;
        };
      }
      if (withUploadStream) {
        provider.uploadStream = async (file: StrapiFile) => {
          if (!file.stream) {
            throw new Error('fallback uploadStream() called without a stream');
          }
          // Drain it, the way a real provider writing to disk would.
          for await (const _chunk of file.stream as Readable) {
            void _chunk;
          }
          stub.streamUploads.push(file);
          file.url = `/uploads/${file.hash}${file.ext ?? ''}`;
        };
      }
      if (options.withSignedUrl) {
        provider.getSignedUrl = async (file: StrapiFile) => {
          stub.signed.push(file);
          return { url: `${file.url}?stub-signature=1` };
        };
      }
      if (options.withCheckFileSize) {
        provider.checkFileSize = (file: StrapiFile, opts?: { sizeLimit?: number }) => {
          stub.sizeChecks.push({ file, options: opts });
        };
      }
      if (options.isPrivate !== undefined) {
        const answer = options.isPrivate;
        provider.isPrivate = () => answer;
      }
      return provider;
    },
  };

  return stub;
}
