/**
 * Compass: a side pane that tracks the session's goal, decisions (or
 * hypotheses, or findings) grouped in topics, and one
 * explanatory visual. Every use of `$` lives in this file, because a hooks
 * module cannot hand `$` to an import; the logic it drives is in model.ts and
 * the drawing in view.tsx. The `$.state` atoms are declared here too, since
 * the validator reads them only from this file.
 */
import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelForkResult, PluginOptions, Register } from 'claude-code'

import type { CompassSession } from '../types'
import {
  DEFAULT_BODY_COLUMNS,
  applyUpdate,
  buildPrompt,
  emptySession,
  emptyView,
  fitToBudget,
  gatesOf,
  isWorthUpdating,
  migrateSession,
  parseUpdate,
  readTurnFacts,
  resolveSessionType,
  serializeMessages,
  sessionTypeSetting,
} from './model'
import { renderPane } from './view'

const PANE_ID = 'compass'
const PANE_TITLE = 'Compass'
const AGE_REFRESH_MS = 30_000
const MAX_REPLY_TOKENS = 3000
const COMPLETE_TIMEOUT_MS = 120_000
const MAX_ERROR_CHARS = 120
const STALE_UPDATE_MS = 180_000
const MAX_STORED_SESSIONS = 20
const INDEX_KEY = 'index'

const sessionAtom = atom({ plugin: 'compass', key: 'session' } as const, emptySession())
const viewAtom = atom({ plugin: 'compass', key: 'view' } as const, emptyView())
const runAtom = atom({ plugin: 'compass', key: 'run' } as const, {
  isUpdating: false,
  updatingSince: null,
  error: null,
  bodyColumns: DEFAULT_BODY_COLUMNS,
})

type StoredIndexEntry = { id: string; at: number }

const sessionKey = (id: string) => `session:${id}`

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

async function readIndex($: EngineInterface): Promise<StoredIndexEntry[]> {
  const stored = await $.store.get(INDEX_KEY)
  return Array.isArray(stored) ? stored.filter(entry => isRecord(entry) && typeof entry.id === 'string') : []
}

/** Keeps the session under its id for `--resume`, evicting the least recently saved sessions. */
async function saveSession($: EngineInterface, session: CompassSession): Promise<void> {
  const id = await $.session.id()
  await $.store.set(sessionKey(id), fitToBudget(session))

  const index = [...(await readIndex($)).filter(entry => entry.id !== id), { id, at: await $.clock.now() }]
  for (const evicted of index.splice(0, Math.max(0, index.length - MAX_STORED_SESSIONS))) {
    await $.store.delete(sessionKey(evicted.id))
  }
  await $.store.set(INDEX_KEY, index)
}

async function loadSession($: EngineInterface): Promise<CompassSession | undefined> {
  const stored = await $.store.get(sessionKey(await $.session.id()))
  if (!isRecord(stored) || !Array.isArray(stored.items)) return undefined
  return migrateSession(stored as Partial<CompassSession>)
}

async function wipeSession($: EngineInterface, id: string): Promise<void> {
  await $.store.delete(sessionKey(id))
  await $.store.set(
    INDEX_KEY,
    (await readIndex($)).filter(entry => entry.id !== id),
  )
}

/** Applies `change` to the session and persists the result. */
async function changeSession(
  $: EngineInterface,
  change: (session: CompassSession) => CompassSession,
): Promise<CompassSession> {
  const next = await update($, sessionAtom, change)
  await saveSession($, next)
  return next
}

async function failWith($: EngineInterface, message: string): Promise<void> {
  const line = `compass: ${message.slice(0, MAX_ERROR_CHARS)}`
  $.ui.log(line, { to: 'debug' })
  await update($, runAtom, run => ({ ...run, error: line }))
}

function ask($: EngineInterface, updaterModel: string, system: string, data: string): Promise<ModelForkResult> {
  if (updaterModel === 'fork') return $.model.fork({ prompt: `${system}\n\n${data}` })

  const base = { system, prompt: data, maxTokens: MAX_REPLY_TOKENS, timeoutMs: COMPLETE_TIMEOUT_MS }
  return updaterModel === 'haiku'
    ? $.model.complete({ ...base, model: 'haiku' })
    : $.model.complete({ ...base, model: 'sonnet', effort: 'low' })
}

function describeFailure(reply: Extract<ModelForkResult, { isAnswered: false }>): string {
  if (reply.reason === 'api-error') return `update failed: API error ${reply.status ?? 'no response'} (${reply.error})`
  if (reply.reason === 'nothing-to-fork') return 'update skipped: nothing to fork yet'
  return reply.reason === 'aborted' ? 'update aborted' : 'update failed: the model replied with no text'
}

