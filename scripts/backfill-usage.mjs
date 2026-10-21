#!/usr/bin/env node
/**
 * Backfill local usage records from DSH session transcripts and reprice unpriced calls.
 *
 * The script reads only the local ledger and session JSONL transcripts. It does not
 * read credentials, prompts, or assistant text, and it never calls the network.
 * Dry-run is the default; pass --apply to write.
 *
 * Usage:
 *   node scripts/backfill-usage.mjs --since 2026-10-21T00:00:00+08:00
 *   node scripts/backfill-usage.mjs --logs --reprice --apply --since ...
 *   node scripts/backfill-usage.mjs --reprice --apply --model deepseek-v4.1-flash-1017
 *
 * Environment:
 *   DSH_HOME    default ~/.dsh
 *   DSH_LEDGER  override the ledger path
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { calculateCost, DEFAULT_PRICE_BOOK, resolvePrice } from '../lib/pricing.js'

const args = process.argv.slice(2)
const has = name => args.includes(name)
const option = name => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}
const apply = has('--apply')
const requestedLogs = has('--logs')
const requestedReprice = has('--reprice')
const backfillLogs = requestedLogs || !requestedReprice
const repriceCalls = requestedReprice || !requestedLogs
const jsonOutput = has('--json')
const sinceText = option('--since')
const sessionFilter = option('--session')
const modelFilter = option('--model')
const since = sinceText === undefined ? null : Date.parse(sinceText)
if (sinceText !== undefined && !Number.isFinite(since)) fail(`--since is not a valid date: ${sinceText}`)
if (sessionFilter !== undefined && !sessionFilter.trim()) fail('--session requires a session id')
if (modelFilter !== undefined && !modelFilter.trim()) fail('--model requires a model substring')

const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const ledgerPath = process.env.DSH_LEDGER || join(dshHome, 'storages', 'usage-insights', 'ledger.sqlite')
const sessionsPath = join(dshHome, 'sessions')
if (!existsSync(ledgerPath)) fail(`ledger not found: ${ledgerPath}`)

const db = new DatabaseSync(ledgerPath, { readOnly: !apply })
db.exec('PRAGMA busy_timeout = 5000')
const readMeta = (key, fallback) => {
  const row = db.prepare('SELECT value_json FROM metadata WHERE key = ?').get(key)
  if (!row?.value_json) return fallback
  try { return JSON.parse(row.value_json) } catch { return fallback }
}
const config = readMeta('config', {})
const storedBook = readMeta('priceBook', {})
const book = {
  ...DEFAULT_PRICE_BOOK,
  ...storedBook,
  models: { ...DEFAULT_PRICE_BOOK.models, ...(storedBook.models || {}) },
  candidates: { ...DEFAULT_PRICE_BOOK.candidates, ...(storedBook.candidates || {}) },
  aliases: { ...DEFAULT_PRICE_BOOK.aliases, ...(storedBook.aliases || {}) },
}
for (const [key, entry] of Object.entries(config.pricing?.customOverrides || {})) {
  book.models[key] = { ...entry, source: 'custom', sourceKind: 'custom', mode: 'flat' }
}
const fx = Number(config.fx?.usdToCny) > 0 ? Number(config.fx.usdToCny) : null
const fxSnapshotId = config.fx?.snapshotId || null
const now = Date.now()

function fail(message) {
  console.error(`backfill: ${message}`)
  process.exit(1)
}

function readLog(path) {
  if (!path.endsWith('.zstd')) return readFileSync(path, 'utf8')
  try {
    // Session logs are appended as multiple zstd frames; the CLI decodes all of them.
    return execFileSync('zstd', ['-dc', path], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('the zstd executable is required to read compressed session logs')
    throw error
  }
}

function walk(dir, output = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path, output)
    else if (entry.isFile() && /^session\.v4\.jsonl(?:\.zstd)?$/.test(entry.name)) output.push(path)
  }
  return output
}

function ratesFor(entry, resolved, tier) {
  if (resolved.tier === 'peak') return entry.peak
  if (resolved.tier === 'off-peak') return entry.offPeak
  if (tier === 'long-context') return entry.longContext
  return entry
}

function costFields(provider, model, at, usage) {
  const tokens = {
    inputTokens: Number(usage?.inputTokens) || 0,
    outputTokens: Number(usage?.outputTokens) || 0,
    cacheReadTokens: Number(usage?.cacheReadTokens) || 0,
    cacheWriteTokens: Number(usage?.cacheWriteTokens) || 0,
    reasoningTokens: Number(usage?.reasoningTokens) || 0,
  }
  const resolved = resolvePrice(book, provider, model, at)
  const cost = calculateCost(tokens, resolved, fx)
  if (!resolved.entry) return { tokens, resolved, cost, rates: {}, priced: false }
  return {
    tokens,
    resolved,
    cost,
    rates: ratesFor(resolved.entry, resolved, cost.tier),
    priced: cost.priced,
  }
}

function rootSession(sessionId, headers) {
  let current = String(sessionId)
  const seen = new Set()
  while (!seen.has(current)) {
    seen.add(current)
    const header = headers.get(current)
    if (!header?.parentSession) return current
    current = String(header.parentSession)
  }
  return current
}

const headers = new Map()
const logs = []
const warnings = []
if (backfillLogs) {
  if (!existsSync(sessionsPath)) fail(`session directory not found: ${sessionsPath}`)
  for (const file of walk(sessionsPath)) {
    if (since !== null && statSync(file).mtimeMs < since) continue
    let text
    try {
      text = readLog(file)
    } catch (error) {
      warnings.push(`cannot read ${file}: ${String(error?.message || error)}`)
      continue
    }
    let header = null
    const messages = []
    for (const line of text.split('\n')) {
      if (!line) continue
      let event
      try { event = JSON.parse(line) } catch { continue }
      if (event.type === 'session') { header = event; continue }
      if (event.type !== 'assistant/message') continue
      if (since !== null && Number(event.time) < since) continue
      const usage = event.data?.usage
      const source = event.data?.message?.source
      if (!usage || typeof source?.provider !== 'string' || typeof source?.model !== 'string') continue
      messages.push({ event, usage, source })
    }
    if (header?.id) headers.set(String(header.id), header)
    if (header?.id && (!sessionFilter || String(header.id) === sessionFilter)) logs.push({ header, messages })
  }
}

const existingCall = db.prepare(`SELECT id FROM calls WHERE session_id = ? AND ABS(at - ?) <= 2500 AND input_tokens = ? AND output_tokens = ? AND cache_read_tokens = ? AND cache_write_tokens = ? LIMIT 1`)
const insertCall = db.prepare(`INSERT OR IGNORE INTO calls(
  id, at, started_at, duration_ms, session_id, root_session_id, parent_session_id, workspace_id, workspace,
  provider, provider_route, model, credential_ref, purpose, terminal, input_tokens, output_tokens,
  cache_read_tokens, cache_write_tokens, reasoning_tokens, cache_supported, priced, price_key, price_tier,
  price_matched_by, price_source, price_source_url, price_checked_at, rates_json, currency,
  cost_native, cost_usd, cost_cny, usd_to_cny, fx_snapshot_id, origin
) VALUES(${new Array(36).fill('?').join(',')})`)
const updateCall = db.prepare(`UPDATE calls SET
  priced = 1, price_key = ?, price_tier = ?, price_matched_by = ?, price_source = ?, price_source_url = ?,
  price_checked_at = ?, rates_json = ?, currency = ?, cost_native = ?, cost_usd = ?, cost_cny = ?,
  usd_to_cny = ?, fx_snapshot_id = ?
  WHERE id = ?`)

const missing = []
for (const log of logs) {
  const header = log.header
  const root = rootSession(header.id, headers)
  for (const { event, usage, source } of log.messages) {
    const at = Number(event.time)
    if (!Number.isFinite(at)) continue
    if (modelFilter && !String(source.model).includes(modelFilter)) continue
    const fields = costFields(source.provider, source.model, at, usage)
    const exists = existingCall.get(
      String(header.id), at,
      fields.tokens.inputTokens, fields.tokens.outputTokens, fields.tokens.cacheReadTokens, fields.tokens.cacheWriteTokens,
    )
    if (exists) continue
    const streamTimes = Array.isArray(event.data?.stream)
      ? event.data.stream.map(chunk => Number(chunk?.time)).filter(Number.isFinite)
      : []
    const startedAt = streamTimes.length > 0 ? Math.min(...streamTimes) : at
    const messageId = String(event.data?.message?.id || `${at}:${fields.tokens.inputTokens}:${fields.tokens.outputTokens}`)
    const id = createHash('sha256').update(`backfill-session-log|${header.id}|${messageId}`).digest('hex').slice(0, 32)
    missing.push({
      id,
      at,
      startedAt,
      durationMs: Math.max(0, at - startedAt),
      sessionId: String(header.id),
      rootSessionId: root,
      parentSessionId: header.parentSession ? String(header.parentSession) : null,
      workspace: header.cwd || null,
      provider: source.provider,
      providerRoute: source.provider,
      model: source.model,
      purpose: header.origin === 'subagent' || header.parentSession ? 'subagent' : 'main-agent',
      tokens: fields.tokens,
      cacheSupported: Object.hasOwn(usage, 'cacheReadTokens') || Object.hasOwn(usage, 'cacheWriteTokens'),
      resolved: fields.resolved,
      cost: fields.cost,
      rates: fields.rates,
    })
  }
}

const unpriced = db.prepare(`SELECT * FROM calls WHERE priced = 0${modelFilter ? ' AND model LIKE ?' : ''}${since !== null ? ' AND at >= ?' : ''} ORDER BY at ASC`)
const repriceRows = repriceCalls
  ? unpriced.all(...[modelFilter ? `%${modelFilter}%` : null, since].filter(value => value !== null))
  : []

let inserted = 0
let repriced = 0
let stillUnpriced = 0
let addedCny = 0
let addedUsd = 0
const applyChanges = () => {
  if (!apply) return
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const row of missing) {
      const { resolved, cost, rates } = row
      insertCall.run(
        row.id, row.at, row.startedAt, row.durationMs, row.sessionId, row.rootSessionId, row.parentSessionId, null, row.workspace,
        row.provider, row.providerRoute, row.model, null, row.purpose, 'finished',
        row.tokens.inputTokens, row.tokens.outputTokens, row.tokens.cacheReadTokens, row.tokens.cacheWriteTokens, row.tokens.reasoningTokens,
        row.cacheSupported ? 1 : 0, cost.priced ? 1 : 0, resolved.key, cost.tier, resolved.matchedBy,
        resolved.entry?.sourceKind || resolved.entry?.source || null, resolved.entry?.sourceUrl || null,
        resolved.entry?.checkedAt || new Date().toISOString(), JSON.stringify(rates),
        cost.currency, cost.native, cost.usd, cost.cny, fx, fxSnapshotId, 'backfill-session-log',
      )
      inserted += 1
      if (!cost.priced) stillUnpriced += 1
      addedCny += Number(cost.cny) || 0
      addedUsd += Number(cost.usd) || 0
    }
    for (const row of repriceRows) {
      const fields = costFields(row.provider, row.model, row.at, {
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        cacheReadTokens: row.cache_read_tokens,
        cacheWriteTokens: row.cache_write_tokens,
        reasoningTokens: row.reasoning_tokens,
      })
      if (!fields.priced) { stillUnpriced += 1; continue }
      const rowFx = fx ?? (Number(row.usd_to_cny) > 0 ? Number(row.usd_to_cny) : null)
      const rowFxSnapshot = fxSnapshotId ?? row.fx_snapshot_id ?? null
      updateCall.run(
        fields.resolved.key, fields.cost.tier, fields.resolved.matchedBy,
        fields.resolved.entry?.sourceKind || fields.resolved.entry?.source || null, fields.resolved.entry?.sourceUrl || null,
        fields.resolved.entry?.checkedAt || new Date().toISOString(), JSON.stringify(fields.rates),
        fields.cost.currency, fields.cost.native, fields.cost.usd, fields.cost.cny, rowFx, rowFxSnapshot, row.id,
      )
      repriced += 1
      addedCny += Number(fields.cost.cny) || 0
      addedUsd += Number(fields.cost.usd) || 0
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

if (!apply) {
  for (const row of missing) {
    const fields = costFields(row.provider, row.model, row.at, row.tokens)
    if (!fields.priced) stillUnpriced += 1
    addedCny += Number(fields.cost.cny) || 0
    addedUsd += Number(fields.cost.usd) || 0
  }
  for (const row of repriceRows) {
    const fields = costFields(row.provider, row.model, row.at, {
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheReadTokens: row.cache_read_tokens,
      cacheWriteTokens: row.cache_write_tokens,
      reasoningTokens: row.reasoning_tokens,
    })
    if (!fields.priced) stillUnpriced += 1
    else addedCny += Number(fields.cost.cny) || 0
    if (fields.priced) addedUsd += Number(fields.cost.usd) || 0
  }
} else {
  applyChanges()
}

const summary = {
  ledger: ledgerPath,
  mode: apply ? 'apply' : 'dry-run',
  scannedSessions: logs.length,
  missingCalls: missing.length,
  repriceCandidates: repriceRows.length,
  inserted,
  repriced,
  stillUnpriced,
  addedCostCny: Number(addedCny.toFixed(6)),
  addedCostUsd: Number(addedUsd.toFixed(6)),
  warnings,
}
if (jsonOutput) console.log(JSON.stringify(summary, null, 2))
else {
  console.log(`ledger: ${summary.ledger}`)
  console.log(`mode: ${summary.mode}`)
  console.log(`sessions scanned: ${summary.scannedSessions}`)
  console.log(`missing calls found: ${summary.missingCalls}`)
  console.log(`unpriced calls considered: ${summary.repriceCandidates}`)
  if (apply) {
    console.log(`inserted: ${summary.inserted}`)
    console.log(`repriced: ${summary.repriced}`)
    console.log(`still unpriced: ${summary.stillUnpriced}`)
    console.log(`added cost: ${summary.addedCostCny} CNY / ${summary.addedCostUsd} USD`)
  } else {
    console.log(`would add cost: ${summary.addedCostCny} CNY / ${summary.addedCostUsd} USD`)
    console.log(`still unpriced: ${summary.stillUnpriced}`)
    for (const row of missing.slice(0, 10)) {
      console.log(`  ${new Date(row.at).toISOString()} ${row.sessionId} ${row.model} ${row.tokens.inputTokens}/${row.tokens.outputTokens}/${row.tokens.cacheReadTokens}`)
    }
  }
  for (const warning of warnings) console.error(`warning: ${warning}`)
}
db.close()
