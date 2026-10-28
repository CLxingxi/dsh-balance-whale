/**
 * dsh-balance-whale — Host half.
 *
 * The whale lives in the browser, but three things can only happen here:
 *
 * 1. **Balance.** `ctx.deepseekAccount` is a Host-only service; its
 *    `getBalance` is the one call that returns recharge and bonus wallets.
 * 2. **Work state.** Whether the model is running, and which tool it is in,
 *    arrives as Host events (`api-session/status`, `tools/execute`,
 *    `agent/error`); the browser half only polls the summarized state.
 * 3. **The ledger.** Every fresh balance read is compared with the previous
 *    one, so account spending is attributed to a day, to the turn that just
 *    finished, and to the running session — and persisted across restarts.
 *
 * Browser-facing routes (same-origin, loopback only):
 *
 *   GET /api/balance-whale/state[?refresh=1]   balance + ledger + work state
 *   GET /api/balance-whale/skins               the discovered skin registry
 *   GET /api/balance-whale/assets/<skin>/<f>   one skin frame (PNG)
 *
 * The package imports nothing outside Node builtins: it resolves from the
 * profile's node_modules, where a linked workspace directory has no
 * dependencies of its own.
 *
 * @module dsh-balance-whale
 */

import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Cordis plugin name; matches the row id in cordis.patch.yml. */
export const name = 'balance-whale'

/** The web carrier that serves this half's routes. */
export const inject = ['webServer']

/** Browser-facing base path of the widget's API. */
export const BALANCE_WHALE_API_PREFIX = '/api/balance-whale'

/** How long one balance read is reused, in milliseconds. */
const CACHE_MS = 10_000

/** Largest skin frame the asset route will serve, in bytes. */
const ASSET_CAP = 2 * 1024 * 1024

/** Format version of the persisted ledger. */
const LEDGER_VERSION = 1

/** Ledger entries kept in the file (recent changes, newest first). */
const RECENT_LIMIT = 20

/** Days of history the ledger keeps on disk. */
const HISTORY_DAYS = 60

/** Days the widget charts. */
const CHART_DAYS = 7

/** How long a finished turn keeps absorbing late-billed samples. */
const TURN_ATTRIBUTION_MS = 60_000

/** How long an error keeps the whale worried. */
const ERROR_WINDOW_MS = 30_000

/** Plugin identity reported to the Platform as the requesting UI. */
const CLIENT_VERSION = 'dsh-balance-whale/1.0.0'

/** The hand-drawn skin that ships inside the client bundle (no asset files). */
const BUILTIN_SKIN = {
  id: 'whale-classic',
  name: '深海经典鲸',
  accent: '#4D6BFE',
  plate: null,
  builtin: true,
  order: 90,
  frames: {},
}

/**
 * @typedef {object} BalanceWhaleConfig
 * @property {number} [size] - Whale box size in px, 64..160.
 * @property {number} [refreshSeconds] - Browser poll interval, 10..600.
 * @property {string} [skin] - Initial skin id; the browser remembers its own choice.
 * @property {boolean} [sound] - Initial sound preference.
 */

/**
 * @typedef {object} LedgerSample
 * @property {number} at - Read time (epoch ms).
 * @property {number} total - Total balance in the sample's currency.
 * @property {string} currency - Currency of that total.
 */

/**
 * @typedef {object} Ledger
 * @property {number} version - Format version.
 * @property {LedgerSample | null} last - The previous fresh read.
 * @property {Record<string, { spent: number, topUp: number, turns: number }>} days - Per-day totals.
 * @property {{ at: number, kind: string, delta: number, total: number, tool: string | null }[]} recent - Newest first.
 * @property {{ count: number, lastDelta: number, lastAt: number, pendingDelta: number, pendingUntil: number, bucket: number }} turn - Turn attribution.
 * @property {number} spentSince - Spending accumulated in the running process.
 */

