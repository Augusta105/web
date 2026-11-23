import { NextRequest, NextResponse } from 'next/server'
import { parseSignatureHeader, SIGNATURE_HEADER } from '@/lib/webhookSignature'
import { parseCanonicalTestPayload } from '@/lib/api'
import { classifyHost, isIpLiteral } from '@/lib/ipRanges'
import { createRateLimiter } from '@/lib/rateLimit'
import { getClientIp, trustedProxyHops } from '@/lib/clientIp'
import {
  BlockedAddressError,
  deliverWebhook,
  resolvePublicAddresses,
} from '@/lib/webhookProxy'

/** Request bodies are small ({ url, body, signature }). */
const MAX_BODY_BYTES = 4096
const RATE_LIMIT = 10
const RATE_WINDOW_MS = 60_000
const TIMEOUT_MS = 10000

// Per process unless a shared store is passed; see docs/rate-limiting.md.
const rateLimit = createRateLimiter(RATE_LIMIT, RATE_WINDOW_MS)

const fail = (status: number, error: string, headers?: HeadersInit) =>
  NextResponse.json({ ok: false, error }, { status, headers })

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

export async function POST(req: NextRequest) {
  const startTime = Date.now()

  if (!isSameOrigin(req))
    return fail(403, 'Cross-origin requests are not allowed')

  const clientIp = getClientIp(req.headers, req.ip, trustedProxyHops())
  const limit = await rateLimit(clientIp)
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
  if (typeof body !== 'string' || !parseCanonicalTestPayload(body)) {
    return fail(400, 'body must be a test payload built by the dashboard')
  }
  // The browser signs `body` as `t=<unix>,v1=<hex>` (lib/webhookSignature).
  // The proxy cannot verify it (it has no secret), so it only checks the shape.
  if (
    signature !== undefined &&
    (typeof signature !== 'string' || !parseSignatureHeader(signature))
  ) {
    return fail(400, 'Invalid signature')
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
  // resolve to any non-public address. deliverWebhook re-checks at connect time.
  if (classifyHost(parsedUrl.hostname) !== 'public') {
    return fail(403, 'Private and loopback target URLs are blocked')
  }
  if (!isIpLiteral(parsedUrl.hostname)) {
    try {
      await resolvePublicAddresses(parsedUrl.hostname)
    } catch (err) {
      if (err instanceof BlockedAddressError) {
        return fail(403, 'Private and loopback target URLs are blocked')
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
    const res = await deliverWebhook(parsedUrl, bodyString, headers, TIMEOUT_MS)
    const durationMs = Date.now() - startTime
    return NextResponse.json({
      status: res.status,
      ok: res.status >= 200 && res.status < 300,
      durationMs,
      bodySnippet: res.bodySnippet,
    })
  } catch (error) {
    const durationMs = Date.now() - startTime
    if (error instanceof BlockedAddressError) {
      return fail(403, 'Private and loopback target URLs are blocked')
    }
    const err = error as { name?: string; message?: string } | undefined
    if (err?.name === 'TimeoutError') {
      return NextResponse.json(
        {
          status: 504,
          ok: false,
          durationMs,
          error: 'Webhook request timed out',
        },
        { status: 504 }
      )
    }
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
