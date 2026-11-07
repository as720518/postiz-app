#!/usr/bin/env node
// Offline integration: real twitter-api-v2@1.29.0 uploadMedia, mocked https,
// production x.provider.js, and the fingerprinted social.abstract.js overlay.
// No network and no credentials.

import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync, copyFileSync, symlinkSync, rmSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return resolve(process.argv[index + 1]);
}

const abstractSrc = arg('--abstract');
const helperSrc = arg('--helper');
const providerSrc = arg('--provider');
const imageMediaSrc = arg('--image-media');
if (!abstractSrc || !helperSrc || !providerSrc || !imageMediaSrc) {
  console.error('usage: --abstract social.abstract.js --helper x-upload-error.js --provider x.provider.js --image-media x-image-media.js');
  process.exit(2);
}

const sdkRoot = '/tmp/tw-sdk';
if (!existsSync(join(sdkRoot, 'node_modules/twitter-api-v2/package.json'))) {
  const install = spawnSync(
    'npm',
    ['install', '--prefix', sdkRoot, 'twitter-api-v2@1.29.0', 'tslib@2.8.1', '--no-fund', '--no-audit'],
    { stdio: 'inherit' }
  );
  if (install.status !== 0) process.exit(install.status ?? 1);
} else if (!existsSync(join(sdkRoot, 'node_modules/tslib/package.json'))) {
  const install = spawnSync(
    'npm',
    ['install', '--prefix', sdkRoot, 'tslib@2.8.1', '--no-fund', '--no-audit'],
    { stdio: 'inherit' }
  );
  if (install.status !== 0) process.exit(install.status ?? 1);
}

const root = '/tmp/x-upload-itree';
rmSync(root, { recursive: true, force: true });
const integrations = join(root, 'libraries/nestjs-libraries/src/integrations');
mkdirSync(join(integrations, 'social'), { recursive: true });
mkdirSync(join(root, 'libraries/nestjs-libraries/src/temporal'), { recursive: true });
mkdirSync(join(root, 'libraries/nestjs-libraries/src/dtos/webhooks'), { recursive: true });
mkdirSync(join(root, 'libraries/nestjs-libraries/src/dtos/posts/providers-settings'), { recursive: true });
mkdirSync(join(root, 'libraries/nestjs-libraries/src/chat'), { recursive: true });
mkdirSync(join(root, 'libraries/helpers/src/utils'), { recursive: true });
mkdirSync(join(root, 'libraries/helpers/src/decorators'), { recursive: true });
mkdirSync(join(root, 'node_modules/@temporalio'), { recursive: true });
mkdirSync(join(root, 'node_modules/mime-types'), { recursive: true });

copyFileSync(abstractSrc, join(integrations, 'social.abstract.js'));
copyFileSync(helperSrc, join(integrations, 'x-upload-error.js'));
copyFileSync(imageMediaSrc, join(integrations, 'x-image-media.js'));
copyFileSync(providerSrc, join(integrations, 'social/x.provider.js'));

function write(path, source) {
  writeFileSync(path, source);
}

