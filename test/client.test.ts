import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { TranscodelyClient, isLegacyAppIdRequired, rpcUrl } from '../src/client';
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
    const server = await withServer();
    const client = new TranscodelyClient(
      resolveConfig({ apiKey: 'ak_secret', baseUrl: server.baseUrl }),
    );

    await client.getVideo('vid_missing').catch(() => undefined);

    const [call] = server.callsTo('VideoService/Get');
    assert.equal(call.headers.authorization, 'Bearer ak_secret');
    assert.equal(call.headers['content-type'], 'application/json');
    assert.equal(call.headers['transcodely-version'], API_VERSION);
    assert.deepEqual(call.body, { id: 'vid_missing' });
  });

  it('sends no app_id at all on a current server, and never probes for one', async () => {
    // The key already names exactly one app; api 5.20.0 resolves it.
    const server = await withServer();
    const client = new TranscodelyClient(
      resolveConfig({ apiKey: 'ak_secret', baseUrl: server.baseUrl }),
    );

    await client.createMultipartUpload({ filename: 'a.mp4', total_parts: 1 });

    const [create] = server.callsTo('VideoService/CreateMultipartUpload');
    assert.ok(!('app_id' in create.body), 'app_id is omitted entirely');
    assert.equal(server.callsTo('JobService/List').length, 0, 'no discovery on the happy path');
  });

  it('sends the configured app id when one is set, and never probes', async () => {
    const server = await withServer({ requireAppId: true });
    const client = new TranscodelyClient(
      resolveConfig({ apiKey: 'ak_secret', baseUrl: server.baseUrl, appId: 'app_configured' }),
    );

    await client.createMultipartUpload({ filename: 'a.mp4', total_parts: 1 });

    const [create] = server.callsTo('VideoService/CreateMultipartUpload');
    assert.equal(create.body.app_id, 'app_configured');
    assert.equal(server.callsTo('JobService/List').length, 0);
  });
});

