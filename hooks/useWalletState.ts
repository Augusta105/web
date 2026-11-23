'use client'

import { useCallback, useEffect, useState } from 'react'
import { WatchWalletChanges } from '@stellar/freighter-api'
import { readFreighterConnection } from '@/lib/freighter'
import { broadcastWalletChange, subscribeWallet } from '@/lib/walletEvents'

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
  /** Connected public key, or null while disconnected. Single source of truth. */
  publicKey: string | null
  /** True once the initial Freighter connection probe has settled. */
  initialized: boolean
  /** Set the wallet state everywhere, including this instance. */
  publish: (publicKey: string | null) => void
}

/**
 * Shared wallet state for every wallet-aware component.
 *
 * This is the single source of truth for the connected wallet public key.
 * Nothing is persisted to localStorage or window — legacy values left by older
 * builds are cleared by lib/walletEvents.ts on module load and on every
 * broadcast. Connecting or disconnecting from one component updates all others
 * via the `txwatch:wallet` event bus.
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
      try {
        const connection = await readFreighterConnection()
        if (!connection?.publicKey || cancelled) return
        publish(connection.publicKey)
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
  useEffect(() => subscribeWallet(setPublicKey), [])

  return { publicKey, initialized, publish }
}