/**
 * Pure ledger helpers, exported so the smoke test can exercise the money math
 * without a Host, a browser, or the Platform.
 */
export const ledgerInternals = {
  applySample,
  dayKey,
  emptyLedger,
  pruneDays,
  summarize,
}

/**
 * Register the widget's routes and its work-state listeners.
 *
 * @param {object} ctx - Host plugin context (service: `webServer`).
 * @param {BalanceWhaleConfig} [config] - The row's config block.
 */
export function apply(ctx, config = {}) {
  const size = clampNumber(config.size, 64, 160, 96)
  const refreshSeconds = clampNumber(config.refreshSeconds, 10, 600, 30)
  const startedAt = Date.now()

  /** @type {{ at: number, value: unknown }} */
  const balanceCache = { at: 0, value: undefined }
  /** @type {Ledger} */
  let ledger = emptyLedger()
  /** @type {Promise<void> | null} */
  let loading = null
  let writeTimer = null
  let dirty = false

  const runtime = {
    /** Sessions currently running; the count drives the working mood. */
    running: new Set(),
    /** Last tool name seen, and when. */
    tool: null,
    toolAt: 0,
    /** Last agent error, and when. */
    error: null,
    errorAt: 0,
    /** Skin registry, scanned once per activation. */
    skins: [BUILTIN_SKIN],
  }

  const pluginRoot = dirname(fileURLToPath(import.meta.url))

  /** Persist the ledger soon, coalescing bursts of samples. */
  const touchLedger = () => {
    dirty = true
    if (writeTimer !== null) return
    writeTimer = setTimeout(() => {
      writeTimer = null
      if (!dirty) return
      dirty = false
      saveLedger(ledger).catch(() => {})
    }, 1200)
    // Never hold the process open for a ledger write.
    if (typeof writeTimer === 'object' && writeTimer !== null && 'unref' in writeTimer) writeTimer.unref()
  }

  const deps = {
    ctx,
    size,
    refreshSeconds,
    startedAt,
    balanceCache,
    runtime,
    pluginRoot,
    get ledger() {
      return ledger
    },
    setLedger(next) {
      ledger = next
      touchLedger()
    },
    touchLedger,
  }

  ctx.effect(() => {
    const disposers = [
      ctx.on('api-session/status', (sessionId, running) => noteSessionStatus(deps, sessionId, running)),
      ctx.on('agent/error', (payload) => noteAgentError(deps, payload)),
      ctx.on('tools/result', (exec) => noteToolResult(deps, exec)),
      ctx.on('deepseek-account/signed-out', () => noteSignedOut(deps)),
      // A pass-through waterfall listener: it never owns the decision, it only
      // watches which tool is dispatched so the whale can say what it is doing.
      ctx.on('tools/execute', (exec, next) => {
        noteToolDispatch(deps, exec)
        return next()
      }),
    ]
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'balance-whale: work-state listeners')

  ctx.effect(() => {
    loading = loadLedger().then(
      (restored) => {
        ledger = restored
      },
      () => {
        ledger = emptyLedger()
      },
    )
    return () => {
      if (writeTimer !== null) clearTimeout(writeTimer)
      // The final write is fire-and-forget: unload must not block on the disk.
      saveLedger(ledger).catch(() => {})
    }
  }, 'balance-whale: ledger')

  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: BALANCE_WHALE_API_PREFIX + '/state',
      handler: (req, res) => {
        // Wait for a restore that is still in flight, then answer.
        const ready = loading ?? Promise.resolve()
        ready.then(() => handleState(deps, req, res), () => handleState(deps, req, res))
      },
    })
    const disposeSkins = ctx.webServer.register({
      kind: 'exact',
      path: BALANCE_WHALE_API_PREFIX + '/skins',
      handler: (req, res) => handleSkins(deps, req, res),
    })
    const disposeAssets = ctx.webServer.register({
      kind: 'prefix',
      path: BALANCE_WHALE_API_PREFIX + '/assets',
      handler: (req, res) => handleAsset(deps, req, res),
    })
    return () => {
      dispose()
      disposeSkins()
      disposeAssets()
    }
  }, 'balance-whale: routes')

  // The registry is discovered asynchronously; requests before it settles fall
  // back to the built-in skin, and the browser polls again.
  readSkins(pluginRoot).then(
    (skins) => {
      runtime.skins = skins
    },
    () => {},
  )
}

