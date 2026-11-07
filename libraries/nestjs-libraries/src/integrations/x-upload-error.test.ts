import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  resolveConcurrentProviderError,
  sanitizeProviderText,
  type ProviderHandleResult,
} from './x-upload-error.ts';

const SECRET = 'SUPERSECRETTOKENVALUE';
const SIGNED =
  'https://cdn.example/image.jpg?X-Amz-Signature=' + SECRET + '&user=123456789012345678';
const ACCOUNT_ID = '998877665544332211';

function withConstructor(err: Error, ctorName: string) {
  const ctor = function SdkError() {};
  Object.defineProperty(ctor, 'name', { value: ctorName });
  Object.defineProperty(err, 'constructor', { value: ctor });
  return err;
}

function apiError(data: unknown, code = 400, extras: Record<string, unknown> = {}) {
  // twitter-api-v2@1.29.0 leaves the instance name as "Error".
  const err = new Error(
    `Request failed with code ${code} - SECRET_ONLY_IN_MESSAGE ${SIGNED}`
  );
  withConstructor(err, 'ApiResponseError');
  return Object.assign(err, {
    error: true,
    type: 'response',
    code,
    data,
    headers: { authorization: `Bearer ${SECRET}`, cookie: `auth=${SECRET}` },
    request: { url: SIGNED, oauth_token: SECRET },
    rateLimit: { limit: 1 },
    response: { raw: SECRET },
    ...extras,
  });
}

function xHandleErrors(body: string): ProviderHandleResult | undefined {
  if (body.includes('Too Many Requests')) {
    return { type: 'retry', value: 'X rate limit reached, please try again later' };
  }
  if (body.includes('"title":"Unauthorized"')) {
    return {
      type: 'refresh-token',
      value: 'X rejected the connected account, please reconnect your account',
    };
  }
  if (body.includes('usage-capped')) {
    return {
      type: 'bad-body',
      value: 'Posting failed - capped reached. Please try again later',
    };
  }
  if (body.includes('Your media IDs are invalid')) {
    return {
      type: 'bad-body',
      value: 'X rejected the attached media, please re-upload the media and try again',
    };
  }
  return undefined;
}

function assertNoSecrets(value: string) {
  for (const forbidden of [
    SECRET,
    'SECRET_ONLY_IN_MESSAGE',
    'X-Amz-Signature',
    'Bearer',
    'authorization',
    'oauth_token',
    'cookie',
    ACCOUNT_ID,
    '123456789012345678',
    SIGNED,
    'cdn.example',
  ]) {
    assert.equal(value.includes(forbidden), false, `leaked ${forbidden}`);
  }
}

function curatedError(error?: string | null): string | null {
  if (!error) {
    return null;
  }
  try {
    const parsed = JSON.parse(error);
    const [type, message] = parsed?.cause?.failure?.message
      ? [parsed?.cause?.type, parsed?.cause?.failure?.message]
      : [
          parsed?.failure?.cause?.applicationFailureInfo?.type,
          parsed?.failure?.cause?.message,
        ];
    return type === 'bad_body' && message && message !== 'Unknown Error'
      ? message
      : null;
  } catch {
    return null;
  }
}

test('sanitizeProviderText drops urls, secrets, and account ids', () => {
  assert.equal(sanitizeProviderText('Image must be at least 4 pixels'), 'Image must be at least 4 pixels');
  assert.equal(sanitizeProviderText(`see ${SIGNED}`), undefined);
  assert.equal(sanitizeProviderText(`account ${ACCOUNT_ID}`), undefined);
  assert.equal(sanitizeProviderText(`Bearer ${SECRET}`), undefined);
  assert.equal(sanitizeProviderText(''), undefined);
  assert.equal(sanitizeProviderText(400), undefined);
  assert.equal(sanitizeProviderText('ab12cd34ef56'), undefined);
  assert.equal(sanitizeProviderText('prefix ab12cd34ef56 suffix'), undefined);
});

test('sanitizeProviderText scans the whole field before clipping', () => {
  const filler = 'valid ';
  assert.equal(filler.length, 6);
  const nearLimit = filler.repeat(29) + 'ab12cd34ef56';
  assert.ok(filler.repeat(29).length < 180);
  assert.ok(filler.repeat(29).length + 'ab12'.length <= 180);
  assert.equal(sanitizeProviderText(nearLimit), undefined);

  const pastLimit = filler.repeat(32) + 'SYNTHETICCredentialSentinel123456789';
  assert.ok(filler.repeat(32).length > 180);
  assert.equal(sanitizeProviderText(pastLimit), undefined);

  const safe = 'The image dimensions are too small. '.repeat(8).trim();
  assert.ok(safe.length > 180);
  const clipped = sanitizeProviderText(safe);
  assert.equal(clipped, Array.from(safe).slice(0, 180).join(''));
  assert.equal(clipped?.includes('ab12'), false);
});