describe('legacy app_id compatibility (delete with api 5.20.0)', () => {
  it('recognises only a 400 that actually names app_id', () => {
    const named = new TranscodelyUploadError('validation failed: app_id: value is required', {
      statusCode: 400,
      code: 'invalid_argument',
      fields: ['app_id'],
    });
    assert.equal(isLegacyAppIdRequired(named), true);

    // Header-less older proxy: the message alone still carries it.
    const messageOnly = new TranscodelyUploadError(
      'Transcodely VideoService.CreateMultipartUpload failed [invalid_argument]: ' +
        'validation failed: app_id: value is required',
      { statusCode: 400, code: 'invalid_argument' },
    );
    assert.equal(isLegacyAppIdRequired(messageOnly), true);

    // A real validation failure about something else must surface as one.
    const other = new TranscodelyUploadError('validation failed: total_parts: must be >= 1', {
      statusCode: 400,
      code: 'invalid_argument',
      fields: ['total_parts'],
    });
    assert.equal(isLegacyAppIdRequired(other), false);

    // A 403 mismatch is not this.
    const denied = new TranscodelyUploadError('app_id does not belong to this key', {
      statusCode: 403,
      code: 'permission_denied',
      fields: ['app_id'],
    });
    assert.equal(isLegacyAppIdRequired(denied), false);
    assert.equal(isLegacyAppIdRequired(new Error('boom')), false);
  });

  it('falls back to job discovery only after an old server refuses, then reuses it', async () => {
    const server = await withServer({
      requireAppId: true,
      jobs: [{ id: 'job_1', app_id: 'app_from_job' }],
    });
    const client = new TranscodelyClient(
      resolveConfig({ apiKey: 'ak_secret', baseUrl: server.baseUrl }),
    );

    await client.createMultipartUpload({ filename: 'a.mp4', total_parts: 1 });
    await client.createMultipartUpload({ filename: 'b.mp4', total_parts: 1 });

    const creates = server.callsTo('VideoService/CreateMultipartUpload');
    // First attempt key-only, retry with the discovered id, then the second
    // upload goes straight out with it.
    assert.equal(creates.length, 3);
    assert.ok(!('app_id' in creates[0].body));
    assert.equal(creates[1].body.app_id, 'app_from_job');
    assert.equal(creates[2].body.app_id, 'app_from_job');
    assert.equal(server.callsTo('JobService/List').length, 1, 'discovered once, then cached');
  });

  it('says exactly what to do when an old server refuses and there is no job', async () => {
    const server = await withServer({ requireAppId: true, jobs: [] });
    const client = new TranscodelyClient(
      resolveConfig({ apiKey: 'ak_secret', baseUrl: server.baseUrl }),
    );

    await assert.rejects(
      client.createMultipartUpload({ filename: 'a.mp4', total_parts: 1 }),
      (error: unknown) => {
        assert.ok(error instanceof TranscodelyUploadError);
        assert.equal(error.code, 'app_id_required');
        // Quoted verbatim in the README's "The app id" section; keep them in
        // step, because it is the only instruction that unblocks the operator.
        assert.equal(
          error.message,
          'This Transcodely deployment still requires an app id, and the account has no job ' +
            'to read one from. Set `appId` in the provider options (it looks like ' +
            'app_xxxxxxxxxx).',
        );
        return true;
      },
    );
  });

  it('asks for two jobs, so a disagreement is detectable at all', async () => {
    const server = await withServer({
      requireAppId: true,
      jobs: [{ id: 'job_1', app_id: 'app_from_job' }],
    });
    const client = new TranscodelyClient(
      resolveConfig({ apiKey: 'ak_secret', baseUrl: server.baseUrl }),
    );

    await client.createMultipartUpload({ filename: 'a.mp4', total_parts: 1 });

    const [list] = server.callsTo('JobService/List');
    assert.deepEqual(list.body, { pagination: { limit: 2 } });
  });

  it('refuses rather than guessing when the jobs name different apps', async () => {
    // Unreachable with an ak_ key, which the API force-scopes to one app — this
    // is the defence in depth behind that, because the wrong answer would cross
    // an app boundary silently.
    const server = await withServer({
      requireAppId: true,
      jobs: [
        { id: 'job_newest', app_id: 'app_newest0001' },
        { id: 'job_older', app_id: 'app_other00002' },
      ],
    });
    const client = new TranscodelyClient(
      resolveConfig({ apiKey: 'ak_secret', baseUrl: server.baseUrl }),
    );

    await assert.rejects(
      client.createMultipartUpload({ filename: 'a.mp4', total_parts: 1 }),
      (error: unknown) => {
        assert.ok(error instanceof TranscodelyUploadError);
        assert.equal(error.code, 'app_id_required');
        assert.match(error.message, /jobs from more than one app/);
        return true;
      },
    );

    // The upload is refused outright, not completed into a guessed app.
    assert.equal(server.callsTo('VideoService/CreateMultipartUpload').length, 1);
  });

  it('accepts two jobs that agree', async () => {
    const server = await withServer({
      requireAppId: true,
      jobs: [
        { id: 'job_1', app_id: 'app_from_job' },
        { id: 'job_2', app_id: 'app_from_job' },
      ],
    });
    const client = new TranscodelyClient(
      resolveConfig({ apiKey: 'ak_secret', baseUrl: server.baseUrl }),
    );

    await client.createMultipartUpload({ filename: 'a.mp4', total_parts: 1 });

    const creates = server.callsTo('VideoService/CreateMultipartUpload');
    assert.equal(creates[1].body.app_id, 'app_from_job');
  });

  it('does not retry a 400 about anything other than app_id', async () => {
    // The fallback must be narrow: a real validation failure has to surface as
    // one rather than sending the caller through a pointless app lookup.
    const server = await withServer({
      failures: {
        'VideoService/CreateMultipartUpload': {
          status: 400,
          code: 'invalid_argument',
          message: 'validation failed: total_parts: value must be greater than or equal to 1',
        },
      },
      jobs: [{ id: 'job_1', app_id: 'app_from_job' }],
    });
    const client = new TranscodelyClient(
      resolveConfig({ apiKey: 'ak_secret', baseUrl: server.baseUrl }),
    );

    await assert.rejects(
      client.createMultipartUpload({ filename: 'a.mp4', total_parts: 0 }),
      /total_parts/,
    );
    assert.equal(server.callsTo('VideoService/CreateMultipartUpload').length, 1, 'no retry');
    assert.equal(server.callsTo('JobService/List').length, 0, 'no pointless app lookup');
  });

  it('does not retry when a configured app id was rejected', async () => {
    const server = await withServer({
      failures: {
        'VideoService/CreateMultipartUpload': {
          status: 400,
          code: 'invalid_argument',
          message: 'validation failed: app_id: value is required',
        },
      },
      jobs: [{ id: 'job_1', app_id: 'app_from_job' }],
    });
    const client = new TranscodelyClient(
      resolveConfig({ apiKey: 'ak_secret', baseUrl: server.baseUrl, appId: 'app_configured' }),
    );

    await assert.rejects(client.createMultipartUpload({ filename: 'a.mp4', total_parts: 1 }));
    assert.equal(server.callsTo('VideoService/CreateMultipartUpload').length, 1, 'no retry');
    assert.equal(server.callsTo('JobService/List').length, 0);
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