write(join(root, 'node_modules/@temporalio/activity.js'), `
class ApplicationFailure extends Error {
  constructor(message, type, nonRetryable, details) {
    super(message);
    this.type = type;
    this.nonRetryable = nonRetryable === true;
    this.details = details;
  }
}
exports.ApplicationFailure = ApplicationFailure;
`);
const sharpInstall = spawnSync(
  'npm',
  ['install', '--prefix', sdkRoot, 'sharp@0.33.5', '--no-fund', '--no-audit'],
  { stdio: 'inherit' }
);
if (sharpInstall.status !== 0) process.exit(sharpInstall.status ?? 1);
symlinkSync(join(sdkRoot, 'node_modules/sharp'), join(root, 'node_modules/sharp'));
write(join(root, 'node_modules/mime-types/index.js'), `
exports.lookup = (path) => {
  if (String(path).endsWith('.gif')) return 'image/gif';
  if (String(path).endsWith('.jpg') || String(path).endsWith('.jpeg')) return 'image/jpeg';
  return false;
};
`);
write(join(root, 'node_modules/mime-types/package.json'), '{"name":"mime-types","main":"index.js"}\n');
write(join(root, 'libraries/nestjs-libraries/src/temporal/temporal.heartbeat.js'), 'exports.setHeartbeatDetails = function () {};\n');
write(join(root, 'libraries/nestjs-libraries/src/dtos/webhooks/ssrf.safe.dispatcher.js'), `
exports.getSsrfSafeDispatcher = function () { return undefined; };
exports.getSsrfSafeAxios = function () { return function () { throw new Error('axios unused'); }; };
`);
write(join(root, 'libraries/helpers/src/utils/timer.js'), 'exports.timer = async function () {};\n');
write(join(root, 'libraries/helpers/src/utils/has.extension.js'), `
exports.hasExtension = (path, ext) => String(path).toLowerCase().endsWith('.' + ext);
`);
write(join(root, 'libraries/helpers/src/utils/valid.url.path.js'), 'exports.isAllowedUploadPath = () => true;\n');
write(join(root, 'libraries/helpers/src/utils/strip.html.validation.js'), 'exports.stripHtmlValidation = (_a, message) => message;\n');
write(join(root, 'libraries/helpers/src/utils/strip.links.js'), 'exports.stripLinks = (message) => message;\n');
write(join(root, 'libraries/helpers/src/decorators/plug.decorator.js'), 'exports.Plug = () => (target, key, descriptor) => descriptor;\n');
write(join(root, 'libraries/helpers/src/decorators/post.plug.js'), 'exports.PostPlug = () => (target, key, descriptor) => descriptor;\n');
write(join(root, 'libraries/nestjs-libraries/src/chat/rules.description.decorator.js'), 'exports.Rules = () => (target) => target;\n');
write(join(root, 'libraries/nestjs-libraries/src/dtos/posts/providers-settings/x.dto.js'), 'class XDto {}\nexports.XDto = XDto;\n');
write(join(root, 'node_modules/parse5.js'), 'exports.parseFragment = () => ({ childNodes: [] });\n');
write(join(root, 'node_modules/dayjs.js'), 'module.exports = function dayjs() { return { toDate() { return new Date(0); } }; };\n');
write(join(root, 'node_modules/lodash.js'), 'exports.uniqBy = (items) => items;\n');

for (const name of ['twitter-api-v2', 'tslib']) {
  const target = join(sdkRoot, 'node_modules', name);
  symlinkSync(target, join(root, 'node_modules', name));
}

const TOKEN = 'ACCESSTOKENSENTINEL';
const SECRET = 'ACCESSSECRETSENTINEL';
const APP = 'APPKEYSENTINEL';
const APP_SECRET = 'APPSECRETSENTINEL';
const PROCESSING_SUFFIX = 'dimensions rejected PROCESSINGDETAILSENTINEL';

let mode = 'http-400';
const seen = [];
const originalRequest = https.request;
https.request = function (options) {
  const path = (options && options.path) || '';
  const req = new EventEmitter();
  req._chunks = [];
  req.write = (chunk) => {
    req._chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return req;
  };
  req.setTimeout = () => req;
  req.destroy = () => req;
  req.end = () => {
    const body = Buffer.concat(req._chunks);
    seen.push({ path, body });
    const socket = new EventEmitter();
    socket.off = socket.removeListener.bind(socket);
    req.emit('socket', socket);
    const spec = respond(path);
    if (spec.requestError) {
      process.nextTick(() => req.emit('error', spec.requestError));
      return;
    }
    const res = new EventEmitter();
    res.statusCode = spec.status;
    res.headers = { 'content-type': 'application/json' };
    res.aborted = false;
    res.complete = true;
    process.nextTick(() => {
      req.emit('response', res);
      if (spec.body != null) res.emit('data', Buffer.from(spec.body));
      res.emit('end');
    });
  };
  return req;
};

function respond(path) {
  if (mode === 'request-error') {
    return { requestError: Object.assign(new Error('socket-down'), { code: 'ECONNRESET' }) };
  }
  if (mode === 'partial-response') {
    return { status: 200, body: '{not-json' };
  }
  if (mode === 'http-400') {
    return {
      status: 400,
      body: JSON.stringify({
        title: 'Invalid Request',
        detail: 'Animated GIF is not allowed',
        type: 'https://api.x.com/2/problems/invalid-request',
        status: 400,
      }),
    };
  }
  if (mode === 'processing-failed' || mode === 'success') {
    if (path.includes('initialize')) {
      return { status: 200, body: JSON.stringify({ data: { id: 'media1' } }) };
    }
    if (path.includes('/append')) {
      return { status: 200, body: JSON.stringify({ data: {} }) };
    }
    if (path.includes('/finalize')) {
      if (mode === 'success') return { status: 200, body: JSON.stringify({ data: { id: 'media1' } }) };
      return { status: 200, body: JSON.stringify({ data: { processing_info: { state: 'pending' } } }) };
    }
    return {
      status: 200,
      body: JSON.stringify({
        data: { processing_info: { state: 'failed', error: { message: PROCESSING_SUFFIX } } },
      }),
    };
  }
  return { status: 500, body: '{}' };
}

