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
```

The API key is a **secret** server-side key. It never leaves your Strapi server: uploads are
streamed from Strapi to presigned storage URLs, and nothing in the admin panel or the public API
ever sees it. `baseUrl` must be `https://` unless it is loopback, because that key rides an
`Authorization` header on every request.

You do not have to turn managed hosting on for the app first. Asking Transcodely to store a video
*is* the request to be hosted, so the first upload provisions the app's bucket, managed origin and
CDN pull zone on the way through. That first upload therefore takes a few seconds longer than the
ones after it, and it can come back `hosting_provisioning_failed` — which creates no video and is
safe to retry unchanged.

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
| `appId` | string | resolved from the key | App the videos are created under (`app_…`). Rarely needed, see below. |
| `baseUrl` | string | `https://api.transcodely.com` | API base URL. |
| `playerBaseUrl` | string | `https://play.transcodely.com` | Base for composed player-page URLs. |
| `visibility` | `public` \| `unlisted` \| `private` | the app's default | Visibility of created videos. Leave unset to use the app's `default_visibility` (itself `unlisted` when unset). |
| `playbackUrlKind` | `player` \| `hls` | `player` | What lands in `file.url`: the player page, or the HLS manifest. |
| `private` | boolean | `false` | Set true when the app has CDN token auth on, so Strapi asks for a fresh signed URL on every read. A private fallback bucket turns signing on by itself, see below. |
| `preset` | string | — | Preset id or slug driving the encode instead of the app's auto-profile. |
| `hoverPreviews` | boolean | `false` | Attach an animated hover preview. Free. |
| `autoCaptions` | boolean | `false` | Generate AI captions inline with the transcode. **Billed per source minute.** |
| `videoExtensions` | string[] | `.mkv .m2ts .mts .ts .mxf` | Extensions treated as video whatever the MIME type says, for containers that sniff as `application/octet-stream`. Replaces the default list rather than adding to it. |
| `videoMimePrefixes` | string[] | `[]` | Extra MIME prefixes to treat as video, beyond `video/`. |
| `partSizeBytes` | number | 25 MiB | Multipart part size. Minimum 5 MiB. |
| `uploadConcurrency` | number | `3` | Parts PUT in parallel. Peak memory is `partSizeBytes × uploadConcurrency`. |
| `requestTimeoutMs` | number | `60000` | Per-RPC timeout. |
| `partTimeoutMs` | number | `300000` | Timeout for a single part PUT. |
| `fallbackProvider` | string \| module | `'local'` | Provider handling non-video files. Resolved as `@strapi/provider-upload-<name>`, then as a bare module name; a required module object also works. |
| `fallbackProviderOptions` | object | `{}` | Options passed to the fallback provider's `init`. |

### The app id

**You do not normally need one.** An `ak_` key already names exactly one app, and from Transcodely
API 5.20.0 the upload endpoints resolve it from the key. The provider sends no `app_id` at all.

Set `appId` only to pin a specific app explicitly, or to skip one extra request on a Transcodely
deployment older than 5.20.0. On those older deployments `app_id` was a required field, and a
key-only call is refused; the provider then reads the app off your most recent job once, caches it,
and carries on. That compatibility path runs only after a server has actually refused, so it
disappears on its own once the deployment upgrades. An account with no jobs yet gets an explicit
error telling you to set the option.

### Keeping images on the local provider

That is the default. `fallbackProvider: 'local'` is `@strapi/provider-upload-local`, which every
Strapi project already ships. To keep images on S3 instead:

```js
providerOptions: {
  apiKey: env('TRANSCODELY_API_KEY'),
  fallbackProvider: 'aws-s3',
  fallbackProviderOptions: {
    s3Options: { /* … the aws-s3 provider's own options … */ },
  },
}
```

Routing is by MIME type (`video/*`) with `videoExtensions` as the escape hatch. Strapi's generated
image formats (`thumbnail`, `small`, `medium`, `large`) are images, so they always go to the
fallback.

Two things this provider does on the fallback's behalf, because Strapi's own defaults stop applying
the moment any provider overrides them: your `sizeLimit` is enforced for non-video files even when
the fallback implements no size check (`aws-s3` does not), and a private fallback bucket still gets
signed URLs (see "Private buckets and signing").

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

`previewUrl` is normally left empty: the poster frame is generated by the transcode, so it does not
exist yet when the upload finishes and nothing writes the record a second time. The admin panel
never reads that field anyway — REST and GraphQL consumers do.

### Media library preview

**The media library card will not show a preview for a hosted video, and it is worth knowing why
before you install this.**

Strapi's admin renders a video asset as a plain `<video src={url} crossOrigin="anonymous">`, where
`url` is `formats.thumbnail.url` if present and `file.url` otherwise. Neither of this provider's URL
shapes is something that element can play: the player page is an HTML document, and a bare HLS
manifest plays only in Safari. So the card stays blank and its duration never renders. This is not
the processing window — it does not resolve when the transcode lands.

Two things help:

1. **Turn on `hoverPreviews`.** It is free, and it produces a short muted **MP4** loop — the one
   artifact a `<video>` element can play. When the API hands that URL back, this provider writes it
   into `formats.thumbnail.url` and the card renders.
2. **Write it back when the video is ready.** The MP4 does not exist at upload time, and an upload
   provider gets exactly one write. A `video.ready` webhook (or a cron over videos still marked
   `processing`) closes the gap:

```js
// Sketch: on video.ready, point the card at the MP4 preview.
const file = await strapi.db.query('plugin::upload.file').findOne({
  where: { provider_metadata: { $contains: event.data.id } },
});
if (file) {
  await strapi.db.query('plugin::upload.file').update({
    where: { id: file.id },
    data: {
      formats: {
        ...file.formats,
        thumbnail: {
          name: `thumbnail_${file.name}`,
          hash: `thumbnail_${file.hash}`,
          ext: '.mp4',
          mime: 'video/mp4',
          url: event.data.hover_preview_mp4_url,
          provider_metadata: file.provider_metadata,
        },
      },
      provider_metadata: { ...file.provider_metadata, status: 'ready' },
    },
  });
}
```

`file.url` is unaffected either way. It is the URL for your **frontend** — the player page in an
`<iframe>`, or the HLS manifest in your own player — and it is correct from the moment the upload
finishes.

### Private buckets and signing

Strapi asks a provider **once**, globally, whether URLs need signing, and that one answer covers
videos and images alike. So `isPrivate()` here is the OR of both halves: the `private` option above,
and whatever the fallback provider answers. If you point `fallbackProvider` at a private `aws-s3`
bucket, signing switches on for the whole media library even with `private: false` — which is what
you want, and without it every image URL would be served unsigned and 403.

Videos do not pay for that. When `private` is false, a hosted video's signed-URL lookup returns its
stored permanent URL without calling the API, so an images-only reason to sign does not cost a
request per video per page.

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
| Maximum size of everything else | Strapi's `sizeLimit`, enforced here even when the fallback provider has no size check of its own (`@strapi/provider-upload-aws-s3` does not). |
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
