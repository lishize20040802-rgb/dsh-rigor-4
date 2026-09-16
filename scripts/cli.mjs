#!/usr/bin/env node
// Dependency-free npx entry point. Low-level scripts keep their preview default.
import path from 'node:path'
import { realpath } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { buildPlan, applyPlan, preview, parseArgs } from './install.mjs'
import { buildUninstallPlan, applyUninstallPlan, previewUninstall } from './uninstall.mjs'

export function parseCliArgs(argv) {
  const [command, ...args] = argv
  if (!command || ['--help', '-h'].includes(command)) return { help: true }
  if (!['setup', 'uninstall'].includes(command)) throw new Error('Use setup or uninstall. Run --help for options.')
  const dry = args.includes('--preview') || args.includes('--dry-run')
  if (dry && args.includes('--apply')) throw new Error('Choose --preview or --apply, not both.')
  const options = parseArgs(args.map(arg => arg === '--preview' ? '--dry-run' : arg))
  return { command, options: { ...options, apply: !dry }, help: options.help }
}

export async function main(argv, runtime = {}) {
  const input = parseCliArgs(argv), log = runtime.log ?? console.log
  if (input.help) {
    log('dsh-rigor-4 setup|uninstall [--preview] [--dsh-home PATH] [--profile NAME] [--dsh-package PATH] [--store-dir PATH] [--replace-presets]\nsetup and uninstall apply by default; --preview performs read-only inspection.')
    return
  }
  const setup = input.command === 'setup'
  const build = setup ? runtime.buildPlan ?? buildPlan : runtime.buildUninstallPlan ?? buildUninstallPlan
  const apply = setup ? runtime.applyPlan ?? applyPlan : runtime.applyUninstallPlan ?? applyUninstallPlan
  const show = setup ? runtime.preview ?? preview : runtime.previewUninstall ?? previewUninstall
  const plan = await build(input.options)
  log(JSON.stringify(show(plan), null, 2))
  if (input.options.apply) log(JSON.stringify(await apply(plan), null, 2))
}

// npm links executable entries on POSIX; Windows can also use directory aliases.
if (process.argv[1] && await realpath(path.resolve(process.argv[1])).catch(() => null) === fileURLToPath(import.meta.url)) {
  try { await main(process.argv.slice(2)) }
  catch (error) { console.error('Rigor: ' + error.message); process.exitCode = 1 }
}