const requireFromTree = createRequire(join(integrations, 'social/x.provider.js'));
const { XProvider } = requireFromTree('./x.provider.js');
const { TwitterApi } = requireFromTree('twitter-api-v2');
const { SocialAbstract } = requireFromTree('../social.abstract.js');

function curatedError(error) {
  const parsed = JSON.parse(error);
  const [type, message] = parsed?.failure?.cause?.applicationFailureInfo?.type
    ? [parsed.failure.cause.applicationFailureInfo.type, parsed.failure.cause.message]
    : [undefined, undefined];
  return type === 'bad_body' && message && message !== 'Unknown Error' ? message : null;
}

function postsList(err) {
  return curatedError(JSON.stringify({
    failure: {
      message: 'Activity task failed',
      cause: {
        message: err.message,
        applicationFailureInfo: { type: err.type, nonRetryable: err.nonRetryable },
      },
    },
  }));
}

function assertSafe(text, label) {
  for (const forbidden of [TOKEN, SECRET, APP, APP_SECRET, PROCESSING_SUFFIX, 'SECRET_ONLY', 'authorization', 'cdn.example']) {
    if (String(text).includes(forbidden)) {
      console.error('LEAK', label, forbidden);
      process.exit(4);
    }
  }
}

const sharp = requireFromTree('sharp');
const samples = {
  'photo.jpg': await sharp({ create: { width: 12, height: 8, channels: 3, background: { r: 20, g: 40, b: 60 } } }).jpeg().toBuffer(),
  'photo.png': await sharp({ create: { width: 12, height: 8, channels: 4, background: { r: 20, g: 40, b: 60, alpha: 1 } } }).png().toBuffer(),
  'anim.gif': await sharp({ create: { width: 12, height: 8, channels: 3, background: { r: 200, g: 10, b: 10 } } }).gif().toBuffer(),
};
const provider = new XProvider();
provider.readOrFetch = async (path) => samples[path] || samples['photo.jpg'];
if (provider.identifier !== 'x') {
  console.error('identifier', provider.identifier);
  process.exit(5);
}

const client = new TwitterApi({
  appKey: APP,
  appSecret: APP_SECRET,
  accessToken: TOKEN,
  accessSecret: SECRET,
});

const evidence = [];
let sdkShape = null;
mode = 'http-400';
try {
  await client.v2.uploadMedia(samples['photo.jpg'], { media_type: 'image/jpeg', media_category: 'tweet_image' });
} catch (err) {
  sdkShape = {
    instanceName: err.name,
    constructorName: err.constructor && err.constructor.name,
    type: err.type,
    code: typeof err.code === 'number' ? err.code : null,
    errorFlag: err.error === true,
    dataKeys: err.data && typeof err.data === 'object' ? Object.keys(err.data) : [],
  };
}
if (!sdkShape || sdkShape.instanceName !== 'Error' || sdkShape.constructorName !== 'ApiResponseError' || sdkShape.type !== 'response' || sdkShape.code !== 400) {
  console.error('SDK_SHAPE', sdkShape);
  process.exit(15);
}

async function scenario(name) {
  mode = name;
  seen.length = 0;
  const posts = [{ id: 'post1', media: [{ path: 'photo.jpg' }] }];
  try {
    const value = await provider.uploadMediaEntries(client, posts, false);
    evidence.push({ scenario: name, outcome: 'success', mediaId: value?.media?.post1?.[0] || null });
    return;
  } catch (err) {
    const listed = postsList(err);
    const details = JSON.stringify(err.details || []);
    assertSafe(listed, name + ':list');
    assertSafe(details, name + ':details');
    assertSafe(err.message, name + ':message');
    if (err.type !== 'bad_body' || err.nonRetryable !== true) {
      console.error('NOT_BAD_BODY', name, err.type, err.nonRetryable);
      process.exit(6);
    }
    if (!listed || listed === 'Unknown Error') {
      console.error('STILL_UNKNOWN', name, listed);
      process.exit(7);
    }
    evidence.push({
      scenario: name,
      ctor: err.constructor && err.constructor.name,
      failureType: err.type,
      nonRetryable: err.nonRetryable,
      postsListError: listed,
    });
  }
}

