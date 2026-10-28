/**
 * Behavioural smoke test for the dsh-balance-whale bundle: no browser, no Host,
 * no Platform, no build step.
 *
 * The client half is mounted through a tiny React replacement that really runs
 * hooks, effects and the async fetch path, so this exercises the widget the way
 * the page does — hover opens the card, a drag snaps and flips, a tap forces a
 * refresh, picking a skin rewrites the picture — and reads the rendered tree
 * back (odometer digits are reconstructed from their strip transforms).
 *
 * The host half is mounted against a mock `deepseekAccount` service and mock
 * Cordis events, and its ledger math, work-state tracking, JSON responses and
 * asset route are all checked. DSH_HOME points at a scratch directory so the
 * real ledger of the running Harness is never touched.
 *
 * usage: node tools/balance-whale-smoke.mjs
 */
import { existsSync, rmSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * Locate the widget package. The shipped kit keeps it in `../dsh-balance-whale`;
 * a source checkout may place this script anywhere, so an explicit
 * `BALANCE_WHALE_DIR` wins and the remaining candidates are probed by manifest.
 */
async function findPackageDir() {
  const candidates = [
    process.env.BALANCE_WHALE_DIR,
    resolve(here, '..', 'dsh-balance-whale'),
    resolve(here, '..'),
    resolve(here, '..', '..', 'dsh-balance-whale'),
  ].filter((value) => typeof value === 'string' && value !== '')
  for (const candidate of candidates) {
    try {
      const manifest = JSON.parse(await readFile(join(candidate, 'package.json'), 'utf8'))
      if (manifest.name === 'dsh-balance-whale' && existsSync(join(candidate, 'index.js'))) {
        return resolve(candidate)
      }
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error('cannot find the dsh-balance-whale package; set BALANCE_WHALE_DIR to its directory')
}

const packageDir = await findPackageDir()
const assetsDir = join(packageDir, 'assets')
// A scratch ledger home: the running Harness's own ledger is never touched.
process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'balance-whale-test-'))

console.log('package:           ' + packageDir)
console.log('scratch DSH_HOME:  ' + process.env.DSH_HOME)
console.log('profile (optional): ' + (process.env.DSH_PROFILE_DIR ?? 'not set'))

let failures = 0
let checks = 0

/** One assertion. */
function check(label, condition, detail = '') {
  checks += 1
  if (condition) {
    console.log('  ok   ' + label)
    return
  }
  failures += 1
  console.log('  FAIL ' + label + (detail === '' ? '' : ' — ' + detail))
}

/** Section banner. */
function section(title) {
  console.log('\n' + title)
}

/**
 * Read the bundle patch. The profile's own YAML implementation is used when a
 * profile directory is available; otherwise this bundle's fixed patch shape is
 * read with a small regex, so the self-test works on a bare machine.
 *
 * @returns {Promise<{ rows: { id?: string, name?: string }[], parser: string }>} The inserted rows.
 */
async function readPatch() {
  const text = await readFile(join(packageDir, 'cordis.patch.yml'), 'utf8')
  const profileDir = process.env.DSH_PROFILE_DIR
  if (typeof profileDir === 'string' && profileDir !== '' && existsSync(join(profileDir, 'package.json'))) {
    try {
      const profileRequire = createRequire(join(profileDir, 'package.json'))
      const YAML = profileRequire('yaml')
      const parsed = YAML.parse(text)
      const rows = []
      for (const entry of Array.isArray(parsed) ? parsed : []) {
        for (const row of Array.isArray(entry?.insert) ? entry.insert : []) rows.push(row)
      }
      return { rows, parser: 'yaml' }
    } catch {
      /* fall through to the dependency-free reader */
    }
  }
  const block = text.split(/^\s*-\s*insert:\s*$/m)[1] ?? text
  const id = /^\s*-\s*id:\s*['"]?([^'"\s]+)['"]?/m.exec(block)?.[1]
  const name = /^\s*name:\s*['"]?([^'"\s]+)['"]?/m.exec(block)?.[1]
  return { rows: id === undefined ? [] : [{ id, name }], parser: 'regex' }
}

/** Every skin directory that carries a readable manifest, in the host's order. */
async function readLocalSkins() {
  const skins = []
  if (!existsSync(assetsDir)) return skins
  for (const entry of await readdir(assetsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    try {
      const manifest = JSON.parse(await readFile(join(assetsDir, entry.name, 'skin.json'), 'utf8'))
      const order = Number.isFinite(Number(manifest.order)) ? Number(manifest.order) : 50
      skins.push({ id: entry.name, order, frames: manifest.frames ?? {} })
    } catch {
      /* a directory without a valid manifest is not discovered */
    }
  }
  return skins.sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
}

/** A fake ServerResponse capturing status, headers and body. */
function fakeResponse() {
  const res = {
    status: undefined,
    headers: undefined,
    body: undefined,
    bytes: undefined,
    writeHead(status, headers) {
      res.status = status
      res.headers = headers
    },
    end(payload) {
      res.bytes = payload
      res.body = typeof payload === 'string' ? JSON.parse(payload) : undefined
    },
  }
  return res
}

/** A fake IncomingMessage. */
function fakeRequest({ method = 'GET', url = '/api/balance-whale/state', address = '127.0.0.1' } = {}) {
  return { method, url, socket: { remoteAddress: address } }
}

/** Wait until a predicate holds, within a bounded number of macrotasks. */
async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return true
    await new Promise((tick) => setTimeout(tick, 0))
  }
  throw new Error('timed out waiting for ' + label)
}

