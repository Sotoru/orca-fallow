import { watch, type FSWatcher } from 'node:fs'

const SKIP = /(^|[\\/])(node_modules|\.git|\.orca|dist|build|out|coverage|\.next|\.svelte-kit|\.turbo|\.cache)([\\/]|$)/
const SOURCE = /\.(m|c)?(j|t)sx?$|\.(vue|svelte|astro)$/
const CONFIG = /(^|[\\/])(package\.json|tsconfig[^\\/]*\.json|\.fallowrc[^\\/]*|fallow\.config\.[^\\/]+)$/

/** Whether a changed file can change Fallow's answer: sources and the configs Fallow reads. */
export const relevant = (file: string) => !SKIP.test(file) && (SOURCE.test(file) || CONFIG.test(file))

/**
 * Calls `onChange` once things settle after the last relevant change under `root`.
 * Returns a closer; a folder it cannot watch (gone, no permission) leaves only the manual button.
 */
export function follow(root: string, onChange: () => void, delayMs = 3000): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let watcher: FSWatcher | null = null
  try {
    watcher = watch(root, { recursive: true }, (_, name) => {
      if (!name || !relevant(name.toString())) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(onChange, delayMs)
    })
    watcher.on('error', () => watcher?.close())
  } catch {
    watcher = null
  }
  return () => {
    if (timer) clearTimeout(timer)
    watcher?.close()
  }
}