// ---------------------------------------------------------------------------
// HTTP

/**
 * Answer one `/state` request: method and origin fence, then a cached or fresh
 * balance read enriched with the work state and the ledger summary.
 *
 * @param {object} deps - Per-activation state (see `apply`).
 * @param {import('node:http').IncomingMessage} req - The request.
 * @param {import('node:http').ServerResponse} res - The response.
 */
function handleState(deps, req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
    return
  }
  if (!isLoopback(req)) {
    writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
    return
  }
  const force = readFlag(req, 'refresh')
  const cached = deps.balanceCache.value
  const fresh = cached !== undefined && !force && Date.now() - deps.balanceCache.at < CACHE_MS
  if (fresh) {
    writeJson(res, 200, cached)
    return
  }
  readBalance(deps).then(
    (value) => {
      deps.balanceCache.at = Date.now()
      deps.balanceCache.value = value
      writeJson(res, 200, value)
    },
    (error) => {
      writeJson(res, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    },
  )
}

/**
 * Answer `/skins` with the discovered registry. Frame paths are absolute
 * same-origin URLs the browser can put straight into an `<img>`.
 *
 * @param {object} deps - Per-activation state.
 * @param {import('node:http').IncomingMessage} req - The request.
 * @param {import('node:http').ServerResponse} res - The response.
 */
function handleSkins(deps, req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
    return
  }
  if (!isLoopback(req)) {
    writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
    return
  }
  writeJson(res, 200, {
    ok: true,
    skins: deps.runtime.skins.map((skin) => ({
      id: skin.id,
      name: skin.name,
      accent: skin.accent,
      plate: skin.plate,
      builtin: skin.builtin === true,
      frames: Object.fromEntries(Object.entries(skin.frames).map(([mood, file]) => [
        mood,
        BALANCE_WHALE_API_PREFIX + '/assets/' + encodeURIComponent(skin.id) + '/' + encodeURIComponent(file),
      ])),
    })),
    defaultSkin: deps.runtime.skins[0]?.id ?? null,
  })
}

/**
 * Serve one skin frame. Only files the registry itself declared are served, so
 * a request can never name a path outside the package's assets.
 *
 * @param {object} deps - Per-activation state.
 * @param {import('node:http').IncomingMessage} req - The request.
 * @param {import('node:http').ServerResponse} res - The response.
 */
function handleAsset(deps, req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
    return
  }
  if (!isLoopback(req)) {
    writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
    return
  }
  const path = (req.url ?? '').split('?')[0]
  const rest = path.slice((BALANCE_WHALE_API_PREFIX + '/assets/').length)
  const parts = rest.split('/').map(decodeURIComponent)
  if (parts.length !== 2) {
    writeJson(res, 404, { ok: false, error: 'not-found' })
    return
  }
  const [skinId, file] = parts
  const skin = deps.runtime.skins.find((candidate) => candidate.id === skinId)
  const declared = skin !== undefined && Object.values(skin.frames).includes(file)
  if (!declared) {
    writeJson(res, 404, { ok: false, error: 'not-found' })
    return
  }
  const target = join(deps.pluginRoot, 'assets', skinId, file)
  readFile(target).then(
    (bytes) => {
      if (bytes.byteLength > ASSET_CAP) {
        writeJson(res, 413, { ok: false, error: 'asset-too-large' })
        return
      }
      res.writeHead(200, {
        'content-type': contentType(file),
        'content-length': String(bytes.byteLength),
        'cache-control': 'public, max-age=300',
        'referrer-policy': 'no-referrer',
      })
      res.end(req.method === 'HEAD' ? undefined : bytes)
    },
    () => writeJson(res, 404, { ok: false, error: 'not-found' }),
  )
}