await scenario('http-400');
await scenario('request-error');
await scenario('partial-response');
await scenario('processing-failed');
mode = 'success';
await scenario('success');

function bodyKind(buf) {
  if (buf.includes(Buffer.from('GIF89a')) || buf.includes(Buffer.from('GIF87a'))) return 'gif';
  if (buf.includes(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return 'png';
  if (buf.includes(Buffer.from([0xff, 0xd8, 0xff]))) return 'jpeg';
  return 'none';
}

async function checkStill(file, article, expectType, expectMagic) {
  mode = 'success';
  seen.length = 0;
  await provider.uploadMediaEntries(client, [{ id: 'p', media: [{ path: file }] }], article);
  const init = seen.find((row) => row.path.includes('initialize'));
  const append = seen.find((row) => row.path.includes('/append'));
  if (!init || !append) {
    console.error('MISSING_REQUEST', file, seen.map((row) => row.path));
    process.exit(12);
  }
  let declared = '';
  try {
    declared = JSON.parse(init.body.toString()).media_type;
  } catch (err) {
    console.error('INIT_NOT_JSON', file, init.body.toString('utf8').slice(0, 180));
    process.exit(12);
  }
  const magic = bodyKind(append.body);
  if (declared !== expectType || magic !== expectMagic) {
    console.error('MIME_MISMATCH', { file, article, declared, magic, expectType, expectMagic });
    process.exit(13);
  }
  evidence.push({ scenario: 'mime', file, article, declared, magic });
}

await checkStill('photo.jpg', false, 'image/jpeg', 'jpeg');
await checkStill('photo.png', false, 'image/png', 'png');
await checkStill('anim.gif', false, 'image/gif', 'gif');
await checkStill('photo.png', true, 'image/jpeg', 'jpeg');

let videoCalled = false;
provider.uploadVideoInChunks = async () => {
  videoCalled = true;
  return { mediaId: 'vid1', processing: true };
};
seen.length = 0;
const video = await provider.uploadMediaEntries(client, [{ id: 'p', media: [{ path: 'clip.mp4' }] }], false);
if (!videoCalled || seen.length !== 0 || video.media.p?.[0] !== 'vid1') {
  console.error('VIDEO_BRANCH', { videoCalled, requests: seen.length, video });
  process.exit(14);
}
evidence.push({ scenario: 'video', calledChunkedUpload: true, httpsRequests: 0 });

class YoutubeProbe extends SocialAbstract {
  constructor() {
    super();
    this.identifier = 'youtube';
  }
}
const youtube = new YoutubeProbe();
let youtubeMessage = '';
try {
  await youtube.runInConcurrent(async () => {
    throw new Error('youtube plain failure');
  });
} catch (err) {
  youtubeMessage = err.message;
}
if (youtubeMessage !== 'Unknown Error') {
  console.error('YOUTUBE_CHANGED', youtubeMessage);
  process.exit(8);
}

const httpCase = evidence.find((item) => item.scenario === 'http-400');
const processingCase = evidence.find((item) => item.scenario === 'processing-failed');
const successCase = evidence.find((item) => item.scenario === 'success');
if (!httpCase || !httpCase.postsListError.includes('HTTP 400') || !httpCase.postsListError.includes('invalid-request')) {
  console.error('HTTP_CASE', httpCase);
  process.exit(9);
}
if (!processingCase || processingCase.postsListError !== 'X rejected the media upload (media-processing)') {
  console.error('PROCESSING_CASE', processingCase);
  process.exit(10);
}
if (!successCase || successCase.mediaId !== 'media1') {
  console.error('SUCCESS_CASE', successCase);
  process.exit(11);
}

https.request = originalRequest;
console.log(JSON.stringify({
  sdk: 'twitter-api-v2@1.29.0',
  sdkShape,
  note: 'ApiResponseError/ApiRequestError/ApiPartialResponseError keep err.name === Error; constructor.name is the class. uploadMedia processing failure is a plain Error prefixed Media processing failed:.',
  identifier: provider.identifier,
  youtubeLegacyMessage: youtubeMessage,
  evidence,
}, null, 2));
