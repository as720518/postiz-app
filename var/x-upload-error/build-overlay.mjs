#!/usr/bin/env node
// Rebuilds the CommonJS overlay for the verified v2.25.1 image.
// Usage:
//   node var/x-upload-error/build-overlay.mjs \
//     --base /path/to/image/social.abstract.js \
//     --out /path/to/overlay-dir
//
// The base file must be the unmodified orchestrator (or backend) copy from
// ghcr.io/gitroomhq/postiz-app@sha256:d2b37802e96757729fdea2d3d71287f841c2b619faa1cb4c21dac07df657fde1
// at apps/{orchestrator,backend}/dist/libraries/nestjs-libraries/src/integrations/social.abstract.js

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXPECTED_BASE_SHA256 =
  '1bacc5d00ef654ebe5b7cabef2e315ee81acb63a5681b18949b9dab153bcd968';
const EXPECTED_PROVIDER_SHA256 =
  'caaf125aebe2431b7db63d92054597683455d593a66390a4d62794e5000ad7e4';

const PROVIDER_IMAGE_UPLOAD = `                    : client.v2.uploadMedia(await (0, sharp_1.default)(await this.readOrFetch(m.path), {
                                animated: (0, mime_types_1.lookup)(m.path) === 'image/gif',
                            })
                                .resize({
                                width: 1000,
                            })
                                .gif()
                                .toBuffer(), {
                                media_type: ((0, mime_types_1.lookup)(m.path) || ''),
                            })),`;

const PROVIDER_IMAGE_UPLOAD_PATCHED = `                    : await (async () => {
                                const prepared = await (0, x_image_media_1.encodeXImage)(await this.readOrFetch(m.path), async (bytes, kind) => {
                                    const pipeline = (0, sharp_1.default)(bytes, kind === 'gif' ? { animated: true } : undefined).resize({ width: 1000 });
                                    if (kind === 'gif')
                                        return pipeline.gif().toBuffer();
                                    if (kind === 'png')
                                        return pipeline.png().toBuffer();
                                    return pipeline.jpeg().toBuffer();
                                });
                                return client.v2.uploadMedia(prepared.buffer, {
                                    media_type: prepared.mediaType,
                                    media_category: prepared.mediaCategory,
                                });
                            })()),`;

const LEGACY_CATCH = `        catch (err) {
            const handle = this.handleErrors(safeStringify(err), 200);
            value = { err: true, value: 'Unknown Error', ...(handle || {}) };
            globalErr = err;
        }`;

const PATCHED_CATCH = `        catch (err) {
            const resolution = (0, x_upload_error_1.resolveConcurrentProviderError)({
                identifier: this.identifier,
                err,
                alreadyClassified: err instanceof BadBody ||
                    err instanceof RefreshToken ||
                    err instanceof Disconnect,
                handleErrors: (body, status) => this.handleErrors(body, status),
            });
            if (resolution.action === 'rethrow-classified') {
                throw err;
            }
            if (resolution.action === 'throw') {
                const message = resolution.message;
                const safeJson = resolution.safeJson;
                if (resolution.failureType === 'refresh-token') {
                    throw new RefreshToken(this.identifier, safeJson, '{}', message);
                }
                if (resolution.failureType === 'disconnect') {
                    throw new Disconnect(this.identifier, safeJson, '{}', message);
                }
                throw new BadBody(this.identifier, safeJson, '{}', message);
            }
            if (this.identifier === 'x') {
                value = { err: true, value: 'X rejected the media upload (unclassified)' };
                globalErr = {};
            }
            else {
                const handle = this.handleErrors(safeStringify(err), 200);
                value = { err: true, value: 'Unknown Error', ...(handle || {}) };
                globalErr = err;
            }
        }`;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');

function arg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || !process.argv[index + 1]) {
    throw new Error(`missing ${name}`);
  }
  return resolve(process.argv[index + 1]);
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

const basePath = arg('--base');
const providerBasePath = arg('--provider');
const outDir = arg('--out');
mkdirSync(outDir, { recursive: true });

const base = readFileSync(basePath);
const baseHash = sha256(base);
if (baseHash !== EXPECTED_BASE_SHA256) {
  console.error(
    JSON.stringify(
      {
        error: 'base social.abstract.js fingerprint mismatch',
        expected: EXPECTED_BASE_SHA256,
        actual: baseHash,
        basePath,
      },
      null,
      2
    )
  );
  process.exit(2);
}

