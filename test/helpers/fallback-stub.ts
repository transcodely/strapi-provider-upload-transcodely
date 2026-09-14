import type { Readable } from 'node:stream';

import type { StrapiFile, StrapiUploadProvider, StrapiUploadProviderModule } from '../../src/types';

export interface FallbackStub extends StrapiUploadProviderModule {
  uploads: StrapiFile[];
  streamUploads: StrapiFile[];
  deletes: StrapiFile[];
  signed: StrapiFile[];
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
export function createFallbackStub(
  options: { withUpload?: boolean; withUploadStream?: boolean; withSignedUrl?: boolean } = {},
): FallbackStub {
  const withUpload = options.withUpload ?? true;
  const withUploadStream = options.withUploadStream ?? true;

  const stub: FallbackStub = {
    uploads: [],
    streamUploads: [],
    deletes: [],
    signed: [],
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
      provider.checkFileSize = () => {
        /* the stub never refuses; the tests assert on our own ceiling */
      };
      return provider;
    },
  };

  return stub;
}
