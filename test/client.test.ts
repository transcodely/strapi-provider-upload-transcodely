import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { TranscodelyClient, rpcUrl } from '../src/client';
import { API_VERSION, resolveConfig } from '../src/config';
import { TranscodelyUploadError, describeApiError } from '../src/errors';
import { startMockServer } from './helpers/mock-server';
import type { MockServer } from './helpers/mock-server';

const servers: MockServer[] = [];

after(async () => {
  await Promise.all(servers.map((s) => s.close()));
});

async function withServer(options: Parameters<typeof startMockServer>[0] = {}) {
  const server = await startMockServer(options);
  servers.push(server);
  return server;
}

describe('rpcUrl', () => {
  it('builds the Connect procedure path', () => {
    assert.equal(
      rpcUrl('https://api.transcodely.com', 'VideoService', 'Get'),
      'https://api.transcodely.com/transcodely.v1.VideoService/Get',
    );
  });
});

describe('describeApiError', () => {
  it('prefers the error-code header over the body’s Connect class', () => {
    const info = describeApiError(
      503,
      new Headers({ 'error-code': 'hosting_provisioning_failed' }),
      { code: 'unavailable', message: 'Hosting could not be provisioned' },
    );
    assert.equal(info.code, 'hosting_provisioning_failed');
    assert.equal(info.message, 'Hosting could not be provisioned');
  });

  it('reads violations out of a real connect-go error detail', () => {
    // connect-go serialises a detail as {type, value: base64, debug: protojson},
    // so the violations live under `debug` in protojson's camelCase — NOT at
    // the top level of the entry and NOT in the API's snake_case wire casing.
    const info = describeApiError(404, new Headers(), {
      code: 'not_found',
      message: 'Preset not found',
      details: [
        {
          type: 'transcodely.v1.ErrorDetails',
          value: 'CgtyZXNvdXJjZV9lcnJvcg',
          debug: {
            code: 'resource_error',
            message: 'Preset not found',
            fieldViolations: [{ field: 'preset', description: '[not_found] no such preset' }],
          },
        },
      ],
    });
    assert.equal(info.message, 'Preset not found (preset: [not_found] no such preset)');
  });

  it('also accepts snake_case violations, in case a proxy rewrote the envelope', () => {
    const info = describeApiError(400, new Headers(), {
      code: 'invalid_argument',
      message: 'Validation failed',
      details: [
        { debug: { field_violations: [{ field: 'outputs[0].crf', description: 'out of range' }] } },
      ],
    });
    assert.equal(info.message, 'Validation failed (outputs[0].crf: out of range)');
  });

  it('falls back to the x-validation-fields header, which is all protovalidate sends', () => {
    // The api's validation interceptor attaches NO detail: it flattens every
    // violation into the message and sets this header.
    const info = describeApiError(
      400,
      new Headers({ 'x-validation-fields': 'app_id,filename' }),
      { code: 'invalid_argument', message: 'validation failed: app_id: value is required' },
    );
    assert.equal(info.code, 'invalid_argument');
    // app_id is already named in the message, so nothing is appended.
    assert.equal(info.message, 'validation failed: app_id: value is required');

    const bare = describeApiError(400, new Headers({ 'x-validation-fields': 'total_parts' }), {
      code: 'invalid_argument',
      message: 'validation failed',
    });
    assert.equal(bare.message, 'validation failed (fields: total_parts)');
  });

  it('falls back to a status-derived code and message for an empty body', () => {
    const info = describeApiError(401, undefined, undefined);
    assert.equal(info.code, 'unauthenticated');
    assert.equal(info.message, 'The API key was rejected');
  });

  it('never surfaces unknown body fields', () => {
    const info = describeApiError(500, new Headers(), {
      code: 'internal',
      message: 'boom',
      stack: 'internal/services/videos/impl.go:632',
      sql: 'SELECT 1',
    });
    assert.equal(info.message, 'boom');
    assert.ok(!JSON.stringify(info).includes('impl.go'));
    assert.ok(!JSON.stringify(info).includes('SELECT'));
  });
});