const tscDir = join(outDir, '.tsc');
mkdirSync(tscDir, { recursive: true });
const typescriptPkg = join(tscDir, 'node_modules', 'typescript', 'package.json');
if (!existsSync(typescriptPkg)) {
  const install = spawnSync(
    'npm',
    ['install', '--prefix', tscDir, 'typescript@5.5.4', '--no-fund', '--no-audit'],
    { stdio: 'inherit' }
  );
  if (install.status !== 0) {
    process.exit(install.status ?? 1);
  }
}

const compiledDir = join(outDir, '.compiled');
mkdirSync(compiledDir, { recursive: true });
const tsc = spawnSync(
  process.execPath,
  [
    join(tscDir, 'node_modules', 'typescript', 'lib', 'tsc.js'),
    '--strict',
    '--target',
    'ES2021',
    '--module',
    'commonjs',
    '--moduleResolution',
    'node',
    '--esModuleInterop',
    '--skipLibCheck',
    '--outDir',
    compiledDir,
    join(repoRoot, 'libraries/nestjs-libraries/src/integrations/x-upload-error.ts'),
    join(repoRoot, 'libraries/nestjs-libraries/src/integrations/x-image-media.ts'),
  ],
  { stdio: 'inherit' }
);
if (tsc.status !== 0) {
  process.exit(tsc.status ?? 1);
}

const helperName = 'x-upload-error.js';
const imageMediaName = 'x-image-media.js';
const helper = readFileSync(join(compiledDir, helperName));
const imageMedia = readFileSync(join(compiledDir, imageMediaName));
if (!imageMedia.includes('exports.encodeXImage') || !imageMedia.includes('exports.sniffImageKind')) {
  throw new Error('compiled image helper is incomplete');
}
if (!helper.includes('exports.resolveConcurrentProviderError')) {
  throw new Error('compiled helper is missing resolveConcurrentProviderError');
}
if (helper.includes('require("tslib")') || helper.includes("require('tslib')")) {
  throw new Error('compiled helper unexpectedly depends on tslib');
}

const requireLine = 'const stream_1 = require("stream");';
const baseText = base.toString('utf8');
if (!baseText.includes(requireLine) || !baseText.includes(LEGACY_CATCH)) {
  throw new Error('base file does not contain the expected require or catch');
}
if (baseText.includes('x-upload-error')) {
  throw new Error('base file already references x-upload-error');
}

const patched =
  baseText.replace(
    requireLine,
    `${requireLine}\nconst x_upload_error_1 = require("./x-upload-error");`
  ).replace(LEGACY_CATCH, PATCHED_CATCH);

