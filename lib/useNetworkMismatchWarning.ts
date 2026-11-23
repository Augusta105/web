import { useCallback, useEffect, useState } from 'react'
import type { Network } from '@/types'
import { getWalletNetwork, networkMismatchWarning, readFreighterConnection } from '@/lib/freighter'
import { subscribeWallet } from '@/lib/walletEvents'

/**
 * Warns when the connected wallet's network does not match the selected
 * contract network.
 *
 * The check runs on mount, whenever the selected network changes, and whenever
 * the connection state changes (e.g. after connecting from this page), and the
 * warning is cleared when the wallet is no longer reachable.
 */
export function useNetworkMismatchWarning(network: Network, isConnected: boolean) {
  const [networkWarning, setNetworkWarning] = useState<string | null>(null)

  const checkNetworkMismatch = useCallback(async () => {
    const connection = await readFreighterConnection()
    if (!connection.available || !connection.connected) {
      // No extension or no connected wallet: nothing to compare against.
      setNetworkWarning(null)
      return
    }
    try {
      const walletNetwork = await getWalletNetwork()
      setNetworkWarning(networkMismatchWarning(walletNetwork, network))
    } catch {
      // Locked or disconnected wallet: nothing to warn about.
      setNetworkWarning(null)
    }
  }, [network])

  useEffect(() => {
    let active = true

    async function run() {
      const connection = await readFreighterConnection()
      if (!connection.available || !connection.connected) {
        if (active) setNetworkWarning(null)
        return
      }
      try {
        const walletNetwork = await getWalletNetwork()
        if (active) setNetworkWarning(networkMismatchWarning(walletNetwork, network))
      } catch {
        if (active) setNetworkWarning(null)
      }
    }

    void run()

    return () => {
      active = false
    }
  }, [network, isConnected])

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
