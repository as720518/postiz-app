// AGPL-3.0-or-later. Part of Postiz. See the repository LICENSE.
//
// Turns a twitter-api-v2 ApiResponseError into the few provider fields that are
// safe to show in the existing posts list. The SDK error also carries the
// request, response headers, and the raw body; none of those are copied.

export interface ProviderHandleResult {
  type: 'refresh-token' | 'bad-body' | 'retry' | 'disconnect';
  value: string;
}

export type ConcurrentProviderResolution =
  | { action: 'rethrow-classified' }
  | {
      action: 'throw';
      failureType: 'refresh-token' | 'disconnect' | 'bad-body';
      message: string;
      safeJson: string;
    }
  | { action: 'legacy' };

const STATIC_REJECTION = 'X rejected the media upload';
// twitter-api-v2@1.29.0 client.v2.uploadMedia throws this exact prefix from
// `new Error(...)` when processing_info.state is failed. The suffix is the
// provider text and is not stored.
const MEDIA_PROCESSING_PREFIX = 'Media processing failed:';

type FailureCategory =
  | 'response'
  | 'request'
  | 'partial-response'
  | 'media-processing'
  | 'unclassified';
const MAX_TEXT = 180;
const MAX_SCAN_FIELD = 500;
const MAX_SCAN = 2_000;

// Documented X API problem slugs. Anything else, including a credential placed
// in data.type or in the /2/problems/ path, is omitted.
// https://docs.x.com/x-api/fundamentals/response-codes-and-errors
// plus the anchors named by twitter-api-v2@1.29.0 EApiV2ErrorCode.
const OFFICIAL_PROBLEM_SLUGS = new Set([
  'invalid-request',
  'resource-not-found',
  'not-authorized-for-resource',
  'client-forbidden',
  'usage-capped',
  'rate-limit-exceeded',
  'streaming-connection',
  'rule-cap',
  'invalid-rules',
  'duplicate-rules',
  'unsupported-authentication',
  'client-disconnected',
  'operational-disconnect',
  'disallowed-resource',
]);

const SECRET_TEXT =
  /[\u0000-\u001f\u007f]|:\/\/|www\.|bearer\s+|eyJ[a-z0-9_-]{8,}|%[0-9a-f]{2}|\?[^\s]*?=|[?&][a-z0-9_]+=|\b\d{7,}\b|\b(?:access_token|refresh_token|id_token|api_key|apikey|api_secret|client_secret|oauth_token|oauth_token_secret|authorization|cookie|set-cookie|password|secret)\b|[A-Za-z0-9+/]{32,}={0,2}|[A-Fa-f0-9]{32,}|@[a-z0-9.-]+\.[a-z]{2,}/i;

