# Clawkie Talkie Android/web release process

Clawkie Talkie ships web and Android on one release train. The browser client
is current-by-definition at https://clawkietalkie.app; Android release tags pin
which native APK mirrors the web protocol and reducer contract at that point.

## Branch and version expectations

- Do release prep on a normal feature/release branch, then merge to `master`.
- Release tags use `v<package.json version>` (for example `v1.0.0`).
- Keep `package.json` `version` and Android `versionName` identical.
- Keep Android `versionCode` deterministic from semver:

  ```text
  versionCode = major * 1,000,000 + minor * 1,000 + patch + 1
  ```

  Examples: `0.0.0` → `1`, `0.0.1` → `2`, `1.0.0` → `1000001`.

Run this before opening/releasing:

```bash
npm run version:check
```

## Shared no-drift contract

Cross-platform fixtures live in `shared/contract/`:

- `protocol-messages.json` pins the WebRTC data-channel control message shapes.
- `driving-reducer.json` pins user-visible driving state transitions.

Both web Vitest and Android JUnit read those same JSON files. When protocol or
reducer behavior intentionally changes, update the fixtures and both platform
implementations in the same branch.

## Local release gates

From the repo root:

```bash
npm ci
npm run version:check
npm test
npm run typecheck
npm run build
```

Then Android:

```bash
cd android
./gradlew testDebugUnitTest assembleDebug assembleRelease
```

CI runs the same gates for PRs/pushes and uploads the debug APK artifact.

## GitHub Actions

- `.github/workflows/ci.yml` runs web tests/typecheck/build, Android unit tests,
  Android `assembleDebug`, and uploads `app-debug.apk`.
- `.github/workflows/release.yml` runs all gates on `v*` tags or manual dispatch,
  checks out the requested tag, requires it to equal `v<package.json version>`,
  verifies the tag points at the checked commit, builds debug + release APKs,
  requires Android signing secrets, and creates/updates the GitHub Release with
  only signed release APK assets and checksums.

Ordinary CI does **not** require signing secrets and may upload debug APKs as CI
artifacts. GitHub Releases must not publish debug APK assets.

## Android signing secrets (David-only)

Create one Android upload/release keystore and store it outside the repo. Add
these repository secrets before publishing signed release APKs:

- `ANDROID_SIGNING_KEYSTORE_BASE64` — base64 of the `.jks`/`.keystore` file.
- `ANDROID_SIGNING_KEY_ALIAS` — key alias inside the keystore.
- `ANDROID_SIGNING_KEYSTORE_PASSWORD` — keystore password.
- `ANDROID_SIGNING_KEY_PASSWORD` — key password.

The release workflow decodes the keystore only inside the GitHub runner, signs
`app-release-unsigned.apk` with Android SDK `zipalign`/`apksigner`, verifies the
signed APK, and uploads `clawkie-talkie-<tag>-release-signed.apk`. If any signing
secret is missing, the release workflow fails before publishing assets. Use the
CI debug APK artifact for engineering smoke tests only.

Do not commit keystores, passwords, Play credentials, Firebase tokens, or any
other signing material.

## Tester/download/update story

Current first-version flow:

1. Merge the release commit to `master`.
2. Tag the merge commit, for example:

   ```bash
   git tag v1.0.0
   git push origin master --tags
   ```

3. Let the GitHub Release workflow finish.
4. Testers download `*-release-signed.apk` from the GitHub Release assets.
   Debug APKs are available only from CI artifacts for engineering smoke tests.
5. Web stays on the same train because the same tag/version passed the web gates.

Android does not currently have in-app update plumbing. For GitHub-release APK
installs, testers manually download/install the newer APK. If/when Play testing
is enabled, Play handles update delivery for enrolled testers.

## Optional Firebase / Play tester setup (David-only)

If broader tester distribution is needed, choose one:

- Firebase App Distribution: create the Android app, upload the signed APK, add
  tester groups, and document tester invitation steps here.
- Google Play internal testing: create the Play app, upload a signed artifact,
  configure testers, and promote through internal/closed tracks as needed.

The repository does not currently store service-account JSON or Play upload
credentials. Add automation only after deciding the distribution target, and keep
credentials in GitHub Secrets or the relevant provider secret store.

## Domain App Links / assetlinks setup

Android declares App Links for Clawkie Talkie URLs, and the repository commits
the generated signing-key source file at
`client/public/.well-known/assetlinks.json` for package `app.clawkietalkie`. The
file includes the standard `delegate_permission/common.handle_all_urls` relation
and the generated signing certificate SHA-256 fingerprint.

After the web deploy that includes this file:

1. Verify https://clawkietalkie.app/.well-known/assetlinks.json returns the
   committed package/fingerprint entry.
2. Install the signed APK and verify Android opens `/voice#...` and
   `/dashboard#...` links directly without the chooser.

Until assetlinks is deployed and Android verifies the domain, Android may show
the app/browser disambiguation sheet; that is expected and documented in
`android/README.md`.