test('representative ApiResponseError exposes only whitelisted fields', () => {
  const resolution = resolveConcurrentProviderError({
    identifier: 'x',
    alreadyClassified: false,
    handleErrors: xHandleErrors,
    err: apiError({
      title: 'Invalid Request',
      detail: 'The image dimensions are too small',
      type: 'https://api.twitter.com/2/problems/invalid-request',
      status: 400,
      errors: [
        {
          message: 'nested should not win',
          code: 324,
          parameters: { media: SIGNED },
          account_id: ACCOUNT_ID,
        },
      ],
      request: SIGNED,
      headers: { authorization: `Bearer ${SECRET}` },
    }),
  });

  assert.equal(resolution.action, 'throw');
  if (resolution.action !== 'throw') {
    return;
  }
  assert.equal(resolution.failureType, 'bad-body');
  assert.equal(
    resolution.message,
    'X rejected the media upload (response, HTTP 400, code 324, type invalid-request, title: Invalid Request, detail: The image dimensions are too small)'
  );
  assert.equal(resolution.message.includes('SECRET_ONLY_IN_MESSAGE'), false);
  assert.deepEqual(JSON.parse(resolution.safeJson), {
    category: 'response',
    httpStatus: 400,
    code: 324,
    type: 'invalid-request',
    title: 'Invalid Request',
    detail: 'The image dimensions are too small',
  });
  assertNoSecrets(resolution.message);
  assertNoSecrets(resolution.safeJson);
  assert.equal(resolution.message.includes('nested should not win'), false);
});

test('v1 media error uses the safe errors message and numeric code', () => {
  const resolution = resolveConcurrentProviderError({
    identifier: 'x',
    alreadyClassified: false,
    handleErrors: xHandleErrors,
    err: apiError(
      {
        errors: [
          {
            code: 324,
            message: 'Media type is not supported',
            user_id: ACCOUNT_ID,
          },
        ],
      },
      400
    ),
  });

  assert.equal(resolution.action, 'throw');
  if (resolution.action !== 'throw') {
    return;
  }
  assert.match(resolution.message, /HTTP 400, code 324/);
  assert.match(resolution.message, /detail: Media type is not supported/);
  assertNoSecrets(JSON.stringify(resolution));
});

test('secret-bearing detail is omitted while a known phrase still maps statically', () => {
  const resolution = resolveConcurrentProviderError({
    identifier: 'x',
    alreadyClassified: false,
    handleErrors: xHandleErrors,
    err: apiError({
      title: 'Too Many Requests',
      detail: `Too Many Requests for ${ACCOUNT_ID} at ${SIGNED}`,
      type: 'https://api.twitter.com/2/problems/usage-capped?token=' + SECRET,
    }, 429),
  });

  assert.equal(resolution.action, 'throw');
  if (resolution.action !== 'throw') {
    return;
  }
  assert.equal(resolution.failureType, 'bad-body');
  assert.equal(resolution.message, 'X rate limit reached, please try again later');
  assert.equal(JSON.parse(resolution.safeJson).detail, undefined);
  assert.equal(JSON.parse(resolution.safeJson).type, undefined);
  assert.equal(JSON.parse(resolution.safeJson).httpStatus, 429);
  assertNoSecrets(resolution.message + resolution.safeJson);
});

test('unsafe problem url with a query is not turned into a type slug', () => {
  const resolution = resolveConcurrentProviderError({
    identifier: 'x',
    alreadyClassified: false,
    err: apiError({
      type: 'https://evil.example/problems/invalid-media?token=' + SECRET,
      title: 'Invalid media',
    }),
  });

  assert.equal(resolution.action, 'throw');
  if (resolution.action !== 'throw') {
    return;
  }
  assert.equal(JSON.parse(resolution.safeJson).type, undefined);
  assert.equal(JSON.parse(resolution.safeJson).title, 'Invalid media');
  assertNoSecrets(JSON.stringify(resolution));
});

test('Unauthorized title keeps the existing refresh-token mapping', () => {
  const resolution = resolveConcurrentProviderError({
    identifier: 'x',
    alreadyClassified: false,
    handleErrors: xHandleErrors,
    err: apiError({ title: 'Unauthorized', detail: `token ${SECRET}` }, 401),
  });

  assert.equal(resolution.action, 'throw');
  if (resolution.action !== 'throw') {
    return;
  }
  assert.equal(resolution.failureType, 'refresh-token');
  assert.equal(
    resolution.message,
    'X rejected the connected account, please reconnect your account'
  );
  assertNoSecrets(resolution.safeJson);
});

