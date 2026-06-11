#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJsonPath = resolve(root, 'package.json');
const androidBuildPath = resolve(root, 'android/app/build.gradle.kts');

function fail(message) {
  console.error(`version:check failed: ${message}`);
  process.exitCode = 1;
}

function expectedAndroidVersionCode(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    throw new Error(`package.json version must be plain major.minor.patch semver for Android releases; got ${version}`);
  }
  const [, majorRaw, minorRaw, patchRaw] = match;
  const major = Number(majorRaw);
  const minor = Number(minorRaw);
  const patch = Number(patchRaw);
  if (major > 2099 || minor > 999 || patch > 999) {
    throw new Error(`version ${version} exceeds Android versionCode packing limits major<=2099, minor<=999, patch<=999`);
  }
  // Monotonic packing: 0.0.0 => 1, 0.0.1 => 2, 1.0.0 => 1,000,001.
  // This preserves ordering for every semver bump while staying below the
  // Play Store max versionCode (2,100,000,000) through 2099.999.999.
  return major * 1_000_000 + minor * 1_000 + patch + 1;
}

const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
const androidBuild = readFileSync(androidBuildPath, 'utf8');

const androidVersionName = androidBuild.match(/versionName\s*=\s*"([^"]+)"/)?.[1];
const androidVersionCodeRaw = androidBuild.match(/versionCode\s*=\s*(\d+)/)?.[1];
const packageVersion = packageJson.version;

try {
  if (typeof packageVersion !== 'string') fail('package.json version is missing or not a string');
  if (!androidVersionName) fail('android/app/build.gradle.kts versionName is missing');
  if (!androidVersionCodeRaw) fail('android/app/build.gradle.kts versionCode is missing');

  if (packageVersion && androidVersionName && packageVersion !== androidVersionName) {
    fail(`package.json version ${packageVersion} does not match Android versionName ${androidVersionName}`);
  }

  if (packageVersion && androidVersionCodeRaw) {
    const expected = expectedAndroidVersionCode(packageVersion);
    const actual = Number(androidVersionCodeRaw);
    if (actual !== expected) {
      fail(`Android versionCode ${actual} does not match semver-packed ${expected} for ${packageVersion}`);
    }
    if (actual <= 0 || actual > 2_100_000_000) {
      fail(`Android versionCode ${actual} must be between 1 and 2,100,000,000`);
    }
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

if (process.exitCode) process.exit(process.exitCode);
console.log(`version:check ok — web ${packageVersion}, Android versionName ${androidVersionName}, versionCode ${androidVersionCodeRaw}`);
