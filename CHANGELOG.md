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
- Pins the calendar API version `2026-05-03` on every request.