describe('TranscodelyClient', () => {
  it('sends bearer auth, JSON and the pinned calendar version', async () => {
    const server = await withServer({ jobs: [{ id: 'job_1', app_id: 'app_from_job' }] });
    const client = new TranscodelyClient(
      resolveConfig({ apiKey: 'ak_secret', baseUrl: server.baseUrl }),
    );

    await client.appId();

    const [call] = server.callsTo('JobService/List');
    assert.equal(call.headers.authorization, 'Bearer ak_secret');
    assert.equal(call.headers['content-type'], 'application/json');
    assert.equal(call.headers['transcodely-version'], API_VERSION);
    assert.deepEqual(call.body, { pagination: { limit: 1 } });
  });

  it('uses the configured app id without calling the API', async () => {
    const server = await withServer();
    const client = new TranscodelyClient(
      resolveConfig({ apiKey: 'ak_secret', baseUrl: server.baseUrl, appId: 'app_configured' }),
    );

    assert.equal(await client.appId(), 'app_configured');
    assert.equal(server.callsTo('JobService/List').length, 0);
  });

  it('discovers the app id from the most recent job, once', async () => {
    const server = await withServer({ jobs: [{ id: 'job_1', app_id: 'app_from_job' }] });
    const client = new TranscodelyClient(
      resolveConfig({ apiKey: 'ak_secret', baseUrl: server.baseUrl }),
    );

    assert.equal(await client.appId(), 'app_from_job');
    assert.equal(await client.appId(), 'app_from_job');
    assert.equal(server.callsTo('JobService/List').length, 1);
  });

  it('says exactly what to do when no app id can be discovered', async () => {
    const server = await withServer({ jobs: [] });
    const client = new TranscodelyClient(
      resolveConfig({ apiKey: 'ak_secret', baseUrl: server.baseUrl }),
    );

    await assert.rejects(client.appId(), (error: unknown) => {
      assert.ok(error instanceof TranscodelyUploadError);
      assert.equal(error.code, 'app_id_required');
      assert.match(error.message, /Set `appId` in the provider options/);
      return true;
    });
  });

  it('turns an API refusal into an error carrying the API’s own code', async () => {
    const server = await withServer({
      failures: { 'VideoService/Get': { status: 404, code: 'not_found', message: 'video not found' } },
    });
    const client = new TranscodelyClient(
      resolveConfig({ apiKey: 'ak_secret', baseUrl: server.baseUrl, appId: 'app_x' }),
    );

    await assert.rejects(client.getVideo('vid_missing'), (error: unknown) => {
      assert.ok(error instanceof TranscodelyUploadError);
      assert.equal(error.code, 'not_found');
      assert.equal(error.statusCode, 404);
      assert.match(error.message, /VideoService\.Get failed \[not_found\]/);
      return true;
    });
  });

  it('reports an unreachable API as unavailable rather than a raw socket error', async () => {
    const client = new TranscodelyClient(
      resolveConfig({
        apiKey: 'ak_secret',
        // Port 1 on loopback: nothing listens, connection is refused immediately.
        baseUrl: 'http://127.0.0.1:1',
        appId: 'app_x',
        requestTimeoutMs: 2_000,
      }),
    );

    await assert.rejects(client.getVideo('vid_x'), (error: unknown) => {
      assert.ok(error instanceof TranscodelyUploadError);
      assert.equal(error.code, 'unavailable');
      return true;
    });
  });

  it('keeps the presigned URL out of a failed part upload’s message', async () => {
    const server = await withServer({ expirePartsOnce: [1] });
    const client = new TranscodelyClient(
      resolveConfig({ apiKey: 'ak_secret', baseUrl: server.baseUrl, appId: 'app_x' }),
    );

    const url = `${server.baseUrl}/_storage/vid_x/1?signature=super-secret`;
    await assert.rejects(client.putPart(url, Buffer.from('x')), (error: unknown) => {
      assert.ok(error instanceof TranscodelyUploadError);
      assert.equal(error.statusCode, 403);
      assert.ok(!error.message.includes('super-secret'));
      assert.ok(!error.message.includes('AccessDenied'));
      return true;
    });
  });

  it('returns the storage ETag verbatim, quotes included', async () => {
    const server = await withServer();
    const client = new TranscodelyClient(
      resolveConfig({ apiKey: 'ak_secret', baseUrl: server.baseUrl, appId: 'app_x' }),
    );

    const etag = await client.putPart(`${server.baseUrl}/_storage/vid_x/1`, Buffer.from('hello'));
    assert.match(etag, /^"[0-9a-f]{32}"$/);
  });
});
