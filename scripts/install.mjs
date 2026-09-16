#!/usr/bin/env node
// Thin, offline forwarding to the user's installed official DSH/pnpm.
import * as fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { findNpm, globalDshPackage, profileStoreDir } from './native-tools.mjs'

const NAME = 'dsh-rigor-4'
const SOURCE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const VARIANTS = { standard: 'rigor-4', ptc: 'rigor-4-ptc', cordis: 'rigor-4-cordis', minimal: 'rigor-4-minimal' }
const FLAGS = ['--offline', '--ignore-scripts', '--ignore-pnpmfile']
const json = value => JSON.stringify(value, null, 2) + '\n'
const slash = value => value.split(path.sep).join('/')
async function present(file) { try { return await fs.lstat(file) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }
function inside(root, target) { const rel = path.relative(root, target); return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel) }
function homePath(value) {
  const named = value?.trim() || path.join(os.homedir(), '.dsh')
  return path.resolve(named === '~' ? os.homedir() : /^~[/\\]/.test(named) ? path.join(os.homedir(), named.slice(2)) : named)
}
async function readJson(file) { return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '')) }
async function safeFile(dshHome, target) {
  if (!inside(dshHome, target) || target === dshHome) throw new Error(`Target is outside DSH home: ${target}`)
  for (let current = target; current !== dshHome; current = path.dirname(current)) {
    const stat = await present(current)
    if (stat?.isSymbolicLink()) throw new Error(`Preset/archive target must not traverse a link: ${current}`)
    if (stat && current !== target && !stat.isDirectory()) throw new Error(`Expected directory: ${current}`)
  }
}

/** Read-only preview; the only optional command probes npm's global directory. */
export async function buildPlan(options = {}) {
  const profile = options.profile ?? 'web'
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(profile)) throw new Error('Profile must be one plain directory name')
  const dshHome = await fs.realpath(homePath(options.dshHome ?? process.env.DSH_HOME))
  const packageRoot = await fs.realpath(path.resolve(options.packageRoot ?? SOURCE_ROOT))
  const profileRoot = path.join(dshHome, 'profiles', profile)
  const profileManifest = path.join(profileRoot, 'package.json')
  if (!(await present(profileManifest))) throw new Error(`Existing official DSH profile not found: ${profileRoot}. Initialize it with official DSH first.`)
  await safeFile(dshHome, profileManifest)
  const manifest = await readJson(path.join(packageRoot, 'package.json'))
  if (manifest.name !== NAME || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(manifest.version)) throw new Error(`Package root must contain a versioned ${NAME}/package.json`)
  if (Object.keys(manifest.dependencies ?? {}).length || Object.keys(manifest.peerDependencies ?? {}).length) throw new Error('This Rigor installer expects a release with no runtime dependencies.')
  if (!(await present(path.join(packageRoot, 'src', 'index.js')))) throw new Error('Release is missing src/index.js')
  const currentProfile = await readJson(profileManifest)
  if (!currentProfile.dsh?.profile || !Array.isArray(currentProfile.dsh.profile.bundles)) throw new Error('Target is not an initialized official DSH profile (missing dsh.profile.bundles)')
  const npm = await findNpm()
  const suppliedDsh = options.dshPackage ?? await globalDshPackage(npm, options.probe ?? runCommand)
  let dsh
  const dshPackage = await fs.realpath(path.resolve(suppliedDsh))
  {
    const root = dshPackage
    const host = await readJson(path.join(root, 'package.json'))
    if (host.name !== '@deepseek-ai/dsh') throw new Error('--dsh-package must name the installed official @deepseek-ai/dsh package')
    const cli = path.join(root, 'lib', 'bin.js')
    if (!(await present(cli))) throw new Error(`Official DSH CLI is missing: ${cli}`)
    dsh = { executable: process.execPath, prefix: [cli], version: host.version }
  }
  const archiveDir = path.join(dshHome, 'third-party', 'archives')
  const archive = path.join(archiveDir, `${NAME}-${manifest.version}.tgz`)
  await safeFile(dshHome, archive)
  const archiveStat = await present(archive)
  if (archiveStat && !archiveStat.isFile()) throw new Error(`Package archive is not a regular file: ${archive}`)
  const presets = []
  for (const [variant, directory] of Object.entries(VARIANTS)) for (const filename of ['preset.yml', 'agent.cordis.yml']) {
    const source = path.join(packageRoot, 'preset', variant, filename)
    const bytes = await fs.readFile(source)
    const target = path.join(dshHome, '.agent-presets', directory, filename)
    await safeFile(dshHome, target)
    const stat = await present(target)
    if (stat && !stat.isFile()) throw new Error(`Preset is not a regular file: ${target}`)
    const before = stat ? await fs.readFile(target) : null
    const action = before?.equals(bytes) ? 'unchanged' : before && !options.replacePresets ? 'preserve' : before ? 'replace' : 'create'
    presets.push({ source, target, bytes, before, action })
  }
  return { profile, dshHome, packageRoot, profileRoot, profileManifest, archiveDir, archive, npm, dsh, version: manifest.version,
    dependency: `file:${slash(path.relative(profileRoot, archive))}`, presets, testedDSHVersions: manifest.testedDSHVersions ?? [],
    storeDir: options.storeDir ? path.resolve(options.storeDir) : await profileStoreDir(profileRoot, dshPackage) }
}

