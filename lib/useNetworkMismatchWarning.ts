import { useCallback, useEffect, useState } from 'react'
import type { Network } from '@/types'
import { getWalletNetwork, networkMismatchWarning, readFreighterConnection } from '@/lib/freighter'
import { subscribeWallet } from '@/lib/walletEvents'
import {
  networkMismatchWarning,
  readFreighterConnection,
} from '@/lib/freighter'

/**
 * Warns when the connected wallet's network does not match the selected
 * contract network.
 *
 * The check runs on mount, whenever the selected network changes, and whenever
 * the connection state changes (e.g. after connecting from this page), and the
 * warning is cleared when the wallet is no longer reachable.
 */
export function useNetworkMismatchWarning(
  network: Network,
  isConnected: boolean
) {
  const [networkWarning, setNetworkWarning] = useState<string | null>(null)

  const readWarning = useCallback(async (): Promise<string | null> => {
    // null: extension not reachable. publicKey/network null: locked, not
    // approved, or network unreadable. Nothing to compare against in any case.
    const connection = await readFreighterConnection()
    if (!connection?.publicKey || !connection.network) return null
    return networkMismatchWarning(connection.network, network)
  }, [network])

  const checkNetworkMismatch = useCallback(async () => {
    try {
      setNetworkWarning(await readWarning())
    } catch {
      setNetworkWarning(null)
    }
  }, [readWarning])

  useEffect(() => {
    let active = true

    async function run() {
      try {
        const warning = await readWarning()
        if (active) setNetworkWarning(warning)
      } catch {
        if (active) setNetworkWarning(null)
      }
    }

    void run()

    return () => {
      active = false
    }
  }, [readWarning, isConnected])

  // Re-check whenever the wallet broadcasts a change (e.g. a network switch in
  // the extension) so the warning appears or clears without a reload.
  useEffect(() => {
    let active = true

    const unsubscribe = subscribeWallet((event) => {
      if (!active) return
      if (event.network !== undefined) {
        setNetworkWarning(networkMismatchWarning(event.network, network))
        return
      }
      void checkNetworkMismatch()
    })

    return () => {
      active = false
      unsubscribe()
    }
  }, [network, checkNetworkMismatch])

  const clearNetworkWarning = useCallback(() => setNetworkWarning(null), [])

  return { networkWarning, checkNetworkMismatch, clearNetworkWarning }
}