if (patched === baseText || !patched.includes(PATCHED_CATCH)) {
  throw new Error('patch was not applied');
}
const withoutStaleMap = patched.replace(/\n\/\/# sourceMappingURL=social\.abstract\.js\.map\s*$/, '\n');
if (withoutStaleMap.includes('sourceMappingURL')) {
  throw new Error('stale source map was not removed');
}

const abstractOut = join(outDir, 'social.abstract.js');
const helperOut = join(outDir, helperName);
writeFileSync(abstractOut, withoutStaleMap);
writeFileSync(helperOut, helper);
writeFileSync(join(outDir, imageMediaName), imageMedia);

const providerBase = readFileSync(providerBasePath);
const providerHash = sha256(providerBase);
if (providerHash !== EXPECTED_PROVIDER_SHA256) {
  console.error(JSON.stringify({
    error: 'base x.provider.js fingerprint mismatch',
    expected: EXPECTED_PROVIDER_SHA256,
    actual: providerHash,
  }, null, 2));
  process.exit(2);
}
const providerText = providerBase.toString('utf8');
if (!providerText.includes(PROVIDER_IMAGE_UPLOAD)) {
  throw new Error('base x.provider.js does not contain the GIF/filename upload block');
}
const providerRequire = 'const mime_types_1 = require("mime-types");';
if (!providerText.includes(providerRequire)) {
  throw new Error('base x.provider.js is missing the mime-types require');
}
let providerPatched = providerText
  .replace(providerRequire, `${providerRequire}\nconst x_image_media_1 = require("../x-image-media");`)
  .replace(PROVIDER_IMAGE_UPLOAD, PROVIDER_IMAGE_UPLOAD_PATCHED)
  .replace(/\n\/\/# sourceMappingURL=x\.provider\.js\.map\s*$/, '\n');
if (!providerPatched.includes('encodeXImage') || providerPatched.includes("lookup)(m.path) === 'image/gif'")) {
  throw new Error('x.provider.js image upload patch was not applied');
}
if (providerPatched.includes('sourceMappingURL')) {
  throw new Error('stale x.provider.js source map was not removed');
}
const providerOut = join(outDir, 'x.provider.js');
writeFileSync(providerOut, providerPatched);
const providerSyntax = spawnSync(process.execPath, ['--check', providerOut], { stdio: 'inherit' });
if (providerSyntax.status !== 0) process.exit(providerSyntax.status ?? 1);
const imageSyntax = spawnSync(process.execPath, ['--check', join(outDir, imageMediaName)], { stdio: 'inherit' });
if (imageSyntax.status !== 0) process.exit(imageSyntax.status ?? 1);

const syntax = spawnSync(process.execPath, ['--check', abstractOut], {
  stdio: 'inherit',
});
if (syntax.status !== 0) {
  process.exit(syntax.status ?? 1);
}
const helperSyntax = spawnSync(process.execPath, ['--check', helperOut], {
  stdio: 'inherit',
});
if (helperSyntax.status !== 0) {
  process.exit(helperSyntax.status ?? 1);
}

const check = spawnSync(
  process.execPath,
  [
    '--experimental-strip-types',
    '--test',
    join(repoRoot, 'libraries/nestjs-libraries/src/integrations/x-upload-error.test.ts'),
    join(repoRoot, 'libraries/nestjs-libraries/src/integrations/x-image-media.test.ts'),
  ],
  { cwd: repoRoot, stdio: 'inherit' }
);
if (check.status !== 0) {
  process.exit(check.status ?? 1);
}

const artifactHelper = readFileSync(helperOut);
const runtime = spawnSync(
  process.execPath,
  [
    '-e',
    `
      const { resolveConcurrentProviderError } = require(${JSON.stringify(helperOut)});
      const secret = 'SUPERSECRETTOKENVALUE';
      const sentinel = 'SYNTHETICCredentialSentinel123456789';
      const ctor = function ApiResponseError() {};
      Object.defineProperty(ctor, 'name', { value: 'ApiResponseError' });
      const err = Object.assign(new Error('SECRET_ONLY_IN_MESSAGE ' + secret), {
        error: true, type: 'response', code: 400,
        headers: { authorization: 'Bearer ' + secret },
        request: { url: 'https://cdn.example/a?token=' + secret },
        data: {
          title: 'Invalid media',
          detail: 'Animated GIF is not allowed',
          type: 'https://api.twitter.com/2/problems/invalid-request',
          errors: [{ code: sentinel, message: 'ab12cd34ef56' }],
        },
      });
      Object.defineProperty(err, 'constructor', { value: ctor });
      const result = resolveConcurrentProviderError({ identifier: 'x', err, alreadyClassified: false });
      if (result.action !== 'throw') process.exit(3);
      const packed = JSON.stringify(result);
      if (packed.includes(secret) || packed.includes(sentinel) || packed.includes('ab12cd34ef56') || packed.includes('cdn.example') || packed.includes('Bearer')) process.exit(4);
      if (!result.message.includes('HTTP 400') || !result.message.includes('invalid-request')) process.exit(5);
      if (result.failureType !== 'bad-body') process.exit(6);
      const unknown = resolveConcurrentProviderError({
        identifier: 'x', err: Object.assign(new Error('x'), {
          name: 'ApiResponseError', error: true, type: 'response', code: 400,
          data: { type: 'https://api.x.com/2/problems/' + sentinel, errors: [{ code: 'ab12cd34ef56' }] },
        }), alreadyClassified: false,
      });
      const unknownPacked = JSON.stringify(unknown);
      if (unknownPacked.includes(sentinel) || unknownPacked.includes('ab12cd34ef56')) process.exit(7);
    `,
  ],
  { stdio: 'inherit' }
);
if (runtime.status !== 0) {
  throw new Error(`compiled helper self-check failed: ${runtime.status}`);
}

copyFileSync(abstractOut, join(outDir, 'social.abstract.js'));
const sums = [
  `${sha256(readFileSync(abstractOut))}  social.abstract.js`,
  `${sha256(artifactHelper)}  x-upload-error.js`,
  `${sha256(readFileSync(providerOut))}  x.provider.js`,
  `${sha256(imageMedia)}  x-image-media.js`,
  `${baseHash}  social.abstract.js.unmodified-base`,
  `${providerHash}  x.provider.js.unmodified-base`,
].join('\n');
writeFileSync(join(outDir, 'SHA256SUMS'), `${sums}\n`);
console.log(sums);
