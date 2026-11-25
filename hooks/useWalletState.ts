'use client'

import { useCallback, useEffect, useState } from 'react'
import { WatchWalletChanges } from '@stellar/freighter-api'
import { readFreighterConnection } from '@/lib/freighter'
import { broadcastWalletChange, subscribeWallet } from '@/lib/walletEvents'

/** Follow-up probes after the first one finds the extension unreachable. */
const LATE_DETECTION_DELAYS_MS = [1000, 2000, 4000]

/**
 * Single app-level watcher shared by every wallet-aware component.
 *
 * `WatchWalletChanges` is instantiated once and reference counted, so the
 * underlying extension polling runs at most once per app and is torn down when
 * the last consumer unmounts.
 */
let watcher: WatchWalletChanges | null = null
let watcherRefCount = 0

function acquireWalletWatcher(): () => void {
  if (!watcher) {
    const instance = new WatchWalletChanges(5000)
    instance.watch((result) => {
      broadcastWalletChange(result?.address ?? null)
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
  /** True once the initial Freighter connection probe has settled. */
  initialized: boolean
  /** Set the wallet state everywhere, including this instance. */
  publish: (publicKey: string | null) => void
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
  const [initialized, setInitialized] = useState(false)

  const publish = useCallback((next: string | null) => {
    setPublicKey(next)
    broadcastWalletChange(next)
  }, [])

  // One shared watcher for the whole app; no per-instance polling.
  useWalletWatcher()

  useEffect(() => {
    let cancelled = false

    async function probe() {
      let connection: Awaited<ReturnType<typeof readFreighterConnection>> = null
      try {
        connection = await readFreighterConnection()
      } catch {
        // Extension refused to answer; stay in the disconnected state.
      }
      if (cancelled) return
      if (connection?.publicKey) publish(connection.publicKey)
      setInitialized(true)

      // The extension can inject its API after the first probe on a slow
      // machine. `null` means "not reachable" (as opposed to a reachable but
      // locked wallet), so keep checking for a short window in the background
      // instead of leaving the user on a false "not connected" state (#527).
      for (const delay of LATE_DETECTION_DELAYS_MS) {
        if (connection) return
        await new Promise((resolve) => setTimeout(resolve, delay))
        if (cancelled) return
        try {
          connection = await readFreighterConnection()
        } catch {
          connection = null
        }
        if (cancelled) return
        if (connection?.publicKey) publish(connection.publicKey)
      }
    }

    probe()

    return () => {
      cancelled = true
    }
  }, [publish])

  // `subscribeWallet` returns its own unsubscribe, which is exactly the
  // cleanup this effect needs.
  useEffect(() => subscribeWallet(setPublicKey), [])

  return { publicKey, initialized, publish }
}
