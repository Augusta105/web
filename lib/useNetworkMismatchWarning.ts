import { useCallback, useEffect, useState } from 'react'
import type { Network } from '@/types'
import { getWalletNetwork, networkMismatchWarning, readFreighterConnection } from '@/lib/freighter'

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
  const [walletUnavailable, setWalletUnavailable] = useState(false)

  const checkNetworkMismatch = useCallback(async () => {
    const connection = await readFreighterConnection()
    if (!connection.available || !connection.connected) {
      // No extension or no connected wallet: nothing to compare against.
      setNetworkWarning(null)
      setWalletUnavailable(false)
      return
    }
    try {
      const walletNetwork = await getWalletNetwork()
      setNetworkWarning(networkMismatchWarning(walletNetwork, network))
      setWalletUnavailable(false)
    } catch {
      // Locked wallet, revoked permission, or other Freighter error: the
      // network could not be determined, so surface it instead of staying silent.
      setNetworkWarning(null)
      setWalletUnavailable(true)
    }
  }, [network])

  useEffect(() => {
    let active = true

    async function run() {
      const connection = await readFreighterConnection()
      if (!connection.available || !connection.connected) {
        if (active) {
          setNetworkWarning(null)
          setWalletUnavailable(false)
        }
        return
      }
      try {
        const walletNetwork = await getWalletNetwork()
        if (active) {
          setNetworkWarning(networkMismatchWarning(walletNetwork, network))
          setWalletUnavailable(false)
        }
      } catch {
        if (active) {
          setNetworkWarning(null)
          setWalletUnavailable(true)
        }
      }
    }

    void run()

    return () => {
      active = false
    }
  }, [network, isConnected])

  const clearNetworkWarning = useCallback(() => {
    setNetworkWarning(null)
    setWalletUnavailable(false)
  }, [])

  return { networkWarning, walletUnavailable, checkNetworkMismatch, clearNetworkWarning }
}
