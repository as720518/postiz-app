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
                value = { err: true, value: 'Unknown Error' };
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
    join(
      repoRoot,
      'libraries/nestjs-libraries/src/integrations/x-upload-error.ts'
    ),
  ],
  { stdio: 'inherit' }
);
if (tsc.status !== 0) {
  process.exit(tsc.status ?? 1);
}

const helperName = 'x-upload-error.js';
const helper = readFileSync(join(compiledDir, helperName));
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

const abstractOut = join(outDir, 'social.abstract.js');
const helperOut = join(outDir, helperName);
writeFileSync(abstractOut, patched);
writeFileSync(helperOut, helper);

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
      const err = Object.assign(new Error('SECRET_ONLY_IN_MESSAGE ' + secret), {
        name: 'ApiResponseError', error: true, type: 'response', code: 400,
        headers: { authorization: 'Bearer ' + secret },
        request: { url: 'https://cdn.example/a?token=' + secret },
        data: {
          title: 'Invalid media',
          detail: 'Animated GIF is not allowed',
          type: 'https://api.twitter.com/2/problems/invalid-request',
          errors: [{ code: sentinel, message: 'ab12cd34ef56' }],
        },
      });
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
  `${baseHash}  social.abstract.js.unmodified-base`,
].join('\n');
writeFileSync(join(outDir, 'SHA256SUMS'), `${sums}\n`);
console.log(sums);