test('HTTP 401 without the Unauthorized title stays a bad body', () => {
  const resolution = resolveConcurrentProviderError({
    identifier: 'x',
    alreadyClassified: false,
    handleErrors: xHandleErrors,
    err: apiError({ title: 'Invalid media', detail: 'Animated GIF is not allowed' }, 401),
  });

  assert.equal(resolution.action, 'throw');
  if (resolution.action !== 'throw') {
    return;
  }
  assert.equal(resolution.failureType, 'bad-body');
  assert.match(resolution.message, /HTTP 401/);
  assert.match(resolution.message, /Animated GIF is not allowed/);
});

test('usage-capped type keeps the existing static bad-body message', () => {
  const resolution = resolveConcurrentProviderError({
    identifier: 'x',
    alreadyClassified: false,
    handleErrors: xHandleErrors,
    err: apiError({
      type: 'https://api.x.com/2/problems/usage-capped',
      title: 'Credits',
      detail: 'usage-capped',
    }, 403),
  });

  assert.equal(resolution.action, 'throw');
  if (resolution.action !== 'throw') {
    return;
  }
  assert.equal(resolution.failureType, 'bad-body');
  assert.equal(resolution.message, 'Posting failed - capped reached. Please try again later');
});

test('already classified failures are rethrown before any rewrite', () => {
  const err = apiError({ title: 'Invalid media' });
  assert.deepEqual(
    resolveConcurrentProviderError({
      identifier: 'x',
      err,
      alreadyClassified: true,
      handleErrors: xHandleErrors,
    }),
    { action: 'rethrow-classified' }
  );
});

test('request, partial, processing, and unknown X errors stay static', () => {
  const request = withConstructor(new Error(`Request failed. ${SECRET}`), 'ApiRequestError');
  Object.assign(request, { error: true, type: 'request', request: { url: SIGNED } });
  const partial = withConstructor(new Error(`partial ${SECRET}`), 'ApiPartialResponseError');
  Object.assign(partial, { error: true, type: 'partial-response', rawContent: SECRET });
  const processing = new Error(`Media processing failed: dimensions ${SECRET}`);
  const plain = new Error(`sharp failed ${SECRET}`);

  for (const [err, category] of [
    [request, 'request'],
    [partial, 'partial-response'],
    [processing, 'media-processing'],
    [plain, 'unclassified'],
  ] as const) {
    const resolution = resolveConcurrentProviderError({
      identifier: 'x',
      alreadyClassified: false,
      err,
    });
    assert.equal(resolution.action, 'throw');
    if (resolution.action !== 'throw') {
      continue;
    }
    assert.equal(resolution.failureType, 'bad-body');
    assert.equal(resolution.message, `X rejected the media upload (${category})`);
    assert.equal(JSON.parse(resolution.safeJson).category, category);
    assertNoSecrets(JSON.stringify(resolution));
    assert.equal(resolution.message.includes(SECRET), false);
  }
});

test('plain errors and other providers stay on the legacy path', () => {
  assert.equal(
    resolveConcurrentProviderError({
      identifier: 'youtube',
      alreadyClassified: false,
      err: apiError({ title: 'Invalid media', detail: 'nope' }),
    }).action,
    'legacy'
  );
});

test('a cause-wrapped ApiResponseError is read once and its wrapper message is ignored', () => {
  const resolution = resolveConcurrentProviderError({
    identifier: 'x',
    alreadyClassified: false,
    err: {
      message: `wrapper ${SECRET} ${SIGNED}`,
      cause: apiError({
        title: 'Invalid media',
        detail: 'Unsupported image format',
        type: 'https://api.twitter.com/2/problems/invalid-request',
      }),
    },
  });

  assert.equal(resolution.action, 'throw');
  if (resolution.action !== 'throw') {
    return;
  }
  assert.match(resolution.message, /type invalid-request/);
  assert.match(resolution.message, /Unsupported image format/);
  assertNoSecrets(JSON.stringify(resolution));
});

test('empty ApiResponseError still replaces Unknown Error with a static sentence', () => {
  const resolution = resolveConcurrentProviderError({
    identifier: 'x',
    alreadyClassified: false,
    err: apiError(undefined, 400),
  });

  assert.equal(resolution.action, 'throw');
  if (resolution.action !== 'throw') {
    return;
  }
  assert.equal(resolution.message, 'X rejected the media upload (response, HTTP 400)');
  assert.notEqual(resolution.message, 'Unknown Error');
});

