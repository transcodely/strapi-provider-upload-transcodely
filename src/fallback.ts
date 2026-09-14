import { TranscodelyUploadError } from './errors';
import type { StrapiUploadProvider, StrapiUploadProviderModule } from './types';

function isProviderModule(value: unknown): value is StrapiUploadProviderModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { init?: unknown }).init === 'function'
  );
}

/**
 * A provider compiled from ES modules exports `init` under `.default`, whether
 * it arrives from `require()` or was imported by the operator's own config.
 */
function unwrapModule(value: unknown): StrapiUploadProviderModule | undefined {
  if (isProviderModule(value)) {
    return value;
  }
  const inner = (value as { default?: unknown } | undefined)?.default;
  return isProviderModule(inner) ? inner : undefined;
}

/**
 * Resolves a provider module the way Strapi's own `createProvider` does:
 * `@strapi/provider-upload-<name>` first, then the name as a bare module
 * specifier. A required module can also be handed in directly, which is what
 * this package's tests do.
 */
export function resolveProviderModule(
  provider: string | StrapiUploadProviderModule,
): StrapiUploadProviderModule {
  if (typeof provider !== 'string') {
    const direct = unwrapModule(provider);
    if (direct === undefined) {
      throw new TranscodelyUploadError(
        'The fallback upload provider object does not export an init() function',
        { code: 'fallback_provider_invalid' },
      );
    }
    return direct;
  }

  const name = provider.toLowerCase();
  let modulePath = name;
  try {
    modulePath = require.resolve(`@strapi/provider-upload-${name}`);
  } catch {
    modulePath = name;
  }

  let loaded: unknown;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    loaded = require(modulePath);
  } catch (cause) {
    throw new TranscodelyUploadError(
      `Could not load the fallback upload provider "${name}". Install it, or set ` +
        '`fallbackProviderOptions`/`fallbackProvider` to a provider that is installed.',
      { code: 'fallback_provider_not_found', cause },
    );
  }

  const candidate = unwrapModule(loaded);
  if (candidate === undefined) {
    throw new TranscodelyUploadError(
      `The fallback upload provider "${name}" does not export an init() function`,
      { code: 'fallback_provider_invalid' },
    );
  }
  return candidate;
}

/**
 * Initialises the fallback provider.
 *
 * Eager, at Strapi boot, on purpose: `@strapi/provider-upload-local` throws
 * there if `public/uploads` is missing, and a boot failure naming the problem
 * beats every image upload failing later.
 */
export function initFallback(
  provider: string | StrapiUploadProviderModule,
  options: Record<string, unknown>,
): StrapiUploadProvider {
  const module = resolveProviderModule(provider);
  const instance = module.init(options);
  if (typeof instance?.delete !== 'function') {
    throw new TranscodelyUploadError(
      'The fallback upload provider does not implement delete()',
      { code: 'fallback_provider_invalid' },
    );
  }
  if (typeof instance.upload !== 'function' && typeof instance.uploadStream !== 'function') {
    throw new TranscodelyUploadError(
      'The fallback upload provider implements neither upload() nor uploadStream()',
      { code: 'fallback_provider_invalid' },
    );
  }
  return instance;
}
