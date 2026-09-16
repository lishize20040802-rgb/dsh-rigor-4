// Locate the user's package-manager installation, never an npx-local DSH peer.
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'

export async function findNpm() {
  const candidates = [
    process.env.npm_execpath && path.join(path.dirname(process.env.npm_execpath), 'npm-cli.js'),
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(path.dirname(path.dirname(process.execPath)), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(Boolean)
  for (const candidate of candidates) {
    try {
      const actual = await fs.realpath(candidate)
      const pkg = JSON.parse(await fs.readFile(path.join(path.dirname(path.dirname(actual)), 'package.json'), 'utf8'))
      if (pkg.name === 'npm') return { executable: process.execPath, prefix: [actual] }
    } catch {}
  }
  return { executable: 'npm', prefix: [] }
}

export async function globalDshPackage(npm, run) {
  const result = await run({ label: 'npm root --global', executable: npm.executable,
    args: [...npm.prefix, 'root', '--global'], cwd: process.cwd(), env: { ...process.env } })
  const root = result.stdout.trim()
  if (!path.isAbsolute(root) || /[\r\n\0]/.test(root)) throw new Error('npm did not return a valid global package directory')
  const directory = await fs.realpath(path.join(root, '@deepseek-ai', 'dsh')).catch(() => null)
  if (!directory) throw new Error('A global @deepseek-ai/dsh installation was not found. Install official DSH first, or pass --dsh-package with its actual installed directory.')
  const pkg = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'))
  if (pkg.name !== '@deepseek-ai/dsh') throw new Error('The global DSH package identity does not match @deepseek-ai/dsh')
  return directory
}

/** Reuse the existing pnpm store; JSON is YAML-compatible, otherwise use DSH's parser. */
export async function profileStoreDir(profileRoot, dshPackage, { loadYaml } = {}) {
  const filename = path.join(profileRoot, 'node_modules', '.modules.yaml')
  let text
  try { text = await fs.readFile(filename, 'utf8') }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
  let metadata
  try { metadata = JSON.parse(text) }
  catch {
    if (!loadYaml) {
      try { loadYaml = createRequire(path.join(dshPackage, 'package.json'))('js-yaml').load }
      catch { throw new Error('Cannot parse existing pnpm store metadata with the installed DSH YAML parser. Pass --store-dir explicitly.') }
    }
    try { metadata = loadYaml(text) }
    catch { throw new Error('Existing pnpm store metadata is invalid. Inspect .modules.yaml or pass --store-dir explicitly.') }
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('Existing pnpm store metadata must be a mapping')
  const store = metadata.storeDir
  if (store === undefined) return undefined
  if (typeof store !== 'string' || !path.isAbsolute(store) || /[\r\n\0]/.test(store)) throw new Error('Existing pnpm storeDir must be an absolute path')
  // .modules.yaml records a versioned store; --store-dir expects its parent.
  const clean = store.replace(/[\\/]$/, '')
  return /[\\/]v\d+$/.test(clean) ? path.dirname(clean) : clean
}
