# strapi-provider-upload-transcodely

A [Strapi v5](https://strapi.io) upload provider that sends **video** uploads to
[Transcodely](https://transcodely.com) — adaptive HLS, a hosted player page, a poster and
optional AI captions — and passes **everything else** (images, PDFs, the image formats Strapi
generates) to a normal fallback provider, so the rest of your media library keeps working exactly
as it did.

- Videos go up through Transcodely's multipart upload RPCs: create → PUT each part → complete.
- `file.url` becomes the player page URL, so the editor gets a working link the moment the upload
  finishes, while the transcode is still running.
- `delete` removes the hosted video. `getSignedUrl` re-signs private playback. `checkFileSize`
  enforces the 5 GiB ceiling before any bytes move.
- No runtime dependencies. Node's built-in `fetch` carries the whole integration.

---

## Install

```bash
npm install strapi-provider-upload-transcodely
# or: yarn add / pnpm add
```

Requires **Strapi 5** and **Node 18.17+**.

## Configure

`config/plugins.js` (or `.ts`):

```js
module.exports = ({ env }) => ({
  upload: {
    config: {
      provider: 'strapi-provider-upload-transcodely',
      providerOptions: {
        apiKey: env('TRANSCODELY_API_KEY'),
        appId: env('TRANSCODELY_APP_ID'), // see "The app id" below
      },
      actionOptions: {
        upload: {},
        uploadStream: {},
        delete: {},
      },
    },
  },
});
```

`.env`:

```
TRANSCODELY_API_KEY=ak_your_secret_key
TRANSCODELY_APP_ID=app_xxxxxxxxxx
```

The API key is a **secret** server-side key. It never leaves your Strapi server: uploads are
streamed from Strapi to presigned storage URLs, and nothing in the admin panel or the public API
ever sees it.

### Content Security Policy

Strapi's `strapi::security` middleware blocks media from other hosts by default. Widen it in
`config/middlewares.js` so the player and poster images load in the admin panel:

```js
module.exports = [
  'strapi::logger',
  'strapi::errors',
  {
    name: 'strapi::security',
    config: {
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'connect-src': ["'self'", 'https:'],
          'img-src': ["'self'", 'data:', 'blob:', 'https://play.transcodely.com', 'https://*.b-cdn.net'],
          'media-src': ["'self'", 'data:', 'blob:', 'https://play.transcodely.com', 'https://*.b-cdn.net'],
          'frame-src': ["'self'", 'https://play.transcodely.com'],
          upgradeInsecureRequests: null,
        },
      },
    },
  },
  // …the rest of the default stack, unchanged
];
```

`frame-src` is what lets the player page render in an `<iframe>`.

---

## Options

| Option | Type | Default | What it does |
|---|---|---|---|
| `apiKey` | string | — | **Required.** Secret API key (`ak_…`). |
| `appId` | string | discovered | App the videos are created under (`app_…`). See below. |
| `baseUrl` | string | `https://api.transcodely.com` | API base URL. |
| `playerBaseUrl` | string | `https://play.transcodely.com` | Base for composed player-page URLs. |
| `visibility` | `public` \| `unlisted` \| `private` | the app's default | Visibility of created videos. Leave unset to use the app's `default_visibility` (itself `unlisted` when unset). |
| `playbackUrlKind` | `player` \| `hls` | `player` | What lands in `file.url`: the player page, or the HLS manifest. |
| `private` | boolean | `false` | Set true when the app has CDN token auth on, so Strapi asks for a fresh signed URL on every read. |
| `preset` | string | — | Preset id or slug driving the encode instead of the app's auto-profile. |
| `hoverPreviews` | boolean | `false` | Attach an animated hover preview. Free. |
| `autoCaptions` | boolean | `false` | Generate AI captions inline with the transcode. **Billed per source minute.** |
| `videoExtensions` | string[] | `[]` | Extra extensions to treat as video (e.g. `['mkv', 'ts']`), for containers Node types as `application/octet-stream`. |
| `videoMimePrefixes` | string[] | `[]` | Extra MIME prefixes to treat as video, beyond `video/`. |
| `partSizeBytes` | number | 25 MiB | Multipart part size. Minimum 5 MiB. |
| `uploadConcurrency` | number | `3` | Parts PUT in parallel. Peak memory is `partSizeBytes × uploadConcurrency`. |
| `requestTimeoutMs` | number | `60000` | Per-RPC timeout. |
| `partTimeoutMs` | number | `300000` | Timeout for a single part PUT. |
| `fallbackProvider` | string \| module | `'local'` | Provider handling non-video files. Resolved as `@strapi/provider-upload-<name>`, then as a bare module name; a required module object also works. |
| `fallbackProviderOptions` | object | `{}` | Options passed to the fallback provider's `init`. |

### The app id

`appId` is currently **effectively required**. The API's upload RPCs still declare `app_id` as a
required field even though an app-scoped key already names the app, so a key-only call is rejected
before the handler runs.

When `appId` is omitted the provider reads it once from your most recent job
(`JobService.List`) — the only self-discovery an app-scoped key has. A brand-new account with no
jobs yet gets an explicit error telling you to fill the field in.

This option goes away once the API makes `app_id` optional on the upload RPCs.

### Keeping images on the local provider

That is the default. `fallbackProvider: 'local'` is `@strapi/provider-upload-local`, which every
Strapi project already ships. To keep images on S3 instead:

```js
providerOptions: {
  apiKey: env('TRANSCODELY_API_KEY'),
  appId: env('TRANSCODELY_APP_ID'),
  fallbackProvider: 'aws-s3',
  fallbackProviderOptions: {
    s3Options: { /* … the aws-s3 provider's own options … */ },
  },
}
```

Routing is by MIME type (`video/*`) with `videoExtensions` as the escape hatch. Strapi's generated
image formats (`thumbnail`, `small`, `medium`, `large`) are images, so they always go to the
fallback.

---

## What you get back

For a video, the Strapi file record ends up with:

```jsonc
{
  "url": "https://play.transcodely.com/v/vid_a1b2c3d4e5f6g7",
  "provider_metadata": {
    "provider": "transcodely",
    "video_id": "vid_a1b2c3d4e5f6g7",
    "job_id": "job_a1b2c3d4e5f6",
    "status": "processing",
    "url_kind": "player"
  }
}
```

`provider_metadata.video_id` is what `delete` and `getSignedUrl` route on, so it stays correct even
if you later change `videoExtensions` or the MIME routing.

`previewUrl` is left empty: the poster frame is generated by the transcode, so it does not exist yet
when the upload finishes and nothing writes the record a second time.

### Processing is not instant

A video is `processing` when the upload finishes and `ready` a while later. The provider does not
block the editor's save waiting for that — it writes the URL that is correct for the life of the
video and returns.

The **player page URL is stable from the moment the video exists**: it is addressed by video id and
never changes, and it re-signs its own playback manifest on every load, so it never expires. That is
why `player` is the default — nothing has to be written back later, and no webhook is needed.

**While the video is still processing that page answers 404** with a branded "video unavailable"
page, and it starts playing the moment the transcode lands. Nothing about the stored record changes
at that point. If an editor needs to know when a video is watchable, read
`provider_metadata.video_id` and check `VideoService.Get`, or subscribe to the `video.ready`
webhook — the provider deliberately does not poll, because an upload handler that waits minutes for
a transcode blocks the editor's save.

`playbackUrlKind: 'hls'` puts the raw HLS manifest URL in `file.url` instead, for a frontend that
feeds its own player. That URL only exists once the video is `ready`, and on a token-auth app it is
signed and expires. So use it **with `private: true`**:

```js
providerOptions: {
  apiKey: env('TRANSCODELY_API_KEY'),
  appId: env('TRANSCODELY_APP_ID'),
  playbackUrlKind: 'hls',
  private: true,
}
```

With `private: true`, Strapi asks the provider for a fresh URL on every read, which both re-signs
the URL and picks up the real manifest the moment the video becomes ready. Until then the player
page URL is returned, because it is the only URL that resolves. A record written in that state is
flagged `url_pending: true`.

The provider prints a startup warning for the two combinations that produce URLs nobody can play:
`playbackUrlKind: 'hls'` without `private: true`, and `visibility: 'private'` with the player page
(the public player returns 404 for private videos).

---

## Limits and behavior

| | |
|---|---|
| Maximum video size | **5 GiB**, enforced by `checkFileSize` before any bytes move. Strapi's own `sizeLimit` still applies and the tighter of the two wins. |
| Memory per upload | `partSizeBytes × uploadConcurrency` (75 MiB at defaults). The file is never held in full and never spooled to a temp file. |
| Failed upload | The multipart upload is aborted, which also removes the half-made video record. Nothing is left behind and nothing is billed. |
| Expired presigned URL | Re-minted once and the part is retried. A second failure is a real one and surfaces. |
| Delete | Calls the video delete RPC. A video that is already gone counts as deleted. |
| Non-video files | Never touch Transcodely. No RPC is made at all. |
| Errors | Carry the API's own machine-readable code (`permission_denied`, `limit_exceeded`, `hosting_provisioning_failed`, …). Raw response bodies, presigned URLs and storage keys are never logged. |

### uploadStream vs upload

Both are implemented. Strapi v5 calls `uploadStream` whenever a provider defines it, so that is the
path essentially every upload takes.

**The stream is consumed part by part and PUT as it is read** — not spooled to a temp file, not
buffered whole. That is possible because Strapi hands over the exact byte count in
`file.sizeInBytes`, which is what `CreateMultipartUpload` needs to declare `total_parts`, and the
API refuses a completion whose part count does not match. The bytes actually read are checked
against the declared size before the upload is completed; a mismatch aborts rather than completing a
corrupt file.

### Billing

Uploading a video creates a real transcoding job and it is billed. `autoCaptions` adds a
per-source-minute fee. `hoverPreviews` is free. Set a [monthly spend limit](https://transcodely.com/docs) on the app before you point
a production Strapi at it.

---

## Development

```bash
npm install
npm run lint
npm run build
npm test
```

Tests run against a mock Connect-RPC server on loopback and never reach the network.

## Support

Community integration, maintained by Transcodely. Issues and pull requests are welcome at
[github.com/transcodely/strapi-provider-upload-transcodely](https://github.com/transcodely/strapi-provider-upload-transcodely).
For API questions: [transcodely.com/docs](https://transcodely.com/docs) or support@transcodely.com.

## License

MIT
