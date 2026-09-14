import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { initFallback, resolveProviderModule } from '../src/fallback';
import { createFallbackStub } from './helpers/fallback-stub';

describe('package entry point', () => {
  it('exposes init() the way Strapi’s loader reaches for it', () => {
    // Strapi does `require(modulePath).init(providerOptions)`. If the build ever
    // emits an ES default binding instead, `init` lands under `.default` and
    // every Strapi boot fails with "provider doesn't implement the delete
    // method" — this is the test that catches that.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const entry = require('../src/index');

    assert.equal(typeof entry.init, 'function');
    assert.equal(entry.default, undefined);
  });

  it('builds a working provider through the entry point', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const entry = require('../src/index');
    const provider = entry.init({
      apiKey: 'ak_secret',
      appId: 'app_x',
      fallbackProvider: createFallbackStub(),
    });

    for (const method of ['upload', 'uploadStream', 'delete', 'checkFileSize', 'getSignedUrl', 'isPrivate']) {
      assert.equal(typeof provider[method], 'function', `${method} is missing`);
    }
  });
});

describe('fallback provider resolution', () => {
  it('accepts a required module object', () => {
    const stub = createFallbackStub();
    assert.equal(resolveProviderModule(stub), stub);
  });

  it('unwraps a module that exports init under .default', () => {
    const stub = createFallbackStub();
    const esmShaped = { default: stub } as unknown as Parameters<typeof resolveProviderModule>[0];
    assert.equal(resolveProviderModule(esmShaped), stub);
  });

  it('says what to install when the named provider is not there', () => {
    assert.throws(
      () => resolveProviderModule('definitely-not-installed'),
      /Could not load the fallback upload provider "definitely-not-installed"/,
    );
  });

  it('refuses a fallback that implements neither upload nor uploadStream', () => {
    assert.throws(
      () => initFallback({ init: () => ({ delete: async () => undefined }) }, {}),
      /implements neither upload\(\) nor uploadStream\(\)/,
    );
  });
});
