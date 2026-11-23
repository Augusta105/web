// @vitest-environment node
import { vi } from 'vitest'

vi.mock('node:dns', () => ({
  default: {
    lookup: (
      _host: string,
      _opts: unknown,
      cb: (
        err: Error | null,
        addresses: { address: string; family: number }[]
      ) => void
    ) => cb(null, [{ address: '93.184.216.34', family: 4 }]),
  },
}))

vi.mock('@/lib/webhookProxy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/webhookProxy')>()),
  deliverWebhook: vi.fn(),
}))

import type { NextRequest } from 'next/server'
import { POST } from '@/app/api/test-webhook/route'
import { deliverWebhook } from '@/lib/webhookProxy'
import { buildTestWebhookPayload } from '@/lib/api'

const CID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4'
let ip = 0

const request = (url: string) => {
  const text = JSON.stringify({
    url,
    body: JSON.stringify(
      buildTestWebhookPayload({ contractId: CID, network: 'testnet' })
    ),
  })
  return {
    headers: new Headers({
      'sec-fetch-site': 'same-origin',
      'x-forwarded-for': `192.0.2.${++ip}`,
    }),
    text: async () => text,
  } as unknown as NextRequest
}

const deliver = vi.mocked(deliverWebhook)
const redirect = (status: number, location: string | null) =>
  deliver.mockResolvedValueOnce({ status, location, bodySnippet: null })

beforeEach(() => deliver.mockReset())

describe('POST /api/test-webhook redirects (#399)', () => {
  it('reports where an http receiver redirects to', async () => {
    redirect(301, 'https://hooks.example.com/x')
    const body = await (
      await POST(request('http://hooks.example.com/x'))
    ).json()
    expect(body).toMatchObject({
      status: 301,
      ok: false,
      location: 'https://hooks.example.com/x',
    })
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it('resolves a relative Location against the called URL', async () => {
    redirect(308, '/x/')
    const body = await (
      await POST(request('https://hooks.example.com/x'))
    ).json()
    expect(body.location).toBe('https://hooks.example.com/x/')
  })

  it('drops the query, fragment and credentials of the target', async () => {
    redirect(302, 'https://user:pw@moved.example/hook?token=s3cret#frag')
    const body = await (
      await POST(request('https://hooks.example.com/x'))
    ).json()
    expect(body.location).toBe('https://moved.example/hook')
    expect(JSON.stringify(body)).not.toMatch(/s3cret|pw@|frag/)
  })

  it('only reports the target, never follows it, for internal hosts', async () => {
    redirect(302, 'http://169.254.169.254/latest/meta-data/')
    const body = await (
      await POST(request('https://hooks.example.com/x'))
    ).json()
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(String(deliver.mock.calls[0][0])).toBe('https://hooks.example.com/x')
    expect(body.ok).toBe(false)
  })

  it.each([
    ['a non-http scheme', 'javascript:alert(1)'],
    ['an empty header', '   '],
    ['no header', null],
  ])('omits the location for %s', async (_label, location) => {
    redirect(302, location)
    const body = await (
      await POST(request('https://hooks.example.com/x'))
    ).json()
    expect(body).not.toHaveProperty('location')
  })

  it('ignores a Location sent with a non-redirect status', async () => {
    redirect(201, 'https://hooks.example.com/created/1')
    const body = await (
      await POST(request('https://hooks.example.com/x'))
    ).json()
    expect(body).toMatchObject({ status: 201, ok: true })
    expect(body).not.toHaveProperty('location')
  })
})