// ---------------------------------------------------------------------------
// A small React replacement: hooks with dependency tracking, effects that run
// after commit, setters that schedule a re-render, and stable instance identity
// by render path.

function shallowEqual(left, right) {
  if (left === right) return true
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
  return left.every((value, index) => Object.is(value, right[index]))
}

function createMiniReact(clock) {
  const instances = new Map()
  let currentInstance = null
  let pendingEffects = []
  let renderRequested = false
  let rootElement = null
  let tree = null

  function hookSlot(instance, index, create) {
    if (instance.hooks.length <= index) instance.hooks.push(create())
    return instance.hooks[index]
  }

  function render(node, path) {
    if (node === null || node === undefined || typeof node === 'boolean') return null
    if (typeof node === 'string' || typeof node === 'number') return { text: String(node) }
    if (Array.isArray(node)) return node.map((child, index) => render(child, path + '[' + index + ']'))
    if (typeof node.type === 'function') {
      const key = path
      let instance = instances.get(key)
      if (instance === undefined || instance.type !== node.type) {
        instance = { type: node.type, hooks: [], cursor: 0 }
        instances.set(key, instance)
      }
      instance.cursor = 0
      const previous = currentInstance
      currentInstance = instance
      let output
      try {
        output = node.type(node.props)
      } finally {
        currentInstance = previous
      }
      return render(output, path + '/' + node.type.name)
    }
    return {
      type: node.type,
      props: node.props,
      children: (node.children ?? []).map((child, index) => render(child, path + '.<' + index + '>')),
    }
  }

  async function flush() {
    for (let pass = 0; pass < 40; pass += 1) {
      tree = render(rootElement, 'root')
      const effects = pendingEffects
      pendingEffects = []
      for (const hook of effects) {
        if (typeof hook.cleanup === 'function') hook.cleanup()
        hook.cleanup = hook.fn()
      }
      // Let the async fetches inside effects settle, then re-render if any of
      // their setters fired.
      for (let tick = 0; tick < 6; tick += 1) await Promise.resolve()
      if (!renderRequested && pendingEffects.length === 0) return tree
      renderRequested = false
    }
    return tree
  }

  const React = {
    Fragment: Symbol('react.fragment'),
    createElement(type, props, ...children) {
      return {
        type,
        props: props ?? {},
        children: children.flat(Infinity).filter((child) => child !== undefined),
        key: props?.key,
      }
    },
    useState(initial) {
      const instance = currentInstance
      const index = instance.cursor
      instance.cursor += 1
      const hook = hookSlot(instance, index, () => ({
        value: typeof initial === 'function' ? initial() : initial,
        setter: null,
      }))
      if (hook.setter === null) {
        hook.setter = (next) => {
          const value = typeof next === 'function' ? next(hook.value) : next
          if (Object.is(value, hook.value)) return
          hook.value = value
          renderRequested = true
        }
      }
      return [hook.value, hook.setter]
    },
    useRef(initial) {
      const instance = currentInstance
      const index = instance.cursor
      instance.cursor += 1
      return hookSlot(instance, index, () => ({ current: initial }))
    },
    useMemo(factory, deps) {
      const instance = currentInstance
      const index = instance.cursor
      instance.cursor += 1
      const hook = hookSlot(instance, index, () => ({ value: undefined, deps: null }))
      if (hook.deps === null || !shallowEqual(hook.deps, deps)) {
        hook.value = factory()
        hook.deps = deps
      }
      return hook.value
    },
    useCallback(fn, deps) {
      const instance = currentInstance
      const index = instance.cursor
      instance.cursor += 1
      const hook = hookSlot(instance, index, () => ({ value: fn, deps: null }))
      if (hook.deps === null || !shallowEqual(hook.deps, deps)) {
        hook.value = fn
        hook.deps = deps
      }
      return hook.value
    },
    useEffect(fn, deps) {
      const instance = currentInstance
      const index = instance.cursor
      instance.cursor += 1
      const hook = hookSlot(instance, index, () => ({ deps: null, cleanup: undefined, fn }))
      if (hook.deps === null || !shallowEqual(hook.deps, deps)) {
        hook.fn = fn
        hook.deps = deps
        pendingEffects.push(hook)
      }
    },
  }

  return {
    React,
    async mount(element) {
      rootElement = element
      return flush()
    },
    async update() {
      return flush()
    },
    /**
     * Move the virtual clock forward and run the callbacks that come due, so
     * timer-driven behaviour (bubble expiry, flash clearing, idle chatter) is
     * testable without waiting in real time.
     */
    async advance(ms) {
      clock.now += ms
      for (let pass = 0; pass < 30; pass += 1) {
        const due = [...clock.timers.entries()]
          .filter(([, timer]) => timer.at <= clock.now)
          .sort((left, right) => left[1].at - right[1].at)
        if (due.length === 0) break
        for (const [id, timer] of due) {
          clock.timers.delete(id)
          timer.fn()
        }
      }
      return flush()
    },
    get tree() {
      return tree
    },
  }
}

/** Depth-first search for the first node matching a predicate. */
function findNode(node, predicate) {
  if (node === null || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findNode(child, predicate)
      if (hit !== null) return hit
    }
    return null
  }
  if (predicate(node)) return node
  for (const child of node.children ?? []) {
    const hit = findNode(child, predicate)
    if (hit !== null) return hit
  }
  return null
}

