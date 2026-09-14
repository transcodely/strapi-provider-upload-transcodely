# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- First release. A Strapi v5 upload provider that stores video uploads as hosted Transcodely
  videos through the multipart upload RPCs and passes every other file to a configurable
  fallback provider (`local` by default).
- `upload`, `uploadStream`, `delete`, `checkFileSize`, `getSignedUrl` and `isPrivate`.
- Player-page or HLS-manifest URLs, selected with `playbackUrlKind`.
- Writes the free MP4 hover preview into `formats.thumbnail.url` when the API has produced one,
  which is the only artifact Strapi's media-library card can play.
- Pins the calendar API version `2026-05-03` on every request.
- Uploads send no `app_id`: the API key already names its app and Transcodely API 5.20.0 resolves
  it. `appId` stays available to pin an app explicitly. Against a deployment older than 5.20.0,
  where the field was required, the provider recovers by reading the app off the most recent job
  once and caching it — a path that runs only after a refusal and retires itself on upgrade.

### Notes from pre-release review

Fixed before the first publish, listed because each is a trap for anyone writing a similar
provider:

- Defining `checkFileSize` shadows Strapi's own prototype check, so delegating a non-video to a
  fallback that does not implement it (`@strapi/provider-upload-aws-s3` does not) would have
  disabled `sizeLimit` for every image. The base rule is reimplemented here instead.
- Strapi asks a provider once, globally, whether URLs need signing, so `isPrivate()` is the OR of
  this provider's setting and the fallback's. A private S3 bucket behind a public Transcodely app
  would otherwise have served every image unsigned.
- Connect-RPC error details live under `detail.debug` in protojson camelCase, and protovalidate
  rejections carry no details at all — only a message and an `x-validation-fields` header.
- The default fallback is resolved from the Strapi project, not from this package, so pnpm's
  isolated layout finds `@strapi/provider-upload-local`.
- Streams are destroyed on every exit path, and part buffers are no longer copied on the way into
  `fetch`.