test('posts list curated error shows the bad_body summary and hides Unknown Error', () => {
  const resolution = resolveConcurrentProviderError({
    identifier: 'x',
    alreadyClassified: false,
    err: apiError({
      title: 'Invalid media',
      detail: 'Animated GIF is not allowed',
      type: 'https://api.twitter.com/2/problems/invalid-media',
    }),
  });
  assert.equal(resolution.action, 'throw');
  if (resolution.action !== 'throw') {
    return;
  }

  const stored = JSON.stringify({
    failure: {
      message: 'Activity task failed',
      cause: {
        message: resolution.message,
        applicationFailureInfo: { type: 'bad_body', nonRetryable: true },
      },
    },
  });
  assert.equal(curatedError(stored), resolution.message);

  const hidden = JSON.stringify({
    failure: {
      cause: {
        message: 'Unknown Error',
        applicationFailureInfo: { type: 'bad_body', nonRetryable: true },
      },
    },
  });
  assert.equal(curatedError(hidden), null);
  assert.equal(
    curatedError(
      JSON.stringify({
        cause: { type: 'refresh_token', failure: { message: resolution.message } },
      })
    ),
    null
  );
});

test('string codes and unknown problem slugs are dropped, official slugs stay', () => {
  const sentinel = 'SYNTHETICCredentialSentinel123456789';
  const cases: Array<{ code?: unknown; type?: unknown; expectType?: string; expectCode?: number }> = [
    { code: sentinel, type: sentinel },
    { code: 'ab', type: 'zz' },
    { code: 'ab12cd34ef56', type: 'not-a-real-problem' },
    { code: '324abc', type: `https://api.twitter.com/2/problems/${sentinel}` },
    { code: sentinel, type: 'https://api.x.com/2/problems/ab12cd34ef56' },
    { code: 324, type: 'https://api.twitter.com/2/problems/invalid-request', expectType: 'invalid-request', expectCode: 324 },
    { code: 88, type: 'usage-capped', expectType: 'usage-capped', expectCode: 88 },
    { code: 403, type: 'https://api.x.com/2/problems/duplicate-rules', expectType: 'duplicate-rules', expectCode: 403 },
    { type: 'https://api.twitter.com/2/problems/invalid-media' },
  ];

  for (const item of cases) {
    const resolution = resolveConcurrentProviderError({
      identifier: 'x',
      alreadyClassified: false,
      err: apiError({
        title: 'Invalid media',
        detail: 'Animated GIF is not allowed',
        ...(item.type !== undefined ? { type: item.type } : {}),
        errors: item.code !== undefined ? [{ code: item.code, message: 'kept out' }] : [],
      }),
    });
    assert.equal(resolution.action, 'throw');
    if (resolution.action !== 'throw') {
      continue;
    }
    const stored = resolution.message + resolution.safeJson;
    assert.equal(stored.includes(sentinel), false);
    assert.equal(stored.includes('ab12cd34ef56'), false);
    assert.equal(stored.includes('not-a-real-problem'), false);
    assert.equal(stored.includes('invalid-media'), false);
    assert.equal(stored.includes('324abc'), false);
    const body = JSON.parse(resolution.safeJson);
    assert.equal(body.httpStatus, 400);
    assert.equal(body.code, item.expectCode);
    assert.equal(body.type, item.expectType);
    assert.equal(typeof body.code === 'string', false);
  }
});

test('provider source still owns the static mappings and the upload catch uses them', () => {
  const root = dirname(fileURLToPath(import.meta.url));
  const provider = readFileSync(join(root, 'social/x.provider.ts'), 'utf8');
  const abstract = readFileSync(join(root, 'social.abstract.ts'), 'utf8');
  assert.match(provider, /X rate limit reached, please try again later/);
  assert.match(provider, /'"title":"Unauthorized"'/);
  assert.match(provider, /Posting failed - capped reached\. Please try again later/);
  assert.match(abstract, /resolveConcurrentProviderError/);
  assert.match(abstract, /err instanceof BadBody/);
  assert.match(abstract, /err instanceof RefreshToken/);
  assert.match(abstract, /err instanceof Disconnect/);
  assert.match(abstract, /value = await func\(\)/);
  assert.match(abstract, /value: 'Unknown Error'/);
  assert.match(abstract, /this\.identifier === 'x'/);
  assert.match(abstract, /globalErr = \{\}/);
});