// ---------------------------------------------------------------------------
// Work state

/**
 * Track running sessions and close the turn when the last one stops.
 *
 * @param {object} deps - Per-activation state.
 * @param {unknown} sessionId - The session that changed.
 * @param {unknown} running - Whether it is running.
 */
function noteSessionStatus(deps, sessionId, running) {
  const key = String(sessionId)
  const wasRunning = deps.runtime.running.has(key)
  if (running === true) {
    if (!wasRunning) deps.runtime.running.add(key)
    return
  }
  if (!wasRunning) return
  deps.runtime.running.delete(key)
  if (deps.runtime.running.size > 0) return
  // The last running session stopped: the turn is over and the balance will
  // settle shortly, so the next minute of decreases are attributed to it.
  const ledger = deps.ledger
  const now = Date.now()
  ledger.turn.count += 1
  ledger.turn.pendingDelta = round4(ledger.turn.bucket)
  ledger.turn.lastDelta = ledger.turn.pendingDelta
  ledger.turn.lastAt = now
  ledger.turn.pendingUntil = now + TURN_ATTRIBUTION_MS
  ledger.turn.bucket = 0
  const day = ensureDay(ledger, dayKey(now))
  day.turns += 1
  deps.touchLedger()
}

/**
 * Remember an agent error so the whale can look worried for a while.
 *
 * @param {object} deps - Per-activation state.
 * @param {{ error?: unknown } | undefined} payload - The event payload.
 */
function noteAgentError(deps, payload) {
  const error = payload?.error
  deps.runtime.error = error instanceof Error ? error.message : String(error ?? 'error')
  deps.runtime.errorAt = Date.now()
}

/** A sign-out clears the balance picture until the user signs in again. */
function noteSignedOut(deps) {
  deps.runtime.error = 'signed-out'
  deps.runtime.errorAt = Date.now()
}

/**
 * Record the tool a dispatch is about to run. The shape is read defensively:
 * this listener observes, it never decides.
 *
 * @param {object} deps - Per-activation state.
 * @param {unknown} exec - The dispatch input.
 */
function noteToolDispatch(deps, exec) {
  const record = /** @type {Record<string, unknown> | undefined} */ (exec)
  const name = firstString(record?.name, record?.tool, record?.toolName)
  if (name === undefined) return
  deps.runtime.tool = name
  deps.runtime.toolAt = Date.now()
}

/**
 * Keep the last completed tool name around for the bubble that follows a turn.
 *
 * @param {object} deps - Per-activation state.
 * @param {unknown} exec - The execution record.
 */
function noteToolResult(deps, exec) {
  const record = /** @type {Record<string, unknown> | undefined} */ (exec)
  const name = firstString(record?.name, record?.tool, record?.toolName)
  if (name !== undefined) deps.runtime.tool = name
}

/**
 * The work state as the browser half sees it.
 *
 * @param {object} deps - Per-activation state.
 * @returns {{ phase: 'working' | 'idle' | 'error', tool: string | null, since: number, running: number, error: string | null }}
 */
function activityOf(deps) {
  const now = Date.now()
  const working = deps.runtime.running.size > 0
  const recentError = deps.runtime.error !== null && now - deps.runtime.errorAt < ERROR_WINDOW_MS
  return {
    phase: working ? 'working' : recentError ? 'error' : 'idle',
    tool: deps.runtime.tool,
    toolAt: deps.runtime.toolAt,
    since: working ? deps.runtime.toolAt || now : now,
    running: deps.runtime.running.size,
    error: recentError ? deps.runtime.error : null,
  }
}

