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
  verifies the tag points at the checked commit, requires a matching
  `docs/release-notes/<tag>.md` file, builds debug + release APKs, requires
  Android signing secrets, and creates/updates the GitHub Release with only
  signed release APK assets and checksums.

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

Current release flow:

1. Draft human-readable release notes before tagging. Add
   `docs/release-notes/vX.Y.Z.md` for the exact release tag and commit it with
   the release prep. See `docs/release-notes/README.md` and
   `docs/release-notes/TEMPLATE.md`.
2. Merge the release commit to `master`.
3. Tag the merge commit, for example:

   ```bash
   git tag v1.0.0
   git push origin master --tags
   ```

4. Let the GitHub Release workflow finish. It fails clearly if
   `docs/release-notes/<tag>.md` is missing or empty.
5. Testers download `*-release-signed.apk` from the GitHub Release assets.
   Debug APKs are available only from CI artifacts for engineering smoke tests.
6. Web stays on the same train because the same tag/version passed the web gates.

GitHub Releases and Firebase App Distribution use the same checked-in release
notes file for the tag. Edit that file before tagging; do not rely on generated
release notes or separate Firebase-only text.

Android does not currently have in-app update plumbing. For GitHub-release APK
installs, testers manually download/install the newer APK. If/when Play testing
is enabled, Play handles update delivery for enrolled testers.

## Firebase App Distribution tester setup (David-only)

The release workflow can optionally upload the signed release APK to Firebase
App Distribution after the GitHub Release assets are created. GitHub Release
publishing still works when Firebase is not configured.

Current Firebase setup contract:

- `FIREBASE_ANDROID_APP_ID` is set as a GitHub repository secret for the Clawkie
  Talkie Android Firebase app.
- `FIREBASE_SERVICE_ACCOUNT_JSON` is set as a GitHub repository secret from the
  `clawkie-firebase-distribution@clawkie-talkie.iam.gserviceaccount.com` service
  account. That account has `roles/firebaseappdistro.admin` on project
  `clawkie-talkie`.
- The workflow uploads to tester group `trusted-testers` by default. That group
  exists in Firebase App Distribution. To use a different group, set repository
  variable `FIREBASE_APP_DISTRIBUTION_GROUPS` to a comma-separated list of
  Firebase tester group aliases.
- The uploaded/downloaded `google-services.json` is not committed and is not
  required for the App Distribution upload. The workflow authenticates only with
  the service-account JSON secret, written to a temporary runner file.

To add testers, add their email addresses to the `trusted-testers` group in the
Firebase Console, or use Firebase CLI with the configured service account:

```bash
firebase appdistribution:testers:add person@example.com \
  --group-alias trusted-testers \
  --project clawkie-talkie
```

Do not commit `google-services.json`, service-account JSON, Play credentials,
Firebase tokens, or any other signing/distribution material.

## Optional Play tester setup (David-only)

If Google Play internal testing is needed later, create the Play app, upload a
signed artifact, configure testers, and promote through internal/closed tracks as
needed. Keep Play upload credentials in GitHub Secrets or the relevant provider
secret store.

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