async function runClaimedUpdate($: EngineInterface, options: PluginOptions): Promise<void> {
  const sessionId = await $.session.id()
  const session = await read($, sessionAtom)
  const { bodyColumns } = await read($, runAtom)
  const updaterModel = String(options.updaterModel ?? 'sonnet-low')
  const gates = gatesOf(options)
  const setting = sessionTypeSetting(options)

  const messages = await $.session.messages()
  const cursor = messages.length
  const from = session.cursor > cursor ? 0 : session.cursor
  const delta = updaterModel === 'fork' ? undefined : serializeMessages(messages, from)
  const { system, data } = buildPrompt({ session, bodyColumns, gates, sessionTypeSetting: setting, delta })

  const reply = await ask($, updaterModel, system, data)
  if (!reply.isAnswered) return failWith($, describeFailure(reply))

  const parsed = parseUpdate(reply.text)
  if (parsed === undefined) return failWith($, 'update discarded: the model did not return valid JSON')

  // A /clear while the model ran moved the process to a new session; this answer belongs to the old one.
  if ((await $.session.id()) !== sessionId) return

  const now = await $.clock.now()
  const next = await changeSession($, current => applyUpdate(current, parsed, { now, gates, sessionTypeSetting: setting, cursor }))
  if (next.version !== session.version) {
    await update($, viewAtom, view => ({ ...view, goalIndex: null, visualIndex: null }))
  }
}

/**
 * Runs an update unless one is already running; a second is never queued. A
 * hot reload drops a running update without releasing its claim, hence the
 * staleness check.
 */
async function runUpdate($: EngineInterface, options: PluginOptions): Promise<void> {
  const now = await $.clock.now()
  let isClaimed = false
  await update($, runAtom, run => {
    const isRunning = run.isUpdating && now - (run.updatingSince ?? 0) < STALE_UPDATE_MS
    isClaimed = !isRunning
    return isRunning ? run : { ...run, isUpdating: true, updatingSince: now, error: null }
  })
  if (!isClaimed) return

  try {
    await runClaimedUpdate($, options)
  } catch (error) {
    await failWith($, `update failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    await update($, runAtom, run => ({ ...run, isUpdating: false, updatingSince: null }))
  }
}

/** Starts an update outside the current dispatch, so it outlives the hook or press that asked. */
function scheduleUpdate($: EngineInterface, options: PluginOptions): void {
  $.clock.after(0, () => runUpdate($, options))
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'compass', description: 'Show or hide the Compass pane' })

    const saved = await loadSession($)
    if (saved !== undefined) await update($, sessionAtom, () => saved)

    $.clock.every(AGE_REFRESH_MS, () => $.ui.invalidate('ui.render'))

    if (options.autoOpen !== false && e.isInteractive) await $.ui.open({ id: PANE_ID, title: PANE_TITLE })

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await wipeSession($, e.sessionId)
      await update($, sessionAtom, () => emptySession())
      await update($, viewAtom, () => emptyView())
      await update($, runAtom, run => ({ ...run, isUpdating: false, updatingSince: null, error: null }))
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      const facts = readTurnFacts(await $.session.messages(), e.answer)
      if (facts.isEdit) await changeSession($, s => ({ ...s, editTurns: s.editTurns + 1 }))
      if (isWorthUpdating(facts)) scheduleUpdate($, options)
    }

    return next(e)
  })

  on('command.run', { command: 'compass' }, async $ => {
    const isShown = (await $.ui.panes()).some(pane => pane.id === PANE_ID)
    if (isShown) {
      await $.ui.close({ id: PANE_ID })
      return { text: 'Compass pane closed.' }
    }

    await $.ui.open({ id: PANE_ID, title: PANE_TITLE })
    return { text: 'Compass pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const session = await read($, sessionAtom)
    const view = await read($, viewAtom)
    const run = await read($, runAtom)
    const now = await $.clock.now()
    const width = e.props.bodyColumns

    // A render never writes state, so the width reaches the updater from a timer.
    if (width !== run.bodyColumns) {
      $.clock.after(0, () => update($, runAtom, current => ({ ...current, bodyColumns: width })))
    }

    return renderPane({
      elements: $.ui.resolve(e),
      session,
      view,
      sessionType: resolveSessionType(sessionTypeSetting(options), session.sessionType),
      gates: gatesOf(options),
      run,
      now,
      width,
      actions: {
        setView: change => update($, viewAtom, change),
        fillPrompt: text => $.prompt.fill({ text, mode: 'insert' }),
        refresh: () => scheduleUpdate($, options),
      },
    })
  })
}