// ---------------------------------------------------------------------------
// Balance + ledger

/**
 * Read the account state and, when signed in, the wallet balances; every fresh
 * read feeds the ledger.
 *
 * @param {object} deps - Per-activation state.
 * @returns {Promise<object>} The JSON body the browser half consumes.
 */
async function readBalance(deps) {
  const account = deps.ctx.get('deepseekAccount')
  if (account === undefined) {
    return envelope(deps, { ok: false, signedIn: false, error: 'account-service-unavailable' })
  }
  const state = await account.getState()
  const signedIn = state?.status === 'credential-stored'
  if (!signedIn) {
    return envelope(deps, { ok: true, signedIn: false, error: null, links: linksOf(state) })
  }
  const result = await account.getBalance({
    version: CLIENT_VERSION,
    locale: 'zh-CN',
    timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
  })
  if (result === null) {
    return envelope(deps, { ok: true, signedIn: false, error: null, links: linksOf(state) })
  }
  if (result.status !== 'ready') {
    return envelope(deps, { ok: true, signedIn: true, error: 'balance-query-failed', links: linksOf(state) })
  }
  const wallets = normalizeWallets(result.value)
  const bonusWallets = normalizeWallets(result.bonusWallets)
  const totals = totalByCurrency(wallets, bonusWallets)
  if (totals.length > 0) recordSample(deps, totals)
  return envelope(deps, {
    ok: true,
    signedIn: true,
    error: null,
    wallets,
    bonusWallets,
    totals,
    links: linksOf(state),
  })
}

/**
 * Feed one fresh read into the ledger and return what changed.
 *
 * @param {object} deps - Per-activation state.
 * @param {{ currency: string, total: string }[]} totals - Per-currency totals.
 */
function recordSample(deps, totals) {
  const primary = totals[0]
  const total = Number(primary.total)
  if (!Number.isFinite(total)) return
  const ledger = deps.ledger
  const outcome = applySample(ledger, {
    at: Date.now(),
    total,
    currency: primary.currency,
    tool: deps.runtime.tool,
  })
  if (outcome.changed) deps.setLedger(ledger)
}

/**
 * The ledger's core money math: compare a fresh total with the previous one
 * and attribute the difference.
 *
 * A decrease is spending: it lands on today's totals, on the running session,
 * and either on the turn that just finished (while its attribution window is
 * open) or on the bucket for the next one. An increase is a top-up and never
 * counts as spending.
 *
 * @param {Ledger} ledger - Ledger to mutate.
 * @param {{ at: number, total: number, currency: string, tool?: string | null }} sample - The fresh read.
 * @returns {{ changed: boolean, delta: number, kind: 'first' | 'same' | 'spend' | 'top-up' }} What happened.
 */
function applySample(ledger, sample) {
  const previous = ledger.last
  ledger.last = { at: sample.at, total: sample.total, currency: sample.currency }
  if (previous === null || previous.currency !== sample.currency) {
    return { changed: true, delta: 0, kind: 'first' }
  }
  const delta = round4(sample.total - previous.total)
  if (delta === 0) return { changed: false, delta: 0, kind: 'same' }
  const day = ensureDay(ledger, dayKey(sample.at))
  if (delta > 0) {
    day.topUp = round4(day.topUp + delta)
    pushRecent(ledger, { at: sample.at, kind: 'top-up', delta, total: sample.total, tool: sample.tool ?? null })
    return { changed: true, delta, kind: 'top-up' }
  }
  const spent = round4(-delta)
  day.spent = round4(day.spent + spent)
  ledger.spentSince = round4(ledger.spentSince + spent)
  if (ledger.turn.pendingUntil > sample.at) {
    ledger.turn.pendingDelta = round4(ledger.turn.pendingDelta + spent)
    ledger.turn.lastDelta = ledger.turn.pendingDelta
    ledger.turn.lastAt = sample.at
  } else {
    ledger.turn.bucket = round4(ledger.turn.bucket + spent)
  }
  pushRecent(ledger, { at: sample.at, kind: 'spend', delta: -spent, total: sample.total, tool: sample.tool ?? null })
  return { changed: true, delta: -spent, kind: 'spend' }
}