/** Find every node matching a predicate. */
function findAll(node, predicate, out = []) {
  if (node === null || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, out)
    return out
  }
  if (predicate(node)) out.push(node)
  for (const child of node.children ?? []) findAll(child, predicate, out)
  return out
}

/** Text of a subtree. */
function textOf(node) {
  if (node === null || typeof node !== 'object') return ''
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (typeof node.text === 'string') return node.text
  return (node.children ?? []).map(textOf).join(' ')
}

/** Whether a node carries one exact class token. */
function hasClass(node, name) {
  const className = node?.props?.className
  return typeof className === 'string' && className.split(/\s+/).includes(name)
}

/** The speech bubble's current text. */
function bubbleText(tree) {
  const node = findNode(tree, (item) => hasClass(item, 'bw-bubble'))
  return node === null ? '' : textOf(node)
}

/** Read one odometer subtree back into the number it displays. */
function odometerValue(node) {
  if (node === null || typeof node !== 'object') return ''
  if (Array.isArray(node)) return node.map(odometerValue).join('')
  if (typeof node.text === 'string') return node.text
  const className = String(node.props?.className ?? '')
  if (className.includes('bw-digit')) {
    const strip = (node.children ?? []).find((child) => String(child?.props?.className ?? '').includes('bw-strip'))
    const match = /translateY\((-?\d+)em\)/.exec(String(strip?.props?.style?.transform ?? ''))
    return match === null ? '?' : String(-Number(match[1]))
  }
  return (node.children ?? []).map(odometerValue).join('')
}

/** Every `.bw-num` value in the tree, in document order. */
function odometerValues(node, out = []) {
  if (node === null || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) odometerValues(child, out)
    return out
  }
  const className = String(node.props?.className ?? '')
  if (className.split(/\s+/).includes('bw-num')) out.push(odometerValue(node))
  for (const child of node.children ?? []) odometerValues(child, out)
  return out
}

/** The root widget node (`.bw-root`). */
function rootNode(tree) {
  return findNode(tree, (node) => String(node.props?.className ?? '').includes('bw-root'))
}

/** Embedded markup of a subtree (the inline whale and the mood props). */
function markupOf(node, out = '') {
  if (node === null || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) out += markupOf(child, out)
    return out
  }
  if (typeof node.props?.dangerouslySetInnerHTML?.__html === 'string') out += node.props.dangerouslySetInnerHTML.__html
  for (const child of node.children ?? []) out += markupOf(child)
  return out
}

/** A state payload shaped exactly like the host's `/state` answer. */
function stateBody(overrides = {}) {
  return {
    ok: true,
    signedIn: true,
    error: null,
    wallets: [{ currency: 'CNY', balance: '7.1159' }],
    bonusWallets: [{ currency: 'CNY', balance: '4.7109' }],
    totals: [{ currency: 'CNY', recharge: '7.12', bonus: '4.71', total: '11.83' }],
    links: { usageUrl: 'https://platform.deepseek.com/usage', topUpUrl: 'https://platform.deepseek.com/top_up' },
    activity: { phase: 'idle', tool: null, toolAt: 0, since: 0, running: 0, error: null },
    ledger: {
      currency: 'CNY',
      today: { date: '2026-02-05', spent: 0.42, topUp: 0, turns: 3 },
      lastTurn: { delta: 0.12, at: 1_790_000_000_000, count: 3, pending: false },
      sinceStart: { spent: 0.3, startedAt: 1_789_000_000_000 },
      days: [
        { date: '2026-01-30', label: '01-30', spent: 0.2, topUp: 0, turns: 2 },
        { date: '2026-01-31', label: '01-31', spent: 0, topUp: 0, turns: 0 },
        { date: '2026-02-01', label: '02-01', spent: 1.1, topUp: 0, turns: 5 },
        { date: '2026-02-02', label: '02-02', spent: 0.6, topUp: 0, turns: 3 },
        { date: '2026-02-03', label: '02-03', spent: 0.9, topUp: 0, turns: 4 },
        { date: '2026-02-04', label: '2026-02-04'.slice(5), spent: 0.35, topUp: 0, turns: 2 },
        { date: '2026-02-05', label: '02-05', spent: 0.42, topUp: 0, turns: 3 },
      ],
      recent: [
        { at: 1_790_000_000_000, kind: 'spend', delta: -0.12, total: 11.83, tool: 'read' },
        { at: 1_789_999_000_000, kind: 'spend', delta: -0.05, total: 11.95, tool: 'grep' },
      ],
      samples: 12,
    },
    skins: [
      { id: 'maid-blue', name: '女仆小鲸鱼', accent: '#4D6BFE', plate: null, builtin: false },
      { id: 'whale-classic', name: '深海经典鲸', accent: '#4D6BFE', plate: null, builtin: true },
    ],
    size: 96,
    refreshSeconds: 30,
    updatedAt: 1_790_000_100_000,
    ...overrides,
  }
}

/** The `/skins` answer shaped like the host's. */
function skinsBody() {
  return {
    ok: true,
    defaultSkin: 'maid-blue',
    skins: [
      {
        id: 'maid-blue',
        name: '女仆小鲸鱼',
        accent: '#4D6BFE',
        plate: null,
        builtin: false,
        frames: {
          idle: '/api/balance-whale/assets/maid-blue/idle.png',
          happy: '/api/balance-whale/assets/maid-blue/happy.png',
          work: '/api/balance-whale/assets/maid-blue/work.png',
        },
      },
      {
        id: 'elf-violet',
        name: '紫罗兰精灵',
        accent: '#A98BFF',
        plate: null,
        builtin: false,
        frames: { idle: '/api/balance-whale/assets/elf-violet/idle.png' },
      },
      { id: 'whale-classic', name: '深海经典鲸', accent: '#4D6BFE', plate: null, builtin: true, frames: {} },
    ],
  }
}

