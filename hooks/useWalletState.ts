'use client'

import { useCallback, useEffect, useState } from 'react'
import { WatchWalletChanges } from '@stellar/freighter-api'
import { readFreighterConnection } from '@/lib/freighter'
import {
  broadcastWalletChange,
  subscribeWallet,
  type WalletChangePayload,
} from '@/lib/walletEvents'

/**
 * Single app-level watcher shared by every wallet-aware component.
 *
 * `WatchWalletChanges` is instantiated once and reference counted, so the
 * underlying extension polling runs at most once per app and is torn down when
 * the last consumer unmounts.
 */
let watcher: WatchWalletChanges | null = null
let watcherRefCount = 0
let lastAddress: string | null = null
let lastNetwork: string | null = null

function acquireWalletWatcher(): () => void {
  if (!watcher) {
    const instance = new WatchWalletChanges(5000)
    instance.watch((result) => {
      const address = result?.address ?? null
      const network = result?.network ?? null
      const networkPassphrase = result?.networkPassphrase ?? null
      if (address === lastAddress && network === lastNetwork) return
      lastAddress = address
      lastNetwork = network
      broadcastWalletChange({ address, network, networkPassphrase })
    })
    watcher = instance
  }
  watcherRefCount += 1

  let released = false
  return () => {
    if (released) return
    released = true
    watcherRefCount -= 1
    if (watcherRefCount <= 0 && watcher) {
      watcher.stop()
      watcher = null
      watcherRefCount = 0
    }
  }
}

/**
 * Mount the shared wallet watcher for the lifetime of the calling component.
 * Safe to call from any number of components; only one watcher ever runs.
 */
export function useWalletWatcher(): void {
  useEffect(() => acquireWalletWatcher(), [])
}

export interface WalletState {
  /** Connected public key, or null while disconnected. */
  publicKey: string | null
  /** Active Freighter network, or null while unknown/disconnected. */
  network: string | null
  /** Passphrase of the active Freighter network, or null while unknown. */
  networkPassphrase: string | null
  /** True once the initial Freighter connection probe has settled. */
  initialized: boolean
  /** Set the wallet state everywhere, including this instance. */
  publish: (
    publicKey: string | null,
    network?: string | null,
    networkPassphrase?: string | null,
  ) => void
}

/**
 * Shared wallet state for every wallet-aware component.
 *
 * On mount it probes the extension once, then follows the `txwatch:wallet`
 * event bus, so connecting or disconnecting from one component updates all of
 * the others without a reload.
 */
export function useWalletState(): WalletState {
  const [publicKey, setPublicKey] = useState<string | null>(null)
  const [network, setNetwork] = useState<string | null>(null)
  const [networkPassphrase, setNetworkPassphrase] = useState<string | null>(null)
  const [initialized, setInitialized] = useState(false)

  const publish = useCallback(
    (
      next: string | null,
      nextNetwork: string | null = null,
      nextNetworkPassphrase: string | null = null,
    ) => {
      setPublicKey(next)
      setNetwork(nextNetwork)
      setNetworkPassphrase(nextNetworkPassphrase)
      broadcastWalletChange({
        address: next,
        network: nextNetwork,
        networkPassphrase: nextNetworkPassphrase,
      })
    },
    [],
  )

  // One shared watcher for the whole app; no per-instance polling.
  useWalletWatcher()

  useEffect(() => {
    let cancelled = false

    async function probe() {
      try {
        const connection = await readFreighterConnection()
        if (!connection?.publicKey || cancelled) return
        publish(
          connection.publicKey,
          connection.network ?? null,
          connection.networkPassphrase ?? null,
        )
      } catch {
        // Extension refused to answer; stay in the disconnected state.
      } finally {
        if (!cancelled) setInitialized(true)
      }
    }

    probe()

    return () => {
      cancelled = true
    }
  }, [publish])

  // `subscribeWallet` returns its own unsubscribe, which is exactly the
  // cleanup this effect needs.
  useEffect(
    () =>
      subscribeWallet((payload: WalletChangePayload) => {
        setPublicKey(payload.address)
        setNetwork(payload.network)
        setNetworkPassphrase(payload.networkPassphrase)
      }),
    [],
  )

  return { publicKey, network, networkPassphrase, initialized, publish }
}