/** Push one change onto the recent list, newest first, capped. */
function pushRecent(ledger, entry) {
  ledger.recent.unshift(entry)
  if (ledger.recent.length > RECENT_LIMIT) ledger.recent.length = RECENT_LIMIT
}

/**
 * Project the ledger for the browser: today, the last turn, this run, a
 * CHART_DAYS bar series, and the recent changes.
 *
 * @param {Ledger} ledger - The ledger.
 * @param {number} now - Reference time.
 * @param {number} startedAt - When this Host activation began.
 * @returns {object} The renderable summary.
 */
function summarize(ledger, now, startedAt) {
  const today = ledger.days[dayKey(now)] ?? { spent: 0, topUp: 0, turns: 0 }
  const days = []
  for (let offset = CHART_DAYS - 1; offset >= 0; offset -= 1) {
    const date = dayKey(now - offset * 86_400_000)
    const entry = ledger.days[date] ?? { spent: 0, topUp: 0, turns: 0 }
    days.push({ date, label: date.slice(5), spent: entry.spent, topUp: entry.topUp, turns: entry.turns })
  }
  return {
    currency: ledger.last?.currency ?? 'CNY',
    today: { date: dayKey(now), spent: today.spent, topUp: today.topUp, turns: today.turns },
    lastTurn: {
      delta: ledger.turn.lastDelta,
      at: ledger.turn.lastAt,
      count: ledger.turn.count,
      pending: ledger.turn.pendingUntil > now,
    },
    sinceStart: { spent: ledger.spentSince, startedAt },
    days,
    recent: ledger.recent.slice(0, 6),
    samples: ledger.last === null ? 0 : 1,
  }
}

/** An empty ledger at the current format version. */
function emptyLedger() {
  return {
    version: LEDGER_VERSION,
    last: null,
    days: {},
    recent: [],
    turn: { count: 0, lastDelta: 0, lastAt: 0, pendingDelta: 0, pendingUntil: 0, bucket: 0 },
    spentSince: 0,
  }
}

/** The `YYYY-MM-DD` key of a timestamp, in Host local time. */
function dayKey(at) {
  const date = new Date(at)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return date.getFullYear() + '-' + month + '-' + day
}

/** The day bucket for a key, created on first use. */
function ensureDay(ledger, key) {
  const existing = ledger.days[key]
  if (existing !== undefined) return existing
  const created = { spent: 0, topUp: 0, turns: 0 }
  ledger.days[key] = created
  return created
}

/** Drop history older than HISTORY_DAYS so the file cannot grow forever. */
function pruneDays(days, now) {
  const cutoff = dayKey(now - HISTORY_DAYS * 86_400_000)
  const kept = {}
  for (const [key, value] of Object.entries(days)) {
    if (key >= cutoff) kept[key] = value
  }
  return kept
}

// ---------------------------------------------------------------------------
// Ledger persistence

/** Absolute path of the ledger file under DSH_HOME. */
function ledgerPath() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'balance-whale', 'ledger.json')
}

/** Read the ledger, tolerating an absent, unreadable or stale file. */
async function loadLedger() {
  const file = ledgerPath()
  if (!existsSync(file)) return emptyLedger()
  const text = await readFile(file, 'utf8')
  const parsed = JSON.parse(text)
  if (parsed === null || typeof parsed !== 'object' || parsed.version !== LEDGER_VERSION) return emptyLedger()
  const base = emptyLedger()
  return {
    ...base,
    last: normalizeSample(parsed.last),
    days: parsed.days !== null && typeof parsed.days === 'object' ? parsed.days : {},
    recent: Array.isArray(parsed.recent) ? parsed.recent.slice(0, RECENT_LIMIT) : [],
    turn: { ...base.turn, ...(typeof parsed.turn === 'object' && parsed.turn !== null ? parsed.turn : {}) },
    spentSince: Number.isFinite(Number(parsed.spentSince)) ? Number(parsed.spentSince) : 0,
  }
}