// ---------------------------------------------------------------------------

section('manifest and patch')
const manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'))
check('package name', manifest.name === 'dsh-balance-whale', manifest.name)
check('client export declared', manifest.exports?.['./client'] === './client.js')
check('bundle patch declared', manifest.dsh?.bundle?.patch === './cordis.patch.yml')
check('client platform is web', manifest.dsh?.client?.platform === 'web')
check('client loads immediately', manifest.dsh?.client?.immediately === true)
check('icon declared', manifest.icon === './icon.svg')
check('assets ship with the package', Array.isArray(manifest.files) && manifest.files.includes('assets'))

const patch = await readPatch()
const insertedRow = patch.rows[0]
check('patch inserts exactly one row', patch.rows.length === 1, 'parsed with ' + patch.parser)
check('patch row name matches the package', insertedRow?.name === manifest.name, String(insertedRow?.name))
check('patch row id', insertedRow?.id === 'balance-whale', String(insertedRow?.id))

// This repository ships no third-party artwork (see CHANGELOG), so a clean
// checkout has an empty `assets/`. The checks below still need a real skin
// directory to exercise discovery and image serving, so when the disk has no
// skin at all a throwaway fixture is written and removed again on exit.
const SMOKE_SKIN_ID = '__smoke__'
const smokeSkinDir = join(assetsDir, SMOKE_SKIN_ID)

async function seedSmokeSkin() {
  if (!existsSync(assetsDir)) return false
  await mkdir(smokeSkinDir, { recursive: true })
  // The host only serves declared frames and checks the bytes, not the pixels,
  // so a signature plus filler is enough to stand in for a 256px frame.
  const fakePng = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    randomBytes(12_000),
  ])
  await writeFile(join(smokeSkinDir, 'idle.png'), fakePng)
  await writeFile(
    join(smokeSkinDir, 'skin.json'),
    JSON.stringify({ name: 'smoke fixture', accent: '#4D6BFE', order: 5, frames: { idle: 'idle.png' } }, null, 2) + '\n',
  )
  process.on('exit', () => {
    try {
      rmSync(smokeSkinDir, { recursive: true, force: true })
    } catch {
      /* best effort: a leftover fixture is ignored by .gitignore */
    }
  })
  return true
}

if ((await readLocalSkins()).length === 0 && await seedSmokeSkin()) {
  console.log('note: assets/ holds no artwork, seeded a temporary ' + SMOKE_SKIN_ID + ' fixture')
}

const localSkins = await readLocalSkins()
check('skin manifests are on disk', localSkins.length > 0, JSON.stringify(localSkins.map((skin) => skin.id)))
// ---------------------------------------------------------------------------

section('host half: routes and money math')
const host = await import(pathToFileURL(join(packageDir, 'index.js')).href)
check('host name', host.name === 'balance-whale', host.name)
check('host injects webServer', Array.isArray(host.inject) && host.inject.includes('webServer'))
check('host exports apply', typeof host.apply === 'function')
check('host exports its ledger math', typeof host.ledgerInternals?.applySample === 'function')

