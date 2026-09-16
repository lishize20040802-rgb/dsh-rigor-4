#!/usr/bin/env node
// Official DSH removes the package; only unchanged, release-owned presets are removed here.
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPlan, parseArgs, runCommand, cmdQuote } from './install.mjs'

// remove lacks the add/install shorthand; pnpm accepts the explicit config key.
const REMOVE_FLAGS = ['--config.ignore-pnpmfile=true']

async function read(file) {
  try { return await fs.readFile(file) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
async function safePreset(home, target) {
  const relative = path.relative(home, target)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Preset target is outside DSH home')
  for (let current = target; current !== home; current = path.dirname(current)) {
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('Preset path traverses a link') }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
}

export async function buildUninstallPlan(options = {}) {
  const install = await buildPlan(options)
  const otherProfiles = []
  for (const entry of await fs.readdir(path.join(install.dshHome, 'profiles'), { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === install.profile || entry.name === 'node_modules') continue
    const bytes = await read(path.join(install.dshHome, 'profiles', entry.name, 'package.json'))
    if (bytes && JSON.parse(bytes.toString('utf8')).dependencies?.['dsh-rigor-4']) otherProfiles.push(entry.name)
  }
  const presets = install.presets.map(item => ({ ...item,
    action: otherProfiles.length ? 'preserve-shared' : item.before === null ? 'absent' : item.before.equals(item.bytes) ? 'remove' : 'preserve-custom',
  }))
  const customFiles = presets.filter(item => item.action === 'preserve-custom').map(item => item.target)
  const profile = JSON.parse((await fs.readFile(install.profileManifest, 'utf8')).replace(/^\uFEFF/, ''))
  return { ...install, presets, otherProfiles, customFiles, installed: Boolean(profile.dependencies?.['dsh-rigor-4']) }
}

export function previewUninstall(plan) {
  return { mode: 'dry-run', package: 'dsh-rigor-4', profile: plan.profile,
    command: ['dsh', 'plugin', '--profile', plan.profile, 'remove', 'dsh-rigor-4', ...REMOVE_FLAGS, ...(plan.storeDir ? ['--store-dir', plan.storeDir] : [])],
    installed: plan.installed, otherProfiles: plan.otherProfiles, customFiles: plan.customFiles,
    presets: plan.presets.map(({ target, action }) => ({ target, action })),
    data: 'Session state, credentials and release archives are preserved. Customized presets block apply; export/remove them explicitly before retrying.',
  }
}

export async function applyUninstallPlan(plan, { run = runCommand } = {}) {
  if (plan.customFiles.length) throw new Error('Customized Rigor presets exist. Export and remove those presets explicitly before uninstalling: ' + plan.customFiles.join(', '))
  const removals = plan.presets.filter(item => item.action === 'remove')
  for (const item of removals) {
    await safePreset(plan.dshHome, item.target)
    const current = await read(item.target)
    if (!current?.equals(item.before)) throw new Error('Preset changed after preview; rebuild the uninstall plan: ' + item.target)
  }
  if (plan.installed) await run({ label: 'dsh plugin remove', executable: plan.dsh.executable,
    args: [...plan.dsh.prefix, 'plugin', '--profile', plan.profile, 'remove', 'dsh-rigor-4', ...REMOVE_FLAGS,
      ...(plan.storeDir ? ['--store-dir', process.platform === 'win32' && plan.dsh.prefix.length ? cmdQuote(plan.storeDir) : plan.storeDir] : [])],
    cwd: plan.profileRoot, env: { ...process.env, DSH_HOME: plan.dshHome, COREPACK_ENABLE_NETWORK: '0', COREPACK_ENABLE_AUTO_PIN: '0' },
  })
  const after = JSON.parse(await fs.readFile(plan.profileManifest, 'utf8'))
  if (after.dependencies?.['dsh-rigor-4']) throw new Error('Official package manager did not remove Rigor; presets are preserved')
  for (const item of removals) {
    await safePreset(plan.dshHome, item.target)
    const current = await read(item.target)
    if (!current?.equals(item.before)) throw new Error('Preset changed during native uninstall; it is preserved: ' + item.target)
    await fs.unlink(item.target)
  }
  for (const directory of new Set(removals.map(item => path.dirname(item.target)))) {
    // Non-recursive removal cannot erase extra files or customized subdirectories.
    await fs.rmdir(directory).catch(error => { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error })
  }
  return { removed: plan.installed, presetsRemoved: removals.length, otherProfiles: plan.otherProfiles, sessionDataPreserved: true }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2))
    if (options.help) console.log('node scripts/uninstall.mjs [--dry-run|--apply] [--dsh-home PATH] [--profile NAME] [--dsh-package PATH] [--store-dir PATH]')
    else { const plan = await buildUninstallPlan(options); console.log(JSON.stringify(previewUninstall(plan), null, 2)); if (options.apply) console.log(JSON.stringify(await applyUninstallPlan(plan), null, 2)) }
  } catch (error) { console.error('Rigor uninstall: ' + error.message); process.exitCode = 1 }
}
