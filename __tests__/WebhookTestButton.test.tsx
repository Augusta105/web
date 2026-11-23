import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  sendTestWebhook: vi.fn(),
}))

import WebhookTestButton from '@/components/WebhookTestButton'
import { sendTestWebhook } from '@/lib/api'

const CID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4'
const send = vi.mocked(sendTestWebhook)

beforeEach(() => send.mockReset())

describe('WebhookTestButton', () => {
  it('sends a rule-aware, signed test through sendTestWebhook', async () => {
    send.mockResolvedValue({ status: 200, ok: true })
    const rule = { type: 'FunctionCalled', function_name: 'swap' } as const
    render(
      <WebhookTestButton
        url=" https://hooks.example.com/x "
        contractId={CID}
        network="mainnet"
        rule={rule}
        secret="whsec_abc"
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /test webhook/i }))

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(/delivered \(HTTP 200\)/i)
    )
    expect(send).toHaveBeenCalledWith(
      'https://hooks.example.com/x',
      expect.objectContaining({
        contractId: CID,
        network: 'mainnet',
        rule,
        secret: 'whsec_abc',
      })
    )
  })

  it('omits a blank secret', async () => {
    send.mockResolvedValue({ status: 200, ok: true })
    render(
      <WebhookTestButton url="https://hooks.example.com/x" contractId={CID} network="testnet" secret="  " />
    )
    fireEvent.click(screen.getByRole('button', { name: /test webhook/i }))
    await waitFor(() => expect(send).toHaveBeenCalled())
    expect(send.mock.calls[0][1]).toMatchObject({ secret: undefined })
  })

  it('reports a failed delivery with the receiver status', async () => {
    send.mockResolvedValue({ status: 404, ok: false })
    render(<WebhookTestButton url="https://hooks.example.com/x" contractId={CID} network="testnet" />)
    fireEvent.click(screen.getByRole('button', { name: /test webhook/i }))
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(/HTTP status 404/)
    )
    expect(screen.getByRole('status')).not.toHaveTextContent(/blocked by txwatch/i)
  })

  it.each([
    ['private IP', 403, 'Destination resolves to a private IP address'],
    ['unresolvable host', 422, 'Host could not be resolved'],
    ['invalid signature', 401, 'Invalid webhook signature'],
    ['rate limit', 429, 'Rate limit exceeded, try again later'],
  ])('surfaces the proxy reason for %s', async (_label, status, error) => {
    send.mockResolvedValue({ status, ok: false, error })
    render(<WebhookTestButton url="https://hooks.example.com/x" contractId={CID} network="testnet" />)
    fireEvent.click(screen.getByRole('button', { name: /test webhook/i }))
    const statusEl = await screen.findByRole('status')
    await waitFor(() => expect(statusEl).toHaveTextContent(error))
    expect(statusEl).toHaveTextContent(/blocked by txwatch/i)
    expect(statusEl).toHaveTextContent(new RegExp(`HTTP ${status}`))
  })

  it.each([
    ['', /enter a webhook url/i],
    ['http://localhost/hook', /loopback/i],
    ['not a url', /valid url/i],
  ])('does not send for %j', async (url, message) => {
    render(<WebhookTestButton url={url} contractId={CID} network="testnet" />)
    fireEvent.click(screen.getByRole('button', { name: /test webhook/i }))
    expect(await screen.findByRole('status')).toHaveTextContent(message)
    expect(send).not.toHaveBeenCalled()
  })
})