/** Keep one stored sample only if it still has the shape the math needs. */
function normalizeSample(sample) {
  if (sample === null || typeof sample !== 'object') return null
  const at = Number(sample.at)
  const total = Number(sample.total)
  if (!Number.isFinite(at) || !Number.isFinite(total)) return null
  return { at, total, currency: typeof sample.currency === 'string' ? sample.currency : 'CNY' }
}

/** Write the ledger atomically, pruning old history first. */
async function saveLedger(ledger) {
  const file = ledgerPath()
  const snapshot = { ...ledger, version: LEDGER_VERSION, days: pruneDays(ledger.days, Date.now()) }
  await mkdir(dirname(file), { recursive: true })
  const temporary = file + '.tmp'
  await writeFile(temporary, JSON.stringify(snapshot, null, 2), 'utf8')
  await rename(temporary, file)
}

// ---------------------------------------------------------------------------
// Skins

/**
 * Discover the shipped skins: every directory under `assets/` that carries a
 * `skin.json`. Users can drop another directory in and it appears in the
 * widget's picker after the next read.
 *
 * @param {string} pluginRoot - The package root directory.
 * @returns {Promise<object[]>} Skins, ordered, with the built-in one last.
 */
async function readSkins(pluginRoot) {
  const root = join(pluginRoot, 'assets')
  const skins = []
  if (existsSync(root)) {    const entries = await readdir(root, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const manifestPath = join(root, entry.name, 'skin.json')
      if (!existsSync(manifestPath)) continue
      try {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
        const frames = {}
        for (const [mood, file] of Object.entries(manifest.frames ?? {})) {
          if (typeof file === 'string' && /^[A-Za-z0-9._-]+$/.test(file)) frames[mood] = file
        }
        if (Object.keys(frames).length === 0) continue
        skins.push({
          id: entry.name,
          name: typeof manifest.name === 'string' && manifest.name !== '' ? manifest.name : entry.name,
          accent: typeof manifest.accent === 'string' ? manifest.accent : '#4D6BFE',
          plate: typeof manifest.plate === 'string' ? manifest.plate : null,
          builtin: false,
          order: Number.isFinite(Number(manifest.order)) ? Number(manifest.order) : 50,
          frames,
        })
      } catch {
        /* a malformed skin is skipped, never fatal */
      }
    }
  }
  skins.sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
  // The hand-drawn skin has the highest order, so it lands last and the user's
  // own art is what the widget shows first.
  skins.push(BUILTIN_SKIN)
  return skins
}

/** Content type for a served frame. */
function contentType(file) {
  switch (extname(file).toLowerCase()) {
    case '.webp':
      return 'image/webp'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.gif':
      return 'image/gif'
    case '.svg':
      return 'image/svg+xml'
    default:
      return 'image/png'
  }
}

// ---------------------------------------------------------------------------
// Shared helpers

/**
 * Attach the fields every response carries: the work state, the ledger
 * summary, the requested skin, and the read timestamp.
 *
 * @param {object} deps - Per-activation state.
 * @param {object} body - The response body so far.
 * @returns {object} The complete body.
 */
function envelope(deps, body) {
  const now = Date.now()
  return {
    wallets: [],
    bonusWallets: [],
    totals: [],
    links: { usageUrl: '', topUpUrl: '' },
    ...body,
    activity: activityOf(deps),
    ledger: summarize(deps.ledger, now, deps.startedAt),
    skins: deps.runtime.skins.map((skin) => ({
      id: skin.id,
      name: skin.name,
      accent: skin.accent,
      plate: skin.plate,
      builtin: skin.builtin === true,
    })),
    size: deps.size,
    refreshSeconds: deps.refreshSeconds,
    updatedAt: now,
  }
}