// Reject the whole field when any token is long or mixes letters with digits
// for 12 or more characters. Lowercase does not exempt a token.
function hasOpaqueToken(text: string): boolean {
  for (const piece of text.split(/[^A-Za-z0-9]+/)) {
    if (!piece) {
      continue;
    }
    if (piece.length >= 16) {
      return true;
    }
    if (piece.length >= 12 && /[A-Za-z]/.test(piece) && /\d/.test(piece)) {
      return true;
    }
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function own(record: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function clip(value: string, max: number): string {
  const chars = Array.from(value);
  return chars.length <= max ? value : chars.slice(0, max).join('');
}

/** Returns the text only when the whole string is safe to display. */
export function sanitizeProviderText(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const text = value.replace(/\s+/g, ' ').trim();
  if (!text || text.length > 2_000) {
    return undefined;
  }

  // Scan the entire field first. Clipping before the check can keep the start
  // of a token that begins near the 180-character limit.
  if (SECRET_TEXT.test(text) || hasOpaqueToken(text) || /[<>]/.test(text)) {
    return undefined;
  }

  return clip(text, MAX_TEXT);
}

function readHttpStatus(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 100 &&
    value <= 599
    ? value
    : undefined;
}

function errorCode(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 9999) {
    return value;
  }

  return undefined;
}

function problemSlug(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  const fromUrl = trimmed.match(
    /^https:\/\/api\.(?:twitter|x)\.com\/2\/problems\/([A-Za-z0-9_-]{1,64})\/?$/
  );
  const slug = (fromUrl ? fromUrl[1] : trimmed).toLowerCase();
  return OFFICIAL_PROBLEM_SLUGS.has(slug) ? slug : undefined;
}

function scanPiece(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) {
    return undefined;
  }

  return clip(text, MAX_SCAN_FIELD);
}

// twitter-api-v2@1.29.0 leaves the instance name as "Error". The class is on
// constructor.name. Only these three names are recognized; anything else is
// not copied into the stored error.
function sdkConstructorName(err: object): string | undefined {
  const ctor = (err as { constructor?: { name?: unknown } }).constructor;
  const name = ctor && typeof ctor.name === 'string' ? ctor.name : undefined;
  if (
    name === 'ApiResponseError' ||
    name === 'ApiRequestError' ||
    name === 'ApiPartialResponseError'
  ) {
    return name;
  }
  return undefined;
}

function isSdkResponse(err: Record<string, unknown>): boolean {
  return sdkConstructorName(err) === 'ApiResponseError' && err.error === true && err.type === 'response';
}

function categoryOf(err: unknown): FailureCategory | undefined {
  if (!isRecord(err)) {
    return undefined;
  }
  if (isSdkResponse(err)) {
    return 'response';
  }
  if (sdkConstructorName(err) === 'ApiRequestError' && err.error === true && err.type === 'request') {
    return 'request';
  }
  if (
    sdkConstructorName(err) === 'ApiPartialResponseError' &&
    err.error === true &&
    err.type === 'partial-response'
  ) {
    return 'partial-response';
  }
  const ctor = (err as { constructor?: { name?: unknown } }).constructor;
  if (
    ctor &&
    ctor.name === 'Error' &&
    typeof err.message === 'string' &&
    err.message.startsWith(MEDIA_PROCESSING_PREFIX)
  ) {
    return 'media-processing';
  }
  return undefined;
}

function failureCategory(err: unknown): FailureCategory {
  return categoryOf(err) ?? (isRecord(err) ? categoryOf(err.cause) : undefined) ?? 'unclassified';
}

function unwrapApiResponseError(err: unknown): Record<string, unknown> | undefined {
  if (isRecord(err) && isSdkResponse(err)) {
    return err;
  }
  if (isRecord(err) && isRecord(err.cause) && isSdkResponse(err.cause)) {
    return err.cause;
  }
  return undefined;
}

interface ExtractedApiError {
  category: FailureCategory;
  httpStatus?: number;
  code?: number;
  type?: string;
  title?: string;
  detail?: string;
  scanText: string;
}

function extractApiResponseError(err: unknown): ExtractedApiError | undefined {
  const api = unwrapApiResponseError(err);
  if (!api) {
    return undefined;
  }

  const data = isRecord(api.data) ? api.data : undefined;
  const firstError =
    data && Array.isArray(data.errors) && isRecord(data.errors[0])
      ? data.errors[0]
      : undefined;
  const status = readHttpStatus(api.code) ?? (data ? readHttpStatus(own(data, 'status')) : undefined);
  const code = firstError ? errorCode(own(firstError, 'code')) : undefined;
  const type = data ? problemSlug(own(data, 'type')) : undefined;
  const title = data ? sanitizeProviderText(own(data, 'title')) : undefined;
  const detail =
    (data ? sanitizeProviderText(own(data, 'detail')) : undefined) ??
    (firstError ? sanitizeProviderText(own(firstError, 'message')) : undefined);
  // Existing X handleErrors matches JSON fragments such as "title":"Unauthorized".
  // The scan payload is only those raw fields, it is not stored, and it never
  // includes headers, the request, or the rest of the body.
  const scanPayload: Record<string, string> = {};
  const rawTitle = data ? scanPiece(own(data, 'title')) : undefined;
  const rawDetail = data ? scanPiece(own(data, 'detail')) : undefined;
  const rawType = data ? scanPiece(own(data, 'type')) : undefined;
  const rawMessage = firstError ? scanPiece(own(firstError, 'message')) : undefined;
  if (rawTitle) {
    scanPayload.title = rawTitle;
  }
  if (rawDetail) {
    scanPayload.detail = rawDetail;
  }
  if (rawType) {
    scanPayload.type = rawType;
  }
  if (rawMessage) {
    scanPayload.message = rawMessage;
  }
  const scanText = JSON.stringify(scanPayload).slice(0, MAX_SCAN);

  return { category: 'response', httpStatus: status, code, type, title, detail, scanText };
}

function summaryOf(extracted: ExtractedApiError): string {
  const parts: string[] = [extracted.category];
  if (extracted.httpStatus) {
    parts.push(`HTTP ${extracted.httpStatus}`);
  }
  if (extracted.code !== undefined) {
    parts.push(`code ${extracted.code}`);
  }
  if (extracted.type) {
    parts.push(`type ${extracted.type}`);
  }
  if (extracted.title) {
    parts.push(`title: ${extracted.title}`);
  }
  if (extracted.detail) {
    parts.push(`detail: ${extracted.detail}`);
  }

  return parts.length ? `${STATIC_REJECTION} (${parts.join(', ')})` : STATIC_REJECTION;
}

function safeJsonOf(extracted: ExtractedApiError): string {
  const payload: Record<string, string | number> = { category: extracted.category };
  if (extracted.httpStatus) {
    payload.httpStatus = extracted.httpStatus;
  }
  if (extracted.code !== undefined) {
    payload.code = extracted.code;
  }
  if (extracted.type) {
    payload.type = extracted.type;
  }
  if (extracted.title) {
    payload.title = extracted.title;
  }
  if (extracted.detail) {
    payload.detail = extracted.detail;
  }

  return JSON.stringify(payload);
}

/**
 * Decides what runInConcurrent should do with a thrown error.
 * Already-classified provider failures are returned untouched. An X
 * ApiResponseError becomes a curated failure whose message and JSON contain
 * only whitelisted fields. Other X failures get a closed static category.
 * Non-X providers keep the historical path.
 */
export function resolveConcurrentProviderError(input: {
  identifier: string;
  err: unknown;
  alreadyClassified: boolean;
  handleErrors?: (body: string, status: number) => ProviderHandleResult | undefined;
}): ConcurrentProviderResolution {
  if (input.alreadyClassified) {
    return { action: 'rethrow-classified' };
  }

  if (input.identifier !== 'x') {
    return { action: 'legacy' };
  }

  const category = failureCategory(input.err);
  if (category !== 'response') {
    const status = isRecord(input.err) ? readHttpStatus(input.err.code) : undefined;
    const extracted: ExtractedApiError = {
      category,
      httpStatus: status,
      scanText: '',
    };
    return {
      action: 'throw',
      failureType: 'bad-body',
      message: summaryOf(extracted),
      safeJson: safeJsonOf(extracted),
    };
  }

  const extracted = extractApiResponseError(input.err);
  if (!extracted) {
    return {
      action: 'throw',
      failureType: 'bad-body',
      message: `${STATIC_REJECTION} (unclassified)`,
      safeJson: JSON.stringify({ category: 'unclassified' }),
    };
  }

  const safeJson = safeJsonOf(extracted);
  const handle = input.handleErrors?.(extracted.scanText || safeJson, extracted.httpStatus ?? 0);
  const mapped =
    handle?.value && handle.value !== 'Unknown Error' ? handle.value : undefined;
  const failureType =
    handle?.type === 'refresh-token'
      ? 'refresh-token'
      : handle?.type === 'disconnect'
      ? 'disconnect'
      : 'bad-body';

  return {
    action: 'throw',
    failureType,
    message: mapped || summaryOf(extracted),
    safeJson,
  };
}