export function preview(plan) {
  const storeFlags = plan.storeDir ? ['--store-dir', plan.storeDir] : []
  return { mode: 'dry-run', package: `${NAME}@${plan.version}`, profile: plan.profile, dshHome: plan.dshHome,
    archive: plan.archive, dependency: plan.dependency,
    commands: [
      ['npm', 'pack', '--ignore-scripts', '--pack-destination', '<temporary directory under third-party/archives>', '--json'],
      ['dsh', 'plugin', '--profile', plan.profile, 'add', plan.archive, ...FLAGS, ...storeFlags],
      ['dsh', 'plugin', '--profile', plan.profile, 'install', '--lockfile-only', ...FLAGS, ...storeFlags],
    ],
    manifestChange: { file: plan.profileManifest, dependency: NAME, value: plan.dependency },
    presets: plan.presets.map(({ target, action }) => ({ target, action })),
    packageManager: 'Official DSH forwards to pnpm. pnpm owns node_modules and every lockfile change.',
    failureBoundary: 'Native failures can leave native changes. Presets are copied after package installation and resolution succeed. This wrapper does not roll back the profile.',
    testedDSHVersions: plan.testedDSHVersions, ...(plan.storeDir ? { storeDir: plan.storeDir } : {}) }
}

export function cmdQuote(value) {
  if (/["%\r\n\0]/.test(value)) throw new Error('Windows command paths must not contain quotes, percent signs, or control characters')
  return `"${value}"`
}
export function runCommand(command) {
  const shellEntry = process.platform === 'win32' && !/\.(?:exe|com)$/i.test(command.executable)
  const child = shellEntry
    ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/v:off', '/s', '/c', [command.executable, ...command.args].map(cmdQuote).join(' ')], { cwd: command.cwd, env: command.env, encoding: 'utf8', windowsHide: true, timeout: 120000 })
    : spawnSync(command.executable, command.args, { cwd: command.cwd, env: command.env, encoding: 'utf8', windowsHide: true, timeout: 120000 })
  if (child.error || child.status !== 0) throw new Error(`${command.label} failed: ${child.error?.message || child.stderr?.trim() || `exit ${child.status}`}. Check official DSH, npm and pnpm on PATH and the offline cache for this profile's other dependencies. Native profile changes may already exist.`)
  return child
}

/** npm packs; the original DSH command performs all package operations. */
export async function applyPlan(plan, { run = runCommand } = {}) {
  await fs.mkdir(plan.archiveDir, { recursive: true })
  const staging = await fs.mkdtemp(path.join(plan.archiveDir, '.rigor-pack-'))
  const env = { ...process.env, DSH_HOME: plan.dshHome, COREPACK_ENABLE_NETWORK: '0', COREPACK_ENABLE_AUTO_PIN: '0' }
  const call = async (label, tool, args, cwd) => run({ label, executable: tool.executable, args: [...tool.prefix, ...args], cwd, env })
  try {
    const packed = await call('npm pack', plan.npm, ['pack', '--ignore-scripts', '--pack-destination', staging, '--json'], plan.packageRoot)
    let metadata
    try { metadata = JSON.parse(packed.stdout) } catch { throw new Error('npm pack did not return JSON metadata') }
    if (!Array.isArray(metadata) || metadata.length !== 1 || metadata[0].filename !== path.basename(plan.archive)) throw new Error('npm pack returned an unexpected release filename')
    const packedFile = path.join(staging, metadata[0].filename)
    const packedBytes = await fs.readFile(packedFile)
    if (await present(plan.archive)) {
      if (!(await fs.readFile(plan.archive)).equals(packedBytes)) throw new Error(`Release archive already exists with different contents: ${plan.archive}. Use a new package version; existing archives remain unchanged.`)
    } else await fs.copyFile(packedFile, plan.archive, 1)
    const nativePath = value => process.platform === 'win32' && plan.dsh.prefix.length ? cmdQuote(value) : value
    if (process.platform === 'win32' && !plan.dsh.prefix.length && /[\s&|<>^()%!"]/.test(plan.archive + (plan.storeDir ?? ''))) throw new Error('For Windows paths with spaces or shell punctuation, pass --dsh-package pointing to the installed official DSH package.')
    const nativeFlags = [...FLAGS, ...(plan.storeDir ? ['--store-dir', nativePath(plan.storeDir)] : [])]
    // DSH itself forwards through a Windows shell. Preserve quotes for spaces.
    const archiveArgument = nativePath(plan.archive)
    await call('dsh plugin add', plan.dsh, ['plugin', '--profile', plan.profile, 'add', archiveArgument, ...nativeFlags], plan.profileRoot)
    const after = await readJson(plan.profileManifest)
    if (!after.dependencies?.[NAME]) throw new Error('Official package manager returned success without declaring Rigor in the profile')
    after.dependencies[NAME] = plan.dependency
    await fs.writeFile(plan.profileManifest, json(after))
    await call('dsh plugin install --lockfile-only', plan.dsh, ['plugin', '--profile', plan.profile, 'install', '--lockfile-only', ...nativeFlags], plan.profileRoot)
    const resolved = createRequire(plan.profileManifest).resolve(NAME)
    const installedRoot = path.join(plan.profileRoot, 'node_modules', NAME)
    const installed = await readJson(path.join(installedRoot, 'package.json'))
    if (installed.version !== plan.version || !inside(await fs.realpath(installedRoot), await fs.realpath(resolved))) throw new Error('Installed Rigor did not resolve to the requested release')
    if ((await present(installedRoot))?.isSymbolicLink()) throw new Error('Rigor still resolves through a source link; check native pnpm installation')
    if ((await readJson(plan.profileManifest)).dependencies?.[NAME] !== plan.dependency) throw new Error('Native lock refresh changed the relative archive dependency')
    for (const item of plan.presets) {
      if (item.action === 'preserve' || item.action === 'unchanged') continue
      await safeFile(plan.dshHome, item.target)
      const current = await present(item.target) ? await fs.readFile(item.target) : null
      if (current === null ? item.before !== null : item.before === null || !current.equals(item.before)) throw new Error(`Preset changed after preview: ${item.target}. Native installation succeeded; rebuild the preview before copying presets.`)
    }
    for (const item of plan.presets) if (item.action === 'create' || item.action === 'replace') {
      await fs.mkdir(path.dirname(item.target), { recursive: true })
      await fs.writeFile(item.target, item.bytes, item.action === 'create' ? { flag: 'wx' } : undefined)
    }
    return { verified: true, package: `${NAME}@${plan.version}`, archive: plan.archive, dependency: plan.dependency, resolved,
      presets: plan.presets.map(({ target, action }) => ({ target, action })) }
  } finally {
    if (path.dirname(staging) !== plan.archiveDir || !path.basename(staging).startsWith('.rigor-pack-')) throw new Error('Invalid temporary pack directory')
    await fs.rm(staging, { recursive: true, force: true })
  }
}

export function parseArgs(args) {
  const options = { apply: false }
  const values = { '--dsh-home': 'dshHome', '--profile': 'profile', '--package-root': 'packageRoot', '--dsh-package': 'dshPackage', '--store-dir': 'storeDir' }
  for (let i = 0; i < args.length; i++) {
    const item = args[i]
    if (item === '--apply') options.apply = true
    else if (item === '--dry-run') options.apply = false
    else if (item === '--replace-presets') options.replacePresets = true
    else if (item === '--help' || item === '-h') options.help = true
    else if (values[item]) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value for ${item}`)
      options[values[item]] = args[++i]
    } else throw new Error(`Unknown option: ${item}`)
  }
  return options
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2))
    if (options.help) console.log('node scripts/install.mjs [--dry-run|--apply] [--dsh-home PATH] [--profile NAME] [--package-root PATH] [--dsh-package PATH] [--store-dir PATH] [--replace-presets]')
    else { const plan = await buildPlan(options); console.log(json(preview(plan))); if (options.apply) console.log(json(await applyPlan(plan))) }
  } catch (error) { console.error(`Rigor install: ${error.message}`); process.exitCode = 1 }
}
