import { NextRequest, NextResponse } from 'next/server'
import {
  DEFAULT_SIGNATURE_TOLERANCE_SECONDS,
  SIGNATURE_HEADER,
  parseSignatureTimestamp,
} from '@/lib/webhookSignature'
import { TEST_PAYLOAD_MAX_SKEW_MS, parseCanonicalTestPayload } from '@/lib/api'
import { classifyHost, isIpLiteral } from '@/lib/ipRanges'
import type { LookupAddress } from 'node:dns'
import {
  BlockedAddressError,
  createRateLimiter,
  deliverWebhook,
  redirectTarget,
  resolvePublicAddresses,
} from '@/lib/webhookProxy'

/** Request bodies are small ({ url, body, signature }). */
const MAX_BODY_BYTES = 4096
const RATE_LIMIT = 10
const RATE_WINDOW_MS = 60_000
/**
 * Absolute deadline for the whole delivery: DNS pre-check, connect, TLS,
 * response headers and body. Not an idle timeout (#398).
 */
const TIMEOUT_MS = 10000

const rateLimit = createRateLimiter(RATE_LIMIT, RATE_WINDOW_MS)

const STALE_MESSAGE = `Test payload is more than ${
  TEST_PAYLOAD_MAX_SKEW_MS / 60_000
} minutes from server time; check your device clock and retry`

const fail = (status: number, error: string, headers?: HeadersInit) =>
  NextResponse.json({ ok: false, error }, { status, headers })

const timedOut = (durationMs: number) =>
  NextResponse.json(
    { status: 504, ok: false, durationMs, error: 'Webhook request timed out' },
    { status: 504 }
  )

/** Only the dashboard itself may use the proxy (#261). */
function isSameOrigin(req: NextRequest): boolean {
  const site = req.headers.get('sec-fetch-site')
  if (site) return site === 'same-origin'
  const origin = req.headers.get('origin')
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host')
  if (!origin || !host) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

function clientIp(req: NextRequest): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    req.ip ||
    'unknown'
  )
}

export async function POST(req: NextRequest) {
  const startTime = Date.now()
  const now = startTime

  if (!isSameOrigin(req))
    return fail(403, 'Cross-origin requests are not allowed')

  const limit = rateLimit(clientIp(req))
  if (!limit.allowed) {
    return fail(429, 'Too many test webhook requests', {
      'Retry-After': String(Math.ceil(limit.retryAfterMs / 1000)),
    })
  }

  if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) {
    return fail(413, 'Request body too large')
  }
  let data: Record<string, unknown>
  try {
    const text = await req.text()
    if (Buffer.byteLength(text) > MAX_BODY_BYTES)
      return fail(413, 'Request body too large')
    data = JSON.parse(text)
    if (typeof data !== 'object' || data === null)
      throw new Error('not an object')
  } catch {
    return fail(400, 'Malformed request body')
  }

  // NOTE: never log the request body or headers here; the body carries a
  // webhook payload and, from older clients, possibly a signing secret.
  const { url, body, signature } = data
  // The signing secret must stay in the browser; sign there and send only
  // the signature. Reject rather than silently accept a leaked secret.
  if ('secret' in data)
    return fail(400, 'Do not send the signing secret; send a signature')
  if (!url || typeof url !== 'string')
    return fail(400, 'A valid url is required')
  // Signature computed in the browser over `body` (lib/webhookSignature).
  let signedAt: number | null = null
  if (signature !== undefined) {
    if (typeof signature !== 'string') return fail(400, 'Invalid signature')
    signedAt = parseSignatureTimestamp(signature)
    if (signedAt === null) return fail(400, 'Invalid signature')
  }
  if (typeof body !== 'string' || !parseCanonicalTestPayload(body, { now })) {
    // Distinguish a stale/future payload so the user can check their clock.
    const stale =
      typeof body === 'string' &&
      parseCanonicalTestPayload(body, { now, maxSkewMs: Infinity })
    if (stale) return fail(400, STALE_MESSAGE)
    return fail(400, 'body must be a test payload built by the dashboard')
  }
  // Replay protection (#401): the signature's t= must be fresh as well.
  if (
    signedAt !== null &&
    Math.abs(now / 1000 - signedAt) > DEFAULT_SIGNATURE_TOLERANCE_SECONDS
  ) {
    return fail(400, STALE_MESSAGE)
  }

  let parsedUrl: URL
  try {
    parsedUrl = new URL(url)
  } catch {
    return fail(400, 'Invalid URL format')
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    return fail(400, 'Only http and https protocols are supported')
  }

  // SSRF prevention (#259, #260): reject non-public IP literals and names that
  // resolve to any non-public address. The vetted addresses are then pinned
  // for the connection, so the name is resolved once and cannot rebind.
  if (classifyHost(parsedUrl.hostname) !== 'public') {
    return fail(403, 'Private and loopback target URLs are blocked')
  }
  // One deadline covers the lookup and the delivery together (#398).
  const deadline = AbortSignal.timeout(TIMEOUT_MS)
  let addresses: LookupAddress[] | undefined
  if (!isIpLiteral(parsedUrl.hostname)) {
    try {
      addresses = await resolvePublicAddresses(parsedUrl.hostname, deadline)
    } catch (err) {
      if (err instanceof BlockedAddressError) {
        return fail(403, 'Private and loopback target URLs are blocked')
      }
      if ((err as { name?: string })?.name === 'TimeoutError') {
        return timedOut(Date.now() - startTime)
      }
      return fail(400, 'Could not resolve the webhook host')
    }
  }

  // Only dashboard-built test payloads are forwarded (#261), byte for byte,
  // with the browser's signature header passed through unchanged.
  const bodyString = body
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (typeof signature === 'string') headers[SIGNATURE_HEADER] = signature

  try {
    const remainingMs = Math.max(1, TIMEOUT_MS - (Date.now() - startTime))
    const res = await deliverWebhook(
      parsedUrl,
      bodyString,
      headers,
      remainingMs,
      { addresses, signal: deadline }
    )
    const durationMs = Date.now() - startTime
    // Redirects are never followed; report where the receiver points so the
    // user can update the URL (#399). Origin and path only.
    const isRedirect = res.status >= 300 && res.status < 400
    const location = isRedirect ? redirectTarget(res.location, parsedUrl) : null
    return NextResponse.json({
      status: res.status,
      ok: res.status >= 200 && res.status < 300,
      durationMs,
      bodySnippet: res.bodySnippet,
      ...(location ? { location } : {}),
    })
  } catch (error) {
    const durationMs = Date.now() - startTime
    if (error instanceof BlockedAddressError) {
      return fail(403, 'Private and loopback target URLs are blocked')
    }
    const err = error as { name?: string; message?: string } | undefined
    if (err?.name === 'TimeoutError') return timedOut(durationMs)
    return NextResponse.json(
      {
        status: 500,
        ok: false,
        durationMs,
        error: err?.message || 'Failed to deliver webhook',
      },
      { status: 500 }
    )
  }
}