/** Mount the host half against a mock account service, capturing its listeners. */
function mountHost(account) {
  const routes = []
  const handlers = new Map()
  const ctx = {
    get: (key) => (key === 'deepseekAccount' ? account : undefined),
    effect: (callback) => {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    on: (name, listener) => {
      handlers.set(name, listener)
      return () => handlers.delete(name)
    },
    webServer: { register: (route) => { routes.push(route); return () => {} } },
  }
  host.apply(ctx, { size: 120, refreshSeconds: 45 })
  const routeOf = (path) => routes.find((route) => route.path === path)
  return { routes, handlers, routeOf }
}

/** Drive one route handler to completion. */
async function callRoute(route, request) {
  const res = fakeResponse()
  route.handler(request, res)
  await waitFor(() => res.status !== undefined, 'route ' + route.path)
  return res
}

const signedOut = mountHost({
  getState: async () => ({ status: 'signed-out', links: { usageUrl: 'https://usage', topUpUrl: 'https://topup' } }),
  getBalance: async () => null,
})
check('three routes registered', signedOut.routes.length === 3, String(signedOut.routes.length))
check('state route is exact', signedOut.routeOf('/api/balance-whale/state')?.kind === 'exact')
check('skins route is exact', signedOut.routeOf('/api/balance-whale/skins')?.kind === 'exact')
check('asset route is a prefix', signedOut.routeOf('/api/balance-whale/assets')?.kind === 'prefix')
check('work-state listeners subscribed', signedOut.handlers.has('api-session/status')
  && signedOut.handlers.has('tools/execute') && signedOut.handlers.has('agent/error'))

const stateRoute = signedOut.routeOf('/api/balance-whale/state')
check('non-GET is refused', (await callRoute(stateRoute, fakeRequest({ method: 'POST' }))).status === 405)
check('non-loopback is refused', (await callRoute(stateRoute, fakeRequest({ address: '10.0.0.7' }))).status === 403)

const outResponse = await callRoute(stateRoute, fakeRequest())
check('signed-out body', outResponse.body?.signedIn === false && outResponse.body?.ok === true)
check('signed-out ships the account links', outResponse.body?.links?.topUpUrl === 'https://topup')
check('config is echoed', outResponse.body?.size === 120 && outResponse.body?.refreshSeconds === 45)
check('signed-out carries a ledger summary', outResponse.body?.ledger?.today?.spent === 0)
check('signed-out carries the work state', outResponse.body?.activity?.phase === 'idle')

// Ledger math, exercised directly.
const ledger = host.ledgerInternals.emptyLedger()
const first = host.ledgerInternals.applySample(ledger, { at: 1000, total: 10, currency: 'CNY' })
check('first sample only seeds the baseline',
  first.kind === 'first' && Object.keys(ledger.days).length === 0, JSON.stringify(ledger.days))
const spend = host.ledgerInternals.applySample(ledger, { at: 2000, total: 9.75, currency: 'CNY', tool: 'read' })
check('a decrease is spending', spend.kind === 'spend' && spend.delta === -0.25)
check('spending lands on the day bucket', ledger.days['1970-01-01'].spent === 0.25)
check('spending lands in the turn bucket', ledger.turn.bucket === 0.25)
check('spending is remembered as a recent change',
  ledger.recent[0]?.kind === 'spend' && ledger.recent[0]?.tool === 'read')
const topUp = host.ledgerInternals.applySample(ledger, { at: 3000, total: 19.75, currency: 'CNY' })
check('an increase is a top-up, not spending', topUp.kind === 'top-up' && ledger.days['1970-01-01'].spent === 0.25)
const repeat = host.ledgerInternals.applySample(ledger, { at: 4000, total: 19.75, currency: 'CNY' })
check('an unchanged balance changes nothing', repeat.changed === false)
// A finished turn claims the pending window.
ledger.turn.pendingUntil = 9000
ledger.turn.pendingDelta = ledger.turn.bucket
ledger.turn.bucket = 0
host.ledgerInternals.applySample(ledger, { at: 5000, total: 19.5, currency: 'CNY' })
check('a late-billed sample is attributed to the finished turn', ledger.turn.lastDelta === 0.5,
  String(ledger.turn.lastDelta))
const other = host.ledgerInternals.applySample(ledger, { at: 12_000, total: 19.25, currency: 'CNY' })
check('a sample after the window starts the next bucket', other.kind === 'spend' && ledger.turn.bucket === 0.25)
const summary = host.ledgerInternals.summarize(ledger, 20_000, 500)
check('summary charts seven days', summary.days.length === 7)
check('summary reports the session window', summary.sinceStart.startedAt === 500)
check('summary keeps a currency', summary.currency === 'CNY')

// The ready path plus the cache and the forced refresh.
const ready = mountHost({
  getState: async () => ({ status: 'credential-stored', links: { usageUrl: 'https://usage', topUpUrl: '' } }),
  getBalance: async () => ({
    status: 'ready',
    value: [{ currency: 'CNY', balance: '12.3' }],
    bonusWallets: [{ currency: 'CNY', balance: '1.2' }],
  }),
})
const readyRoute = ready.routeOf('/api/balance-whale/state')
const readyResponse = await callRoute(readyRoute, fakeRequest())
check('ready body is signed in', readyResponse.body?.signedIn === true)
check('wallets normalized', readyResponse.body?.wallets?.[0]?.balance === '12.3')
check('totals summed per currency', readyResponse.body?.totals?.[0]?.total === '13.50',
  JSON.stringify(readyResponse.body?.totals))
check('recharge subtotal', readyResponse.body?.totals?.[0]?.recharge === '12.30')
check('bonus subtotal', readyResponse.body?.totals?.[0]?.bonus === '1.20')
check('a first sample seeds the ledger without spending',
  readyResponse.body?.ledger?.today?.spent === 0 && readyResponse.body?.ledger?.recent?.length === 0)

const cachedResponse = await callRoute(readyRoute, fakeRequest())
check('short cache reused', cachedResponse.body?.updatedAt === readyResponse.body?.updatedAt)

// Work state through the real event listeners.
ready.handlers.get('api-session/status')('session-1', true)
ready.handlers.get('tools/execute')({ name: 'grep' }, () => Promise.resolve('next-called'))
let working = await callRoute(readyRoute, fakeRequest({ url: '/api/balance-whale/state?refresh=1' }))
check('a running session is the working phase', working.body?.activity?.phase === 'working')
check('the dispatched tool is reported', working.body?.activity?.tool === 'grep')
ready.handlers.get('api-session/status')('session-1', false)
working = await callRoute(readyRoute, fakeRequest({ url: '/api/balance-whale/state?refresh=1' }))
check('stopping the session returns to idle', working.body?.activity?.phase === 'idle')
check('the finished turn is counted', working.body?.ledger?.lastTurn?.count === 1)
ready.handlers.get('agent/error')({ error: new Error('boom') })
working = await callRoute(readyRoute, fakeRequest({ url: '/api/balance-whale/state?refresh=1' }))
check('an agent error becomes the error phase', working.body?.activity?.phase === 'error'
  && working.body?.activity?.error === 'boom')

// Spending recorded across two reads of one mounted host.
let balance = '10'
const spending = mountHost({
  getState: async () => ({ status: 'credential-stored', links: {} }),
  getBalance: async () => ({ status: 'ready', value: [{ currency: 'CNY', balance }], bonusWallets: [] }),
})
const spendRoute = spending.routeOf('/api/balance-whale/state')
const baseline = await callRoute(spendRoute, fakeRequest())
check('the first read only seeds the ledger', baseline.body?.ledger?.today?.spent === 0)
balance = '9.5'
const afterSpend = await callRoute(spendRoute, fakeRequest({ url: '/api/balance-whale/state?refresh=1' }))
check('a fresh read records the spending', afterSpend.body?.ledger?.today?.spent === 0.5,
  JSON.stringify(afterSpend.body?.ledger?.today))
check('the spending is listed as a recent change',
  afterSpend.body?.ledger?.recent?.[0]?.delta === -0.5 && afterSpend.body?.ledger?.recent?.[0]?.kind === 'spend',
  JSON.stringify(afterSpend.body?.ledger?.recent?.[0]))
check('the spending is attributed to the running session', afterSpend.body?.ledger?.sinceStart?.spent === 0.5,
  JSON.stringify(afterSpend.body?.ledger?.sinceStart))

const failed = mountHost({
  getState: async () => ({ status: 'credential-stored', links: {} }),
  getBalance: async () => ({ status: 'failed' }),
})
const failedResponse = await callRoute(failed.routeOf('/api/balance-whale/state'), fakeRequest())
check('failed query reported', failedResponse.body?.error === 'balance-query-failed')

const unavailable = mountHost(undefined)
const unavailableResponse = await callRoute(unavailable.routeOf('/api/balance-whale/state'), fakeRequest())
check('missing account service reported',
  unavailableResponse.body?.ok === false && unavailableResponse.body?.error === 'account-service-unavailable')

// Skins + assets. The registry scan is asynchronous, so the route is re-asked
// until the discovered skins appear.
const skinsRoute = ready.routeOf('/api/balance-whale/skins')
let skinsResponse = await callRoute(skinsRoute, fakeRequest())
for (let attempt = 0; attempt < 100 && (skinsResponse.body?.skins ?? []).length <= 1; attempt += 1) {
  await new Promise((tick) => setTimeout(tick, 5))
  skinsResponse = await callRoute(skinsRoute, fakeRequest())
}
const skinIds = (skinsResponse.body?.skins ?? []).map((skin) => skin.id)
check('every skin on disk is discovered',
  localSkins.every((skin) => skinIds.includes(skin.id)),
  'disk: ' + localSkins.map((skin) => skin.id).join(',') + ' | served: ' + skinIds.join(','))
check('the registry is exactly the disk set plus the built-in skin',
  skinIds.length === localSkins.length + 1, skinIds.join(','))
check('the hand-drawn skin is offered last', skinIds[skinIds.length - 1] === 'whale-classic', skinIds.join(','))
check('the default skin is the first user skin',
  skinsResponse.body?.defaultSkin === localSkins[0]?.id,
  String(skinsResponse.body?.defaultSkin) + ' vs ' + String(localSkins[0]?.id))
const firstSkinId = localSkins[0].id
const firstFrameFile = localSkins[0].frames.idle ?? Object.values(localSkins[0].frames)[0]
check('frame URLs are same-origin asset paths',
  skinsResponse.body?.skins?.[0]?.frames?.idle
    === '/api/balance-whale/assets/' + firstSkinId + '/' + firstFrameFile,
  String(skinsResponse.body?.skins?.[0]?.frames?.idle))

const assetRoute = ready.routeOf('/api/balance-whale/assets')
const frame = await callRoute(assetRoute, fakeRequest({
  url: '/api/balance-whale/assets/' + firstSkinId + '/' + firstFrameFile,
}))
check('a declared frame is served', frame.status === 200 && frame.headers?.['content-type'] === 'image/png')
check('the frame carries real bytes', (frame.bytes?.byteLength ?? 0) > 10_000, String(frame.bytes?.byteLength))
check('the frame is cacheable', String(frame.headers?.['cache-control'] ?? '').includes('max-age'))
const undeclared = await callRoute(assetRoute, fakeRequest({
  url: '/api/balance-whale/assets/' + firstSkinId + '/skin.json',
}))
check('an undeclared file is refused', undeclared.status === 404)
const traversal = await callRoute(assetRoute, fakeRequest({
  url: '/api/balance-whale/assets/..%2F..%2Fpackage.json/../../../package.json',
}))
check('a traversal attempt is refused', traversal.status === 404)

// ---------------------------------------------------------------------------

section('client half: mount, expressions, ledger, skins, gestures')
let loaded = null
let installedCss = ''
let fetchCalls = []
const mailStore = new Map()
/** Virtual timers: the widget's `later()` and poll intervals live here. */
const clock = { now: 0, nextId: 1, timers: new Map() }

globalThis.window = {
  __ModuleLoader__: { load: (definition) => { loaded = definition } },
  innerWidth: 1440,
  innerHeight: 900,
  localStorage: {
    getItem: (key) => (mailStore.has(key) ? mailStore.get(key) : null),
    setItem: (key, value) => mailStore.set(key, String(value)),
  },
  setTimeout: (fn, delay = 0) => {
    const id = clock.nextId
    clock.nextId += 1
    clock.timers.set(id, { at: clock.now + Number(delay), fn })
    return id
  },
  clearTimeout: (id) => clock.timers.delete(id),
  setInterval: () => 0,
  clearInterval: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
}
globalThis.Element = class Element {}
globalThis.document = {
  head: {
    appendChild: (tag) => {
      if (typeof tag.textContent === 'string' && tag.textContent !== '') installedCss += tag.textContent
    },
  },
  addEventListener: () => {},
  removeEventListener: () => {},
  visibilityState: 'visible',
  createElement: () => ({ dataset: {}, textContent: '', remove: () => {} }),
}

let stateOverride = null
globalThis.fetch = async (url) => {
  const target = String(url)
  fetchCalls.push(target)
  const body = target.startsWith('/api/balance-whale/skins')
    ? skinsBody()
    : stateOverride ?? stateBody()
  return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) }
}