/**
 * Normalize the Platform's wallet list into the two fields the widget renders.
 *
 * @param {readonly { currency?: unknown, balance?: unknown }[] | undefined} wallets - Service wallets.
 * @returns {{ currency: string, balance: string }[]} Renderable wallets.
 */
function normalizeWallets(wallets) {
  if (!Array.isArray(wallets)) return []
  const out = []
  for (const wallet of wallets) {
    if (wallet === null || typeof wallet !== 'object') continue
    const balance = typeof wallet.balance === 'string' ? wallet.balance : String(wallet.balance ?? '')
    if (balance === '') continue
    out.push({ currency: typeof wallet.currency === 'string' ? wallet.currency : 'CNY', balance })
  }
  return out
}

/**
 * Sum recharge and bonus wallets per currency. The widget's headline number is
 * the total spendable balance, so one currency's wallets are added together.
 *
 * @param {{ currency: string, balance: string }[]} wallets - Recharge wallets.
 * @param {{ currency: string, balance: string }[]} bonusWallets - Bonus wallets.
 * @returns {{ currency: string, total: string, recharge: string, bonus: string }[]} One entry per currency seen.
 */
function totalByCurrency(wallets, bonusWallets) {
  /** @type {Map<string, { recharge: number, bonus: number }>} */
  const byCurrency = new Map()
  const add = (list, key) => {
    for (const wallet of list) {
      const entry = byCurrency.get(wallet.currency) ?? { recharge: 0, bonus: 0 }
      const amount = Number(wallet.balance)
      if (Number.isFinite(amount)) entry[key] += amount
      byCurrency.set(wallet.currency, entry)
    }
  }
  add(wallets, 'recharge')
  add(bonusWallets, 'bonus')
  return [...byCurrency.entries()].map(([currency, sums]) => ({
    currency,
    recharge: sums.recharge.toFixed(2),
    bonus: sums.bonus.toFixed(2),
    total: (sums.recharge + sums.bonus).toFixed(2),
  }))
}

/**
 * Read the account's own links, tolerating a service that answers without them.
 *
 * @param {{ links?: { usageUrl?: unknown, topUpUrl?: unknown } } | null | undefined} state - Account view.
 * @returns {{ usageUrl: string, topUpUrl: string }} The links, empty when unknown.
 */
function linksOf(state) {
  const links = state?.links ?? {}
  return {
    usageUrl: typeof links.usageUrl === 'string' ? links.usageUrl : '',
    topUpUrl: typeof links.topUpUrl === 'string' ? links.topUpUrl : '',
  }
}

/** Round to four decimals: enough for money, short enough for a JSON file. */
function round4(value) {
  return Math.round(value * 10_000) / 10_000
}

/** The first argument that is a non-empty string. */
function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

/** Whether a request came from this machine. */
function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? ''
  return address === '' || address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** Whether the request carries a truthy named flag (`?refresh=1`). */
function readFlag(req, name) {
  const url = new URL(req.url ?? '/', 'http://balance-whale.local')
  const flag = url.searchParams.get(name)
  return flag === '1' || flag === 'true'
}

/**
 * Coerce one config number into its allowed range.
 *
 * @param {unknown} value - The row's value.
 * @param {number} min - Smallest accepted value.
 * @param {number} max - Largest accepted value.
 * @param {number} fallback - Value used when the row set nothing usable.
 * @returns {number} The effective value.
 */
function clampNumber(value, min, max, fallback) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

/**
 * Write one JSON response.
 *
 * @param {import('node:http').ServerResponse} res - The response.
 * @param {number} status - HTTP status.
 * @param {unknown} body - JSON-serializable body.
 */
function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  })
  res.end(payload)
}