await import(pathToFileURL(join(packageDir, 'client.js')).href)
check('bundle registers a factory', loaded !== null && typeof loaded.factory === 'function')
check('bundle id is the package name', loaded?.id === manifest.name, String(loaded?.id))

const mini = createMiniReact(clock)
const clientModule = loaded.factory((specifier) => {
  if (specifier === 'react') return mini.React
  throw new Error('unexpected require: ' + specifier)
})
check('client injects slots', Array.isArray(clientModule.inject) && clientModule.inject.includes('slots'))
check('client exports apply', typeof clientModule.apply === 'function')

const registrations = []
const injectedKeys = []
clientModule.apply({
  effect: (callback) => {
    const dispose = callback()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  slots: {
    inject: (key, callback) => {
      injectedKeys.push(key)
      return callback()
    },
    register: (options, component) => {
      registrations.push({ options, component })
      return () => {}
    },
  },
})
check('slot dependency is shell.overlay', injectedKeys[0] === 'shell.overlay', String(injectedKeys[0]))
check('exactly one slot registration', registrations.length === 1)
check('registration targets shell.overlay', registrations[0]?.options?.name === 'shell.overlay')
check('registration id', registrations[0]?.options?.id === 'balance-whale')
check('style sheet installed once', installedCss.includes('.bw-root{') && installedCss.includes('@keyframes bw-boing'))
check('styles use theme tokens', installedCss.includes('var(--dsw-alias-bg-overlay)')
  && installedCss.includes('var(--dsw-alias-brand-primary)'))
check('styles honour reduced motion', installedCss.includes('prefers-reduced-motion'))
check('styles cover the mood props', installedCss.includes('.bw-prop-heart') && installedCss.includes('.bw-prop-z'))

const Widget = registrations[0].component
let tree = await mini.mount(mini.React.createElement(Widget, {}))
await waitFor(() => fetchCalls.some((url) => url.startsWith('/api/balance-whale/state')), 'first state fetch')
tree = await mini.update()
tree = await mini.update()

const pointer = { setPointerCapture: () => {}, releasePointerCapture: () => {} }

/** Simulate one pointer press/release pair; a still pointer is a tap. */
async function press({ from, to, id = 31, type = 'mouse' }) {
  const node = rootNode(mini.tree)
  node.props.onPointerDown({
    button: 0, pointerId: id, pointerType: type, clientX: from[0], clientY: from[1], target: null, currentTarget: pointer,
  })
  if (to !== undefined) node.props.onPointerMove({ pointerId: id, clientX: to[0], clientY: to[1] })
  await mini.update()
  const dragged = rootNode(mini.tree)
  dragged.props.onPointerUp({
    pointerId: id, pointerType: type, clientX: (to ?? from)[0], clientY: (to ?? from)[1], currentTarget: pointer,
  })
  return mini.update()
}

/** Force one fresh read from the mocked host, then settle the renders. */
async function refreshNow() {
  await press({ from: [600, 700], id: 41 })
  return mini.update()
}

let root = rootNode(tree)
check('widget mounts', root !== null)
check('state and skins were fetched',
  fetchCalls.some((url) => url.startsWith('/api/balance-whale/state'))
  && fetchCalls.some((url) => url.startsWith('/api/balance-whale/skins')),
  fetchCalls.join(' '))
check('the whale shows the balance', odometerValues(tree).includes('11.83'), JSON.stringify(odometerValues(tree)))
check('the whale face is the selected skin frame',
  findNode(tree, (node) => node.type === 'img' && String(node.props.src).includes('maid-blue')) !== null)
check('the settled mood is idle', root.props['data-mood'] === 'idle', String(root.props['data-mood']))
check('the accessible label carries the balance',
  String(root.props['aria-label']).includes('11.83'), String(root.props['aria-label']))

// Hover opens the ledger card.
root.props.onPointerEnter()
tree = await mini.update()
root = rootNode(tree)
check('hovering opens the detail card', findNode(tree, (node) => hasClass(node, 'bw-card')) !== null)
const cardText = textOf(tree)
check('the card is titled', cardText.includes('小鲸鱼余额'))
check('the card shows the ledger heading', cardText.includes('记账'))
check('the card reports today\'s spend', cardText.includes('今日已用') && odometerValues(tree).includes('0.42'),
  JSON.stringify(odometerValues(tree)))
check('the card reports the last turn', cardText.includes('上一轮') && odometerValues(tree).includes('0.12'))
check('the card reports this run', cardText.includes('本次启动') && odometerValues(tree).includes('0.30'))
check('the card charts seven days', findAll(tree, (node) => hasClass(node, 'bw-bar')).length === 7,
  String(findAll(tree, (node) => hasClass(node, 'bw-bar')).length))
check('the card lists recent changes', cardText.includes('读文件') && cardText.includes('搜代码'))
check('the card reports the work state', cardText.includes('状态') && cardText.includes('空闲'))
check('the card links to the platform',
  findAll(tree, (node) => node.type === 'a').some((node) => node.props.href === 'https://platform.deepseek.com/top_up'))
check('the hero number is the odometer total', odometerValues(tree).filter((value) => value === '11.83').length >= 2)

// Skin picker.
const skinButton = findAll(tree, (node) => node.type === 'button' && textOf(node).includes('皮肤'))[0]
check('the skin button is present', skinButton !== undefined)
skinButton.props.onClick()
tree = await mini.update()
const skinButtons = findAll(tree, (node) => hasClass(node, 'bw-skin'))
check('the picker lists every skin', skinButtons.length === 3, String(skinButtons.length))
skinButtons[1].props.onClick()
tree = await mini.update()
check('picking a skin swaps the artwork',
  findNode(tree, (node) => node.type === 'img' && String(node.props.src).includes('elf-violet')) !== null)
check('picking a skin is remembered', mailStore.get('dsh-balance-whale.skin.v1') === 'elf-violet',
  String(mailStore.get('dsh-balance-whale.skin.v1')))
check('a skin change is announced', bubbleText(tree).includes('紫罗兰精灵'), bubbleText(tree))
// Let the announcement expire so the next event owns the bubble.
tree = await mini.advance(4000)

// Drag to the left: snap, flip, persist.
tree = await press({ from: [900, 700], to: [100, 640], id: 7 })
root = rootNode(tree)
check('releasing snaps to the left edge', root.props['data-edge'] === 'left', String(root.props['data-edge']))
check('the left-docked whale is flipped',
  String(findNode(tree, (node) => hasClass(node, 'bw-flip'))?.props.style?.transform) === 'scaleX(-1)',
  String(findNode(tree, (node) => hasClass(node, 'bw-flip'))?.props.style?.transform))
check('the layout is persisted', JSON.parse(mailStore.get('dsh-balance-whale.position.v1')).edge === 'left',
  String(mailStore.get('dsh-balance-whale.position.v1')))

// Dragging is its own mood, and the whale tilts with the pointer.
{
  const node = rootNode(mini.tree)
  node.props.onPointerDown({
    button: 0, pointerId: 8, pointerType: 'mouse', clientX: 900, clientY: 700, target: null, currentTarget: pointer,
  })
  node.props.onPointerMove({ pointerId: 8, clientX: 100, clientY: 640 })
  tree = await mini.update()
  const dragging = rootNode(tree)
  check('dragging is the excited mood', dragging.props['data-mood'] === 'excited', String(dragging.props['data-mood']))
  const springTransform = String(findNode(tree, (item) => hasClass(item, 'bw-spring'))?.props.style?.transform ?? '')
  check('dragging tilts the whale', springTransform.includes('rotate'), springTransform)
  dragging.props.onPointerUp({
    pointerId: 8, pointerType: 'mouse', clientX: 100, clientY: 640, currentTarget: pointer,
  })
  tree = await mini.update()
}

// A tap forces a refresh.
const refreshesBefore = fetchCalls.filter((url) => url.includes('refresh=1')).length
tree = await press({ from: [500, 700], id: 9 })
check('a tap asks the host for a fresh read',
  fetchCalls.filter((url) => url.includes('refresh=1')).length === refreshesBefore + 1, fetchCalls.join(' '))

// Work state and money transitions drive bubbles, moods and sounds.
stateOverride = stateBody({
  totals: [{ currency: 'CNY', recharge: '7.12', bonus: '4.71', total: '20.00' }],
  wallets: [{ currency: 'CNY', balance: '15.29' }],
})
tree = await refreshNow()
check('a balance increase makes the whale happy', rootNode(tree).props['data-mood'] === 'happy',
  String(rootNode(tree).props['data-mood']))
check('a balance increase is announced', bubbleText(tree).includes('谢谢老板'), bubbleText(tree))
check('the bubble carries a happy tone',
  findNode(tree, (node) => hasClass(node, 'bw-bubble'))?.props['data-tone'] === 'happy',
  String(findNode(tree, (node) => hasClass(node, 'bw-bubble'))?.props['data-tone']))

stateOverride = stateBody({ activity: { phase: 'working', tool: 'read', toolAt: 1, since: 1, running: 1, error: null } })
tree = await mini.advance(4000)
tree = await refreshNow()
check('a working host makes the whale work', rootNode(tree).props['data-mood'] === 'working',
  String(rootNode(tree).props['data-mood']))
check('the working mood draws its prop', markupOf(tree).includes('bw-prop-gear'))
check('the working mood announces the tool', bubbleText(tree).includes('读文件'), bubbleText(tree))

stateOverride = stateBody({ signedIn: false, totals: [], wallets: [], bonusWallets: [] })
tree = await mini.advance(4000)
tree = await refreshNow()
check('a signed-out host puts the whale to sleep', rootNode(tree).props['data-mood'] === 'sleep',
  String(rootNode(tree).props['data-mood']))
check('a signed-out pill says so', odometerValues(tree).includes('未登录'), JSON.stringify(odometerValues(tree)))
check('a signed-out host explains itself', bubbleText(tree).includes('登录'), bubbleText(tree))

// The sound toggle is persisted.
stateOverride = null
tree = await refreshNow()
const soundButton = findAll(tree, (node) => node.type === 'button' && textOf(node).includes('音效'))[0]
check('the sound button is present', soundButton !== undefined)
soundButton.props.onClick()
tree = await mini.update()
check('turning sound off is remembered', mailStore.get('dsh-balance-whale.sound.v1') === '0',
  String(mailStore.get('dsh-balance-whale.sound.v1')))

// ---------------------------------------------------------------------------

section('result')
console.log('  ' + (checks - failures) + '/' + checks + ' checks passed')
if (failures > 0) process.exitCode = 1
