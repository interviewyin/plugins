/**
 * Tests of compass: the pure gate and merge logic, then the whole plugin
 * driven through the engine with the world beneath it mocked.
 */
import type { ModelCompleteRequest, ModelForkRequest, On, SessionMessage } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { CompassSession } from '../types'
import {
  MAX_SNAPSHOTS,
  applyUpdate,
  buildPrompt,
  emptySession,
  enabledKinds,
  fitToBudget,
  groupByTopic,
  isWorthUpdating,
  kindSpec,
  migrateSession,
  parseUpdate,
  readTurnFacts,
  serializeMessages,
} from './model'
import type { CompassUpdate, Gates } from './model'

const SURFACES = ['terminal', 'desktop'] as const
const NO_GATES: Gates = { trackOpenQuestions: false, trackRejected: false }
const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

const user = (text: string): SessionMessage => ({ role: 'user', text, toolUses: [] })
const assistant = (text: string, tools: string[] = []): SessionMessage => ({
  role: 'assistant',
  text,
  toolUses: tools.map((tool, i) => ({ tool_use_id: `${tool}${i}`, tool, input: { file_path: '/src/a.ts' } })),
})
const toolResultRow = (id: string, text: string): SessionMessage => ({
  role: 'user',
  text: '',
  toolUses: [],
  toolResults: [{ tool_use_id: id, text, isError: false }],
})

const editTurn = [user('add a retry'), assistant('', ['Edit']), toolResultRow('Edit0', 'ok'), assistant('Done.')]
const chatTurn = [user('thanks'), assistant('You are welcome.')]

const update = (partial: Partial<CompassUpdate>): CompassUpdate => ({
  noChange: false,
  topics: [],
  items: [],
  removed: [],
  ...partial,
})
const ctx = (cursor = 1, now = 1000) => ({ now, gates: NO_GATES, sessionTypeSetting: 'auto' as const, cursor })

function seeded(): CompassSession {
  return applyUpdate(
    emptySession(),
    update({
      goal: { text: 'Add retries', drift: null },
      items: [
        { kind: 'decision', text: 'Use exponential backoff' },
        { kind: 'assumption', text: 'Retry at most three times' },
      ],
    }),
    ctx(),
  )
}

test('the gate skips a trivial turn and lets edits, questions and long prose through', () => {
  expect(isWorthUpdating(readTurnFacts(chatTurn, 'You are welcome.'))).toBe(false)
  expect(isWorthUpdating(readTurnFacts(editTurn, 'Done.'))).toBe(true)
  const asked = [user('go'), assistant('', ['AskUserQuestion'])]
  expect(isWorthUpdating(readTurnFacts(asked, ''))).toBe(true)
  expect(isWorthUpdating(readTurnFacts(chatTurn, 'x'.repeat(400)))).toBe(true)
})

test('the gate judges only the rows after the last typed prompt', () => {
  const facts = readTurnFacts([...editTurn, ...chatTurn], 'You are welcome.')
  expect(facts.isEdit).toBe(false)
})

test('parseUpdate reads JSON out of fences and prose, and refuses everything else', () => {
  const fenced = 'Sure!\n```json\n{"goal":{"text":"G","drift":"off topic"},"items":[{"kind":"decision","text":"A {brace} here"}]}\n```'
  expect(parseUpdate(fenced)?.goal).toEqual({ text: 'G', drift: 'off topic' })
  expect(parseUpdate(fenced)?.items[0]?.text).toBe('A {brace} here')
  expect(parseUpdate('not json at all')).toBeUndefined()
  expect(parseUpdate('{"unrelated": 1}')).toBeUndefined()
  expect(parseUpdate('{"items": "nope"}')).toBeUndefined()
  expect(parseUpdate('{"noChange": true}')?.noChange).toBe(true)
})

test('parseUpdate refuses SVG and image visuals but lets null clear', () => {
  expect(parseUpdate('{"goal":{"text":"G"},"visual":{"form":"x","markdown":"<svg></svg>"}}')?.visual).toBeUndefined()
  expect(parseUpdate('{"goal":{"text":"G"},"visual":{"form":"x","markdown":"![a](b.png)"}}')?.visual).toBeUndefined()
  expect(parseUpdate('{"visual":null}')?.visual).toBeNull()
})

test('an item sent again under its id is revised in place with a revision trail', () => {
  const before = seeded()
  const id = before.items[0]?.id
  const after = applyUpdate(
    before,
    update({ items: [{ id, kind: 'decision', text: 'Use jittered backoff', reason: 'user asked for jitter' }] }),
    ctx(2, 2000),
  )
  expect(after.items).toHaveLength(2)
  const item = after.items[0]
  expect(item?.text).toBe('Use jittered backoff')
  expect(item?.version).toBe(2)
  expect(item?.revisions).toEqual([{ version: 1, text: 'Use exponential backoff', reason: 'user asked for jitter', at: 2000 }])
  expect(item?.updatedVersion).toBe(2)
  expect(item?.createdVersion).toBe(1)
})

test('an item sent again unchanged changes nothing and takes no snapshot', () => {
  const before = seeded()
  const after = applyUpdate(before, update({ items: [{ id: before.items[0]?.id, kind: 'decision', text: 'Use exponential backoff' }] }), ctx(3, 3000))
  expect(after.items).toEqual(before.items)
  expect(after.version).toBe(before.version)
  expect(after.snapshots).toHaveLength(1)
  expect(after.cursor).toBe(3)
})

test('supersedes replaces an item by a new one that inherits its trail', () => {
  const before = seeded()
  const old = before.items[1]
  const after = applyUpdate(
    before,
    update({ items: [{ kind: 'decision', text: 'Retry five times', supersedes: old?.id, reason: 'user raised the limit' }] }),
    ctx(2, 2000),
  )
  const born = after.items[2]
  expect(after.items[1]?.status).toBe('superseded')
  expect(born?.status).toBe('active')
  expect(born?.id).not.toBe(old?.id)
  expect(born?.revisions).toEqual([{ version: 1, text: 'Retry at most three times', reason: 'user raised the limit', at: 2000 }])
})

test('confirming an assumption is the same id sent again as a decision', () => {
  const before = seeded()
  const id = before.items[1]?.id
  const after = applyUpdate(before, update({ items: [{ id, kind: 'decision', text: 'Retry at most three times' }] }), ctx(2))
  expect(after.items).toHaveLength(2)
  expect(after.items[1]).toMatchObject({ id, kind: 'decision', status: 'active', version: 1, revisions: [], updatedVersion: 2 })
})

test('an unknown id falls back to text closeness before minting a new id', () => {
  const before = seeded()
  const close = applyUpdate(before, update({ items: [{ id: 'zzz', kind: 'decision', text: 'Use exponential backoff with jitter' }] }), ctx(2))
  expect(close.items).toHaveLength(2)
  expect(close.items[0]?.revisions).toHaveLength(1)
  const far = applyUpdate(before, update({ items: [{ id: 'zzz', kind: 'decision', text: 'Log every failure' }] }), ctx(2))
  expect(far.items).toHaveLength(3)
  expect(far.items[2]?.id).toBe('i3')
})

test('kinds that are switched off are dropped, removed items go inactive', () => {
  const before = seeded()
  const after = applyUpdate(
    before,
    update({ items: [{ kind: 'open_question', text: 'Which queue?' }], removed: [{ id: before.items[0]?.id ?? '', reason: 'gone' }] }),
    ctx(2),
  )
  expect(after.items).toHaveLength(2)
  expect(after.items[0]?.status).toBe('superseded')
})

test('noChange only advances the cursor', () => {
  const before = seeded()
  const after = applyUpdate(before, update({ noChange: true }), ctx(9, 5000))
  expect({ ...after, cursor: before.cursor, lastUpdatedAt: before.lastUpdatedAt }).toEqual(before)
  expect(after.cursor).toBe(9)
  expect(after.lastUpdatedAt).toBe(5000)
})

test('snapshots are capped at 50 and the session version keeps counting', () => {
  let session = emptySession()
  for (let i = 1; i <= MAX_SNAPSHOTS + 5; i++) {
    session = applyUpdate(session, update({ goal: { text: `Goal ${i}`, drift: null } }), ctx(i, i))
  }
  expect(session.snapshots).toHaveLength(MAX_SNAPSHOTS)
  expect(session.snapshots[0]?.version).toBe(6)
  expect(session.version).toBe(MAX_SNAPSHOTS + 5)
})

test('a session over its store budget loses its oldest snapshots first', () => {
  let session = emptySession()
  for (let i = 1; i <= MAX_SNAPSHOTS; i++) {
    session = applyUpdate(session, update({ visual: { form: 'table', markdown: `${i} `.repeat(1000) } }), ctx(i, i))
  }
  const fitted = fitToBudget(session)
  expect(JSON.stringify(fitted).length).toBeLessThan(120_001)
  expect(fitted.snapshots.at(-1)).toEqual(session.snapshots.at(-1))
})

test('the delta keeps the newest rows within its cap and truncates tool results', () => {
  const rows = [user('first'), assistant('x'.repeat(500)), user('second'), assistant('', ['Bash']), toolResultRow('Bash0', 'r'.repeat(900))]
  const text = serializeMessages(rows, 0, 700)
  expect(text).toContain('[earlier messages omitted]')
  expect(text).not.toContain('first')
  expect(text).toContain('result of Bash')
  expect(text.length).toBeLessThan(700 + 100)
  expect(serializeMessages(rows, 4)).not.toContain('second')
})

test('the prompt carries the column budget and tells the updater how confirmations arrive', () => {
  const { system, data } = buildPrompt({ session: seeded(), bodyColumns: 61, gates: NO_GATES, sessionTypeSetting: 'auto', delta: 'USER: hi' })
  expect(data).toContain('COLUMNS: 61')
  expect(data).toContain('USER: hi')
  expect(data).not.toContain('USER_EDITS')
  expect(system).toContain('same id and kind "decision"')
  expect(system).toContain("restate in your own words what you think the user's goals are")
})

test('sessions stored with accept and dismiss load as active decisions and hidden items', () => {
  const stored = seeded()
  const legacy = {
    ...stored,
    items: [
      { ...stored.items[0], kind: 'decision', status: 'accepted' },
      { ...stored.items[1], status: 'dismissed' },
    ],
  }
  const loaded = migrateSession(legacy as never)
  expect(loaded.items.map(item => item.status)).toEqual(['active', 'superseded'])
  expect(loaded.goal).toEqual(stored.goal)
  expect(migrateSession({}).items).toEqual([])
})

const topical = (): CompassSession =>
  applyUpdate(
    emptySession(),
    update({
      topics: [
        { name: 'Retries', headline: 'Backoff, three tries' },
        { name: 'Logging', headline: 'One line per failure' },
      ],
      items: [
        { kind: 'decision', text: 'Backoff: exponential', topic: 'Retries' },
        { kind: 'assumption', text: 'Tries: three', topic: 'Retries' },
        { kind: 'decision', text: 'Log: every failure', topic: 'Logging' },
      ],
    }),
    ctx(),
  )

test('topics are minted from the shared sequence and items resolve them by name', () => {
  const session = topical()
  expect(session.topics.map(topic => topic.id)).toEqual(['t1', 't2'])
  expect(session.items.map(item => [item.id, item.topic])).toEqual([
    ['i3', 't1'],
    ['i4', 't1'],
    ['i5', 't2'],
  ])
  expect(session.nextSeq).toBe(6)
})

test('a topic sent again under its id is renamed in place, and a close name finds it without the id', () => {
  const before = topical()
  const renamed = applyUpdate(before, update({ topics: [{ id: 't1', name: 'Retry policy', headline: 'Jittered backoff' }] }), ctx(2, 2000))
  expect(renamed.topics[0]).toMatchObject({ id: 't1', name: 'Retry policy', headline: 'Jittered backoff', updatedVersion: 2 })
  expect(renamed.topics).toHaveLength(2)

  const close = applyUpdate(before, update({ topics: [{ id: 'zzz', name: 'retries', headline: 'Capped backoff' }] }), ctx(2, 2000))
  expect(close.topics.map(topic => [topic.id, topic.headline])).toEqual([
    ['t1', 'Capped backoff'],
    ['t2', 'One line per failure'],
  ])
})

test('an item moves with just an id and a topic, and an emptied topic disappears', () => {
  const before = topical()
  const moved = applyUpdate(before, update({ items: [{ id: 'i5', topic: 'Retries' }] }), ctx(2, 2000))
  expect(moved.items[2]).toMatchObject({ id: 'i5', topic: 't1', text: 'Log: every failure', version: 1, createdVersion: 1, updatedVersion: 1 })
  expect(moved.topics.map(topic => topic.id)).toEqual(['t1'])
  expect(moved.topics[0]?.updatedVersion).toBe(2)
})

test('a move naming a topic nobody declared creates it', () => {
  const moved = applyUpdate(topical(), update({ items: [{ id: 'i5', topic: 'Observability' }] }), ctx(2, 2000))
  expect(moved.topics.map(topic => topic.name)).toEqual(['Retries', 'Observability'])
  expect(moved.items[2]?.topic).toBe(moved.topics[1]?.id)
})

test('parseUpdate reads topics, moves and the session type, and refuses unknown types', () => {
  const parsed = parseUpdate(
    JSON.stringify({
      sessionType: 'debugging',
      topics: [{ id: 't1', name: 'Cache', headline: 'Stale reads' }, { headline: 'no name' }],
      items: [{ id: 'i1', topic: 't1' }, { kind: 'hypothesis', text: 'TTL too long', topic: 'Cache' }, { kind: 'nope', text: 'x' }, { topic: 't1' }],
    }),
  )
  expect(parsed?.sessionType).toBe('debugging')
  expect(parsed?.topics).toEqual([{ id: 't1', name: 'Cache', headline: 'Stale reads' }])
  expect(parsed?.items).toHaveLength(2)
  expect(parsed?.items[0]).toEqual({ id: 'i1', topic: 't1' })
  expect(parseUpdate('{"sessionType":"gardening","goal":{"text":"G"}}')?.sessionType).toBeUndefined()
})

test('items without a topic, or whose topic is gone, group under Other', () => {
  const session = topical()
  const items = [...session.items, { ...session.items[0], id: 'i9', topic: null }, { ...session.items[0], id: 'i10', topic: 'tGone' }] as CompassSession['items']
  const groups = groupByTopic(session.topics, items, item => (item.kind === 'assumption' ? 'needs-review' : 'settled'))
  const other = groups.find(group => group.id === 'other')
  expect(other).toMatchObject({ name: 'Other', headline: '', settledCount: 2, reviewCount: 0 })
  expect(other?.items.map(item => item.id)).toEqual(['i10', 'i9'])
})

test('topics holding needs-review items come first, then the most recently changed', () => {
  let session = applyUpdate(
    emptySession(),
    update({
      topics: [
        { name: 'Alpha', headline: '' },
        { name: 'Beta', headline: '' },
        { name: 'Gamma', headline: '' },
      ],
      items: [
        { kind: 'decision', text: 'Alpha: one', topic: 'Alpha' },
        { kind: 'assumption', text: 'Beta: one', topic: 'Beta' },
        { kind: 'decision', text: 'Gamma: one', topic: 'Gamma' },
      ],
    }),
    ctx(),
  )
  const order = () => groupByTopic(session.topics, session.items, item => (item.kind === 'assumption' ? 'needs-review' : 'settled')).map(group => group.name)
  expect(order()).toEqual(['Beta', 'Alpha', 'Gamma'])

  session = applyUpdate(session, update({ items: [{ id: 'i6', kind: 'decision', text: 'Gamma: two' }] }), ctx(2, 2000))
  expect(order()).toEqual(['Beta', 'Gamma', 'Alpha'])
})

test('the session type is inferred once, kept when the update omits it, and a config value overrides it', () => {
  const inferred = applyUpdate(emptySession(), update({ sessionType: 'debugging', goal: { text: 'G', drift: null } }), ctx())
  expect(inferred.sessionType).toBe('debugging')
  expect(applyUpdate(inferred, update({ goal: { text: 'H', drift: null } }), ctx(2)).sessionType).toBe('debugging')
  expect(applyUpdate(inferred, update({ sessionType: 'research' }), ctx(2)).sessionType).toBe('research')

  const fixed = applyUpdate(inferred, update({ sessionType: 'research' }), { ...ctx(2), sessionTypeSetting: 'review' })
  expect(fixed.sessionType).toBe('review')
})

test('each session type lists its own kinds with a glyph, a reply label and a class, behind the right gates', () => {
  expect(enabledKinds('design', NO_GATES)).toEqual(['decision', 'assumption'])
  expect(enabledKinds('design', { trackOpenQuestions: true, trackRejected: true })).toEqual(['decision', 'assumption', 'open_question', 'rejected'])
  expect(enabledKinds('refactor', NO_GATES)).toEqual(['decision', 'assumption'])
  expect(enabledKinds('debugging', NO_GATES)).toEqual(['confirmed', 'hypothesis', 'ruled_out'])
  expect(enabledKinds('research', NO_GATES)).toEqual(['finding'])
  expect(enabledKinds('research', { trackOpenQuestions: true, trackRejected: true })).toEqual(['finding', 'open_question', 'dead_end'])
  expect(enabledKinds('review', NO_GATES)).toEqual(['finding', 'resolved'])

  expect(kindSpec('design', 'assumption')).toMatchObject({ glyph: '?', label: 'assumed', kindClass: 'needs-review' })
  expect(kindSpec('design', 'rejected')).toMatchObject({ glyph: '✗', kindClass: 'dropped', gate: 'trackRejected' })
  expect(kindSpec('debugging', 'confirmed')).toMatchObject({ glyph: '✓', label: 'confirmed', kindClass: 'settled' })
  expect(kindSpec('debugging', 'hypothesis')).toMatchObject({ glyph: '?', kindClass: 'needs-review' })
  expect(kindSpec('debugging', 'ruled_out')).toMatchObject({ glyph: '✗', label: 'ruled out', kindClass: 'dropped' })
  expect(kindSpec('debugging', 'ruled_out')?.gate).toBeUndefined()
  expect(kindSpec('review', 'finding')).toMatchObject({ glyph: '?', kindClass: 'needs-review' })
  expect(kindSpec('research', 'finding')).toMatchObject({ glyph: '✓', kindClass: 'settled' })
})

test('a kind outside the active type is looked up across all types so it keeps its class', () => {
  expect(kindSpec('debugging', 'decision')).toMatchObject({ glyph: '✓', label: 'decided', kindClass: 'settled' })
  expect(kindSpec('review', 'assumption')).toMatchObject({ glyph: '?', kindClass: 'needs-review' })
})

test('the prompt describes only the active type, asks for topics, and sends the topic of every item', () => {
  const session = { ...topical(), sessionType: 'debugging' as const }
  const { system, data } = buildPrompt({ session, bodyColumns: 48, gates: NO_GATES, sessionTypeSetting: 'auto', delta: '' })
  expect(system).toContain('kind "hypothesis"')
  expect(system).not.toContain('kind "assumption"')
  expect(system).toContain('same id and kind "confirmed"')
  expect(system).toContain('Assign EVERY active item a topic')
  expect(system).toContain('"subject: choice"')
  expect(system).toContain('at most five active items per topic')
  expect(data).toContain('ENABLED_KINDS: confirmed, hypothesis, ruled_out')
  expect(data).toContain('"topics":[{"id":"t1","name":"Retries"')
  expect(data).toContain('"id":"i3","kind":"decision","text":"Backoff: exponential","topic":"t1"')

  const legacy = buildPrompt({ session: seeded(), bodyColumns: 48, gates: NO_GATES, sessionTypeSetting: 'review', delta: '' })
  expect(legacy.data).toContain('"topic":null')
  expect(legacy.system).toContain('fixed as "review"')
  expect(legacy.system).not.toContain('Infer it from the conversation')
})

test('a session stored with clips loads without them', () => {
  const migrated = migrateSession({ ...seeded(), clips: [{ id: 'c7', text: 'keep', at: 1 }] } as Partial<CompassSession>)
  expect('clips' in migrated).toBe(false)
  expect(migrated.items).toHaveLength(2)
})

test('a session stored before topics and session types loads with no topic and no type', () => {
  const { topics: _topics, sessionType: _type, ...legacy } = seeded()
  const loaded = migrateSession({ ...legacy, items: legacy.items.map(({ topic: _topic, ...item }) => item) } as never)
  expect(loaded.topics).toEqual([])
  expect(loaded.sessionType).toBeNull()
  expect(loaded.items.map(item => item.topic)).toEqual([null, null])
})

type World = {
  messages: SessionMessage[]
  replies: string[]
  requests: ModelCompleteRequest[]
  forks: ModelForkRequest[]
  forkReply: 'nothing-to-fork' | 'text'
  isModelHanging: boolean
  opened: string[]
  fills: string[]
  store: Map<string, unknown>
  sessionId: string
}

function world(on: On, overrides: Partial<World> = {}) {
  const w: World = {
    messages: editTurn,
    replies: [],
    requests: [],
    forks: [],
    forkReply: 'text',
    isModelHanging: false,
    opened: [],
    fills: [],
    store: new Map(),
    sessionId: 'session-1',
    ...overrides,
  }
  const clock = mock.clock(on)
  const nextReply = () => w.replies.shift() ?? '{"noChange":true}'
  on('session.id', () => ({ value: w.sessionId }))
  on('session.messages', () => ({ value: w.messages }))
  on('model.complete', async (_$, e) => {
    w.requests.push(e)
    if (w.isModelHanging) await clock.sleep(10_000_000)
    const text = nextReply()
    return { value: text === 'API_ERROR' ? { isAnswered: false as const, reason: 'api-error' as const, status: 529, error: 'overloaded' as const, usage: USAGE } : { isAnswered: true as const, text, usage: USAGE } }
  })
  on('model.fork', (_$, e) => {
    w.forks.push(e)
    return { value: w.forkReply === 'nothing-to-fork' ? { isAnswered: false as const, reason: 'nothing-to-fork' as const } : { isAnswered: true as const, text: nextReply(), usage: USAGE } }
  })
  on('ui.open', (_$, e) => {
    w.opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.panes', () => ({ value: [] }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('prompt.fill', (_$, e) => {
    w.fills.push(e.text)
    return { isFilled: true }
  })
  on('store.get', (_$, e) => ({ value: w.store.get(e.key) }))
  on('store.set', (_$, e) => {
    w.store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    w.store.delete(e.key)
    return { value: undefined }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  return { w, clock }
}

const PANE = {
  title: 'Compass',
  isFocused: false,
  bodyColumns: 48,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
} as const

const mountPane = ($: Engine, surface: (typeof SURFACES)[number] = 'terminal', bodyColumns = 48) =>
  $.ui.mount({
    plugin: 'compass',
    surface,
    component: 'Pane',
    requestId: 'compass',
    props: { ...PANE, bodyColumns },
    viewport: { columns: bodyColumns, rows: 40, isFullscreen: true },
  })

const startSession = ($: Engine) => $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

const finishTurn = async ($: Engine, clock: { settle: () => Promise<void> }, agentId?: string) => {
  await $.turn.complete({ answer: 'Done.', durationMs: 5, isAborted: false, turnId: 'turn-1', reason: 'answer', agentId })
  await clock.settle()
}

const GOAL_REPLY = JSON.stringify({
  noChange: false,
  sessionType: 'design',
  goal: { text: 'Make the extractor retry on transient failures.', drift: null },
  topics: [{ name: 'Retries', headline: 'Backoff, at most three tries' }],
  items: [
    { kind: 'decision', text: 'Use exponential backoff', topic: 'Retries' },
    { kind: 'assumption', text: 'Retry at most three times', topic: 'Retries' },
  ],
  removed: [],
  visual: { form: 'dataflow', markdown: '```\ncall -> fail -> wait -> call\n```' },
})

type MountedPane = Awaited<ReturnType<typeof mountPane>>

/** One `glyph text` entry per item row, without its new/changed marker and revisions button. */
const itemLabels = async (ui: MountedPane) => {
  const starts = [
    ...new Set((await ui.findAll({ type: 'Box' })).map(box => box.text).filter(text => /^[?✓✗]./.test(text) && !/^([?✓✗]\d+)+$/.test(text))),
  ]
  return starts
    .filter(text => !starts.some(other => other !== text && text.includes(other)))
    .map(text => text.replace(/^(.)/, '$1 ').replace(/( new| changed)?(\d+ revs?[▾▴])?$/, ''))
}

const topicRows = async (ui: MountedPane) =>
  (await ui.findAll({ type: 'Button' })).filter(button => button.key?.startsWith('topic:')).map(button => String(button.props.label))

/** The count glyphs beside the topic rows, in drawing order. */
const topicTallies = async (ui: MountedPane) => (await textsOf(ui)).filter(text => /^[✓?✗]\d+$/.test(text))

/** The topic rows of a fresh mount, which it unmounts again. */
const rowsAt = async ($: Engine, bodyColumns = 48) => {
  const ui = await mountPane($, 'terminal', bodyColumns)
  const rows = await topicRows(ui)
  await ui.unmount()
  return rows
}

const textsOf = async (ui: MountedPane, type = 'Text') => (await ui.findAll({ type })).map(found => found.text)

/** Presses a button on a fresh mount and unmounts, so the next mount draws what the press changed. */
const press = async ($: Engine, key: string, surface: (typeof SURFACES)[number] = 'terminal', bodyColumns = 48) => {
  const ui = await mountPane($, surface, bodyColumns)
  await ui.press({ key })
  await ui.unmount()
}

test('a trivial turn runs no update; an edit turn does', async ($, on) => {
  const { w, clock } = world(on, { messages: chatTurn, replies: [GOAL_REPLY] })
  await startSession($)
  await finishTurn($, clock)
  expect(w.requests).toHaveLength(0)

  w.messages = editTurn
  await finishTurn($, clock)
  expect(w.requests).toHaveLength(1)
})

test('a subagent turn is ignored', async ($, on) => {
  const { w, clock } = world(on, { replies: [GOAL_REPLY] })
  await startSession($)
  await finishTurn($, clock, 'agent-7')
  expect(w.requests).toHaveLength(0)
})

test('the updater model option picks sonnet at low effort, haiku, or a fork', async ($, on) => {
  const { w, clock } = world(on, { replies: [GOAL_REPLY] })
  await startSession($)
  await finishTurn($, clock)
  expect(w.requests[0]).toMatchObject({ model: 'sonnet', effort: 'low' })
  expect(w.requests[0]?.prompt).toContain('NEW_MESSAGES')
  expect(w.requests[0]?.prompt).toContain('tool Edit file_path=/src/a.ts')
})

test('haiku is asked without an effort', { options: { updaterModel: 'haiku' } }, async ($, on) => {
  const { w, clock } = world(on, { replies: [GOAL_REPLY] })
  await startSession($)
  await finishTurn($, clock)
  expect(w.requests[0]?.model).toBe('haiku')
  expect(w.requests[0]?.effort).toBeUndefined()
})

test('fork sends the state and instructions but not the delta', { options: { updaterModel: 'fork' } }, async ($, on) => {
  const { w, clock } = world(on, { replies: [GOAL_REPLY] })
  await startSession($)
  await finishTurn($, clock)
  expect(w.requests).toHaveLength(0)
  expect(w.forks[0]?.prompt).toContain('PREVIOUS_STATE')
  expect(w.forks[0]?.prompt).not.toContain('tool Edit')
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Markdown', text: /extractor retry/ })).toBeDefined()
})

test('a fork with nothing to fork keeps the state and says so', { options: { updaterModel: 'fork' } }, async ($, on) => {
  const { clock } = world(on, { forkReply: 'nothing-to-fork' })
  await startSession($)
  await finishTurn($, clock)
  const ui = await mountPane($)
  expect((await textsOf(ui)).some(text => /nothing to fork/.test(text))).toBe(true)
  expect(await ui.find({ type: 'Markdown' })).toBeUndefined()
})

test('invalid output and API errors leave the state untouched and show a dim error', async ($, on) => {
  const { w, clock } = world(on, { replies: [GOAL_REPLY, 'sorry, no json', 'API_ERROR'] })
  await startSession($)
  await finishTurn($, clock)

  await finishTurn($, clock)
  let ui = await mountPane($)
  expect((await textsOf(ui)).some(text => /not return valid JSON/.test(text))).toBe(true)
  expect(await ui.find({ type: 'Markdown', text: /extractor retry/ })).toBeDefined()
  await ui.unmount()

  await finishTurn($, clock)
  ui = await mountPane($)
  expect((await textsOf(ui)).some(text => /API error 529/.test(text))).toBe(true)
  expect(await ui.find({ type: 'Markdown', text: /extractor retry/ })).toBeDefined()
  expect(w.requests).toHaveLength(3)
})

test('only new rows go to the updater after a successful update', async ($, on) => {
  const { w, clock } = world(on, { replies: [GOAL_REPLY, '{"noChange":true}'] })
  await startSession($)
  await finishTurn($, clock)
  w.messages = [...editTurn, user('now add logging'), assistant('', ['Write']), toolResultRow('Write0', 'ok')]
  await finishTurn($, clock)
  expect(w.requests[0]?.prompt).toContain('add a retry')
  expect(w.requests[1]?.prompt).not.toContain('add a retry')
  expect(w.requests[1]?.prompt).toContain('now add logging')
})

test('the pane shows goal, topic rows, visual and the history stepper', async ($, on) => {
  const { clock } = world(on, {
    replies: [
      GOAL_REPLY,
      JSON.stringify({ goal: { text: 'Retry, and log each failure.', drift: 'chatting about lunch' } }),
    ],
  })
  await startSession($)
  await finishTurn($, clock)
  await finishTurn($, clock)

  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect(await ui.find({ type: 'Markdown', text: /log each failure/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /drift\? chatting about lunch/ })).toBeDefined()
    expect(await topicRows(ui)).toEqual(['▸ Retries'])
    expect(await itemLabels(ui)).toEqual([])
    expect(await ui.find({ type: 'Text', text: 'v2/2' })).toBeDefined()
    expect(await ui.find({ type: 'Markdown', text: /call -> fail/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'new' })).toBeUndefined()
    await ui.press({ key: 'goalIndex:prev' })
    await ui.unmount()

    const stepped = await mountPane($, surface)
    expect(await stepped.find({ type: 'Markdown', text: /extractor retry/ })).toBeDefined()
    await stepped.press({ key: 'goalIndex:next' })
    await stepped.unmount()
  }
})

test('a new update puts the steppers back on the latest version', async ($, on) => {
  const { clock } = world(on, {
    replies: [GOAL_REPLY, '{"goal":{"text":"Second goal.","drift":null}}', '{"goal":{"text":"Third goal.","drift":null}}'],
  })
  await startSession($)
  await finishTurn($, clock)
  await finishTurn($, clock)

  const ui = await mountPane($)
  await ui.press({ key: 'goalIndex:prev' })
  await ui.unmount()
  const stepped = await mountPane($)
  expect(await stepped.find({ type: 'Markdown', text: /extractor retry/ })).toBeDefined()
  await stepped.unmount()

  await finishTurn($, clock)
  const latest = await mountPane($)
  expect(await latest.find({ type: 'Markdown', text: /Third goal/ })).toBeDefined()
  expect(await latest.find({ type: 'Text', text: 'v3/3' })).toBeDefined()
})

test('an update still running blocks the next one, and a dead claim is taken over', async ($, on) => {
  const { w, clock } = world(on, { replies: [GOAL_REPLY], isModelHanging: true })
  await startSession($)
  await finishTurn($, clock)
  await finishTurn($, clock)
  expect(w.requests).toHaveLength(1)
  expect(await (await mountPane($)).find({ type: 'Text', text: 'updating…' })).toBeDefined()

  await clock.advance(200_000)
  await finishTurn($, clock)
  expect(w.requests).toHaveLength(2)
})

test('the width the pane drew into is the column budget of the next update', async ($, on) => {
  const { w, clock } = world(on, { replies: [GOAL_REPLY] })
  await startSession($)
  await mountPane($, 'terminal', 61)
  await clock.settle()
  await finishTurn($, clock)
  expect(w.requests[0]?.prompt).toContain('COLUMNS: 61')
})

test('items from the latest update are marked new and a revised one shows its trail', async ($, on) => {
  const { clock } = world(on, {
    replies: [
      GOAL_REPLY,
      JSON.stringify({
        items: [
          { id: 'i2', kind: 'decision', text: 'Use jittered backoff', reason: 'user asked' },
          { kind: 'decision', text: 'Cap delay at 30s', topic: 'Retries' },
        ],
      }),
    ],
  })
  await startSession($)
  await finishTurn($, clock)
  await finishTurn($, clock)
  await press($, 'topic:t1')

  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect(await ui.findAll({ type: 'Text', text: /^ new$/ })).toHaveLength(1)
    expect(await ui.findAll({ type: 'Text', text: /^ changed$/ })).toHaveLength(1)
    expect((await ui.find({ type: 'Button', key: 'revs:i2' }))?.props.label).toBe('1 rev▾')
    await ui.press({ key: 'revs:i2' })
    await ui.unmount()

    const open = await mountPane($, surface)
    expect(await open.find({ type: 'Text', text: /v1: Use exponential backoff \(user asked\)/ })).toBeDefined()
    await open.press({ key: 'revs:i2' })
    await open.unmount()
  }
})

test('a topic row toggles its items open and shut, and never fills the prompt', async ($, on) => {
  const { w, clock } = world(on, { replies: [GOAL_REPLY] })
  await startSession($)
  await finishTurn($, clock)

  for (const surface of SURFACES) {
    await press($, 'topic:t1', surface)
    const open = await mountPane($, surface)
    expect(await topicRows(open)).toEqual(['▾ Retries'])
    expect(await itemLabels(open)).toEqual(['? Retry at most three times', '✓ Use exponential backoff'])
    await open.unmount()

    await press($, 'topic:t1', surface)
    const shut = await mountPane($, surface)
    expect(await itemLabels(shut)).toEqual([])
    await shut.unmount()
  }
  expect(w.fills).toEqual([])
})

test('pressing an item row fills the prompt with a reply to it', async ($, on) => {
  const { w, clock } = world(on, { replies: [GOAL_REPLY] })
  await startSession($)
  await finishTurn($, clock)
  await press($, 'topic:t1')

  for (const surface of SURFACES) {
    await press($, 'item:i3', surface)
    await press($, 'item:i2', surface)
  }
  expect(w.fills).toEqual([
    'Re: assumed "Retry at most three times" — ',
    'Re: decided "Use exponential backoff" — ',
    'Re: assumed "Retry at most three times" — ',
    'Re: decided "Use exponential backoff" — ',
  ])
})

test('the section header names the session type and counts settled and needs-review items', async ($, on) => {
  const { clock } = world(on, { replies: [GOAL_REPLY] })
  await startSession($)
  await finishTurn($, clock)

  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect((await ui.find({ type: 'Button', key: 'toggle:decisions' }))?.props.label).toBe('▼ Decisions · design')
    expect(await topicTallies(ui)).toEqual(['✓1', '?1'])
    expect((await ui.find({ type: 'Button', key: 'filter:needs-review' }))?.props.label).toBe('needs review 1')
    await ui.unmount()
  }
})

const FILTER_REPLY = JSON.stringify({
  goal: { text: 'G', drift: null },
  topics: [
    { name: 'Retries', headline: 'Backoff' },
    { name: 'Logging', headline: 'Every failure' },
  ],
  items: [
    { kind: 'decision', text: 'Backoff: exponential', topic: 'Retries' },
    { kind: 'assumption', text: 'Tries: three', topic: 'Retries' },
    { kind: 'decision', text: 'Log: every failure', topic: 'Logging' },
  ],
})

test('the filter is exclusive: needs review keeps only open topics and items, expanded; an emptied filter falls back to all', async ($, on) => {
  const { clock } = world(on, {
    replies: [FILTER_REPLY, JSON.stringify({ items: [{ id: 'i4', kind: 'decision', text: 'Tries: three' }] })],
  })
  await startSession($)
  await finishTurn($, clock)

  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    const filters = (await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('filter:'))
    expect(filters.map(f => [f.key, f.props.label])).toEqual([
      ['filter:all', 'all'],
      ['filter:needs-review', 'needs review 1'],
    ])
    expect(filters.filter(f => f.props.plain === undefined).map(f => f.key)).toEqual(['filter:all'])
    expect(await topicRows(ui)).toHaveLength(2)
    expect(await itemLabels(ui)).toEqual([])
    await ui.press({ key: 'filter:needs-review' })
    await ui.unmount()

    const review = await mountPane($, surface)
    expect(await topicRows(review)).toEqual(['▾ Retries'])
    expect(await itemLabels(review)).toEqual(['? Tries: three'])
    const picked = (await review.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('filter:'))
    expect(picked.filter(f => f.props.plain === undefined).map(f => f.key)).toEqual(['filter:needs-review'])
    await review.press({ key: 'filter:all' })
    await review.unmount()
  }

  await press($, 'filter:needs-review')
  await finishTurn($, clock)
  const fallen = await mountPane($)
  expect(await topicRows(fallen)).toHaveLength(2)
  expect((await topicRows(fallen))[0]).toMatch(/^▸ /)
})

test('a topic opened by needs review can be collapsed and reopened', async ($, on) => {
  const { clock } = world(on, { replies: [FILTER_REPLY] })
  await startSession($)
  await finishTurn($, clock)
  await press($, 'filter:needs-review')

  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    const topicKey = (await ui.findAll({ type: 'Button' })).find(b => b.key?.startsWith('topic:'))?.key ?? ''
    expect(await topicRows(ui)).toEqual(['▾ Retries'])
    await ui.press({ key: topicKey })
    await ui.unmount()

    const collapsed = await mountPane($, surface)
    expect(await topicRows(collapsed)).toEqual(['▸ Retries'])
    expect(await itemLabels(collapsed)).toEqual([])
    await collapsed.press({ key: topicKey })
    await collapsed.unmount()

    const reopened = await mountPane($, surface)
    expect(await topicRows(reopened)).toEqual(['▾ Retries'])
    await reopened.unmount()
  }
})

test('topic rows list topics with needs-review items first, then the most recently changed', async ($, on) => {
  const { clock } = world(on, {
    replies: [
      JSON.stringify({
        goal: { text: 'G', drift: null },
        topics: [
          { name: 'Alpha', headline: '' },
          { name: 'Beta', headline: '' },
          { name: 'Gamma', headline: '' },
        ],
        items: [
          { kind: 'decision', text: 'Alpha: one', topic: 'Alpha' },
          { kind: 'assumption', text: 'Beta: one', topic: 'Beta' },
          { kind: 'decision', text: 'Gamma: one', topic: 'Gamma' },
        ],
      }),
      JSON.stringify({ items: [{ id: 'i6', kind: 'decision', text: 'Gamma: two' }] }),
    ],
  })
  await startSession($)
  await finishTurn($, clock)
  expect(await rowsAt($)).toEqual(['▸ Beta', '▸ Alpha', '▸ Gamma'])
  await finishTurn($, clock)
  expect(await rowsAt($)).toEqual(['▸ Beta', '▸ Gamma', '▸ Alpha'])
})

test('a long topic name is cut with an ellipsis so its counts keep their room', async ($, on) => {
  const { clock } = world(on, {
    replies: [
      JSON.stringify({
        goal: { text: 'G', drift: null },
        topics: [{ name: 'Retry transient extractor failures', headline: 'Backoff' }],
        items: [{ kind: 'assumption', text: 'Tries: three', topic: 'Retry transient extractor failures' }],
      }),
    ],
  })
  await startSession($)
  await finishTurn($, clock)

  const [row] = await rowsAt($, 30)
  expect(row?.length).toBeLessThanOrEqual(30 - '?1 '.length)
  expect(row).toContain('…')
  expect((await rowsAt($, 200))[0]).toBe('▸ Retry transient extractor failures')
})

test('a topic headline is its own dim line under the topic row, and counts sit beside the name', async ($, on) => {
  const { clock } = world(on, { replies: [GOAL_REPLY] })
  await startSession($)
  await finishTurn($, clock)

  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect(await topicRows(ui)).toEqual(['▸ Retries'])
    const headline = await ui.find({ type: 'Text', text: 'Backoff, at most three tries' })
    expect(headline?.props.dimColor).toBe(true)
    expect(headline?.props.wrap).toBe('wrap')
    expect(await ui.find({ type: 'Text', text: /Retries.*Backoff/ })).toBeUndefined()
    expect((await ui.find({ type: 'Text', text: '✓1' }))?.props.color).toBe('green')
    expect((await ui.find({ type: 'Text', text: '?1' }))?.props.color).toBe('yellow')
    await ui.unmount()
  }
})

test('an update moves an item between topics and a topic keeps its id when renamed', async ($, on) => {
  const { clock } = world(on, {
    replies: [
      FILTER_REPLY,
      JSON.stringify({
        topics: [{ id: 't1', name: 'Retry policy', headline: 'Jittered' }],
        items: [{ id: 'i5', topic: 't1' }],
      }),
    ],
  })
  await startSession($)
  await finishTurn($, clock)
  await finishTurn($, clock)
  await press($, 'topic:t1')

  const ui = await mountPane($)
  expect(await topicRows(ui)).toEqual(['▾ Retry policy'])
  expect((await itemLabels(ui)).sort()).toEqual(['? Tries: three', '✓ Backoff: exponential', '✓ Log: every failure'])
})

test('items with no topic show under Other, until the updater assigns one', async ($, on) => {
  const { w, clock } = world(on, {
    store: new Map<string, unknown>([['session:session-1', seeded()]]),
    replies: [JSON.stringify({ topics: [{ name: 'Retries', headline: 'Backoff' }], items: [{ id: 'i1', topic: 'Retries' }, { id: 'i2', topic: 'Retries' }] })],
  })
  await startSession($)
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect(await topicRows(ui)).toEqual(['▸ Other'])
    await ui.unmount()
  }
  await press($, 'topic:other')
  const opened = await mountPane($)
  expect(await itemLabels(opened)).toEqual(['? Retry at most three times', '✓ Use exponential backoff'])
  await opened.unmount()

  await finishTurn($, clock)
  expect(w.requests[0]?.prompt).toContain('"topic":null')
  expect(await rowsAt($)).toEqual(['▸ Retries'])
})

test('the session type is inferred and stored, and its section title and kinds follow', async ($, on) => {
  const { w, clock } = world(on, {
    replies: [
      JSON.stringify({
        sessionType: 'debugging',
        goal: { text: 'G', drift: null },
        topics: [{ name: 'Cache', headline: 'Stale reads' }],
        items: [{ kind: 'decision', text: 'Reads: hit the stale cache', topic: 'Cache' }],
      }),
      JSON.stringify({ items: [{ kind: 'hypothesis', text: 'TTL: too long', topic: 'Cache' }, { kind: 'ruled_out', text: 'Lock: not contended', topic: 'Cache' }] }),
    ],
  })
  await startSession($)
  await finishTurn($, clock)
  expect(w.requests[0]?.system).toContain('Infer it from the conversation')
  expect((w.store.get('session:session-1') as CompassSession).sessionType).toBe('debugging')

  await finishTurn($, clock)
  expect(w.requests[1]?.prompt).toContain('ENABLED_KINDS: confirmed, hypothesis, ruled_out')
  expect(w.requests[1]?.prompt).toContain('"sessionType":"debugging"')

  for (const surface of SURFACES) {
    await press($, 'topic:t1', surface)
    const ui = await mountPane($, surface)
    expect((await ui.find({ type: 'Button', key: 'toggle:decisions' }))?.props.label).toBe('▼ Hypotheses · debugging')
    expect(await topicRows(ui)).toEqual(['▾ Cache'])
    expect(await itemLabels(ui)).toEqual(['✗ Lock: not contended', '? TTL: too long', '✓ Reads: hit the stale cache'])
    await ui.unmount()
    await press($, 'topic:t1', surface)
  }
})

test('items of a kind from another session type display by their class and reply with their own label', async ($, on) => {
  const stored = { ...applyUpdate(emptySession(), update({
    sessionType: 'design',
    topics: [{ name: 'Cache', headline: '' }],
    items: [
      { kind: 'decision', text: 'Reads: cached', topic: 'Cache' },
      { kind: 'assumption', text: 'TTL: sixty seconds', topic: 'Cache' },
    ],
  }), ctx()), sessionType: 'debugging' as const }
  const { w } = world(on, { store: new Map<string, unknown>([['session:session-1', stored]]) })
  await startSession($)
  await press($, 'topic:t1')

  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect((await ui.find({ type: 'Button', key: 'toggle:decisions' }))?.props.label).toBe('▼ Hypotheses · debugging')
    expect(await itemLabels(ui)).toEqual(['? TTL: sixty seconds', '✓ Reads: cached'])
    await ui.press({ key: 'item:i3' })
    await ui.unmount()
  }
  expect(w.fills).toEqual(['Re: assumed "TTL: sixty seconds" — ', 'Re: assumed "TTL: sixty seconds" — '])
})

test('a configured session type overrides inference, shapes the prompt and the labels', { options: { sessionType: 'review' } }, async ($, on) => {
  const { w, clock } = world(on, {
    replies: [
      JSON.stringify({
        sessionType: 'design',
        goal: { text: 'G', drift: null },
        topics: [{ name: 'Security', headline: 'One open issue' }],
        items: [
          { kind: 'finding', text: 'Auth: token never expires', topic: 'Security' },
          { kind: 'resolved', text: 'Input: validated', topic: 'Security' },
        ],
      }),
    ],
  })
  await startSession($)
  await finishTurn($, clock)
  expect(w.requests[0]?.system).toContain('fixed as "review"')
  expect(w.requests[0]?.prompt).toContain('ENABLED_KINDS: finding, resolved')
  expect((w.store.get('session:session-1') as CompassSession).sessionType).toBe('review')

  await press($, 'topic:t1')
  const ui = await mountPane($)
  expect((await ui.find({ type: 'Button', key: 'toggle:decisions' }))?.props.label).toBe('▼ Findings · review')
  expect(await itemLabels(ui)).toEqual(['✓ Input: validated', '? Auth: token never expires'])
  await ui.press({ key: 'item:i2' })
  expect(w.fills).toEqual(['Re: finding "Auth: token never expires" — '])
})

test('opt-in kinds are left out of the prompt while their switch is off', async ($, on) => {
  const { w, clock } = world(on, { replies: [GOAL_REPLY] })
  await startSession($)
  await finishTurn($, clock)
  expect(w.requests[0]?.prompt).toContain('ENABLED_KINDS: decision, assumption\n')
  expect(await topicTallies(await mountPane($))).toEqual(['✓1', '?1'])
})

test('rejected items are hidden while their switch is off and shown when it is on', async ($, on) => {
  const stored = applyUpdate(
    emptySession(),
    update({ topics: [{ name: 'Cache', headline: '' }], items: [{ kind: 'decision', text: 'Reads: cached', topic: 'Cache' }] }),
    ctx(),
  )
  const withRejected = {
    ...stored,
    items: [...stored.items, { ...stored.items[0], id: 'i9', kind: 'rejected', text: 'Reads: uncached' }],
  }
  world(on, { store: new Map<string, unknown>([['session:session-1', withRejected]]) })
  await startSession($)
  await press($, 'topic:t1')
  expect(await itemLabels(await mountPane($))).toEqual(['✓ Reads: cached'])
})

test('rejected items are shown when trackRejected is on', { options: { trackRejected: true } }, async ($, on) => {
  const stored = applyUpdate(
    emptySession(),
    update({ topics: [{ name: 'Cache', headline: '' }], items: [{ kind: 'decision', text: 'Reads: cached', topic: 'Cache' }] }),
    ctx(),
  )
  const withRejected = {
    ...stored,
    items: [...stored.items, { ...stored.items[0], id: 'i9', kind: 'rejected', text: 'Reads: uncached' }],
  }
  world(on, { store: new Map<string, unknown>([['session:session-1', withRejected]]) })
  await startSession($)
  await press($, 'topic:t1')
  expect(await itemLabels(await mountPane($))).toEqual(['✗ Reads: uncached', '✓ Reads: cached'])
})

test('debugging lists ruled out items without any switch', { options: { sessionType: 'debugging' } }, async ($, on) => {
  const { w, clock } = world(on, {
    replies: [
      JSON.stringify({
        goal: { text: 'G', drift: null },
        topics: [{ name: 'Cache', headline: '' }],
        items: [{ kind: 'ruled_out', text: 'Lock: not contended', topic: 'Cache' }],
      }),
    ],
  })
  await startSession($)
  await finishTurn($, clock)
  expect(w.requests[0]?.system).toContain('kind "ruled_out"')
  await press($, 'topic:t1')
  expect(await itemLabels(await mountPane($))).toEqual(['✗ Lock: not contended'])
})

test('the old Accept, Dismiss and Challenge buttons are gone', async ($, on) => {
  const { clock } = world(on, { replies: [GOAL_REPLY] })
  await startSession($)
  await finishTurn($, clock)
  const buttons = await (await mountPane($)).findAll({ type: 'Button' })
  expect(buttons.map(button => button.props.label).filter(label => /Accept|Dismiss|Challenge/.test(String(label)))).toEqual([])
})

const LONG_ITEM = 'Retry transient extractor failures with exponential backoff and a hard cap on total delay'

const manyReply = (count: number) =>
  JSON.stringify({
    goal: { text: 'G', drift: null },
    topics: [{ name: 'Things', headline: 'Many' }],
    items: Array.from({ length: count }, (_, i) => ({ kind: 'assumption', text: `Assumption number ${i + 1} about the thing`, topic: 'Things' })),
  })

test('an item keeps its full text in a wrapping Text, with a dim marker, whatever the width', async ($, on) => {
  const { clock } = world(on, {
    replies: [
      JSON.stringify({ goal: { text: 'G', drift: null }, topics: [{ name: 'Retries', headline: '' }], items: [{ kind: 'assumption', text: LONG_ITEM, topic: 'Retries' }] }),
      JSON.stringify({ items: [{ id: 'i2', kind: 'assumption', text: `${LONG_ITEM} per call`, reason: 'tightened' }] }),
    ],
  })
  await startSession($)
  await finishTurn($, clock)
  await finishTurn($, clock)
  await press($, 'topic:t1')

  for (const surface of SURFACES) {
    for (const width of [30, 48, 200]) {
      const ui = await mountPane($, surface, width)
      expect(await itemLabels(ui)).toEqual([`? ${LONG_ITEM} per call`])
      const body = await ui.find({ type: 'Text', text: `${LONG_ITEM} per call changed` })
      expect(body?.props.wrap).toBe('wrap')
      expect((await ui.find({ type: 'Text', text: /^ changed$/ }))?.props.dimColor).toBe(true)
      expect((await ui.find({ type: 'Button', key: 'item:i2' }))?.props.label).toBe('?')
      expect((await ui.find({ type: 'Button', key: 'revs:i2' }))?.props.label).toBe('1 rev▾')
      await ui.unmount()
    }
  }
})

test('items and topics are separated by blank rows', async ($, on) => {
  const { clock } = world(on, { replies: [GOAL_REPLY] })
  await startSession($)
  await finishTurn($, clock)
  await press($, 'topic:t1')

  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    const spacedItems = (await ui.findAll({ type: 'Box' })).filter(box => box.props.rowGap === 1 && /^[?✓✗]/.test(box.text))
    expect(spacedItems.length).toBeGreaterThan(0)
    const root = (await ui.findAll({ type: 'Box' }))[0]
    expect(root?.props.rowGap).toBe(1)
    await ui.unmount()
  }
})

test('a topic shows its newest eight items, then +N more expands to all and show less folds back', async ($, on) => {
  const { clock } = world(on, { replies: [manyReply(10)] })
  await startSession($)
  await finishTurn($, clock)
  await press($, 'topic:t1')

  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    const labels = await itemLabels(ui)
    expect(labels).toHaveLength(8)
    expect(labels[0]).toBe('? Assumption number 10 about the thing')
    expect(labels[7]).toBe('? Assumption number 3 about the thing')
    expect((await ui.find({ type: 'Button', key: 'more:t1' }))?.props.label).toBe('+2 more')
    await ui.press({ key: 'more:t1' })
    await ui.unmount()

    const open = await mountPane($, surface)
    expect(await itemLabels(open)).toHaveLength(10)
    expect((await open.find({ type: 'Button', key: 'more:t1' }))?.props.label).toBe('show less')
    await open.press({ key: 'more:t1' })
    await open.unmount()
  }
})

test('eight items or fewer show no +N more row', async ($, on) => {
  const { clock } = world(on, { replies: [manyReply(8)] })
  await startSession($)
  await finishTurn($, clock)
  await press($, 'topic:t1')
  const ui = await mountPane($)
  expect(await itemLabels(ui)).toHaveLength(8)
  expect(await ui.find({ type: 'Button', key: 'more:t1' })).toBeUndefined()
})

test('items stored as accepted or dismissed by the old version load without a crash', async ($, on) => {
  const base = seeded()
  const legacy = {
    ...base,
    items: [
      { ...base.items[0], kind: 'decision', status: 'accepted' },
      { ...base.items[1], status: 'dismissed' },
    ],
  }
  world(on, { store: new Map<string, unknown>([['session:session-1', legacy]]) })
  await startSession($)
  await press($, 'topic:other')
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect(await topicRows(ui)).toEqual(['▾ Other'])
    expect(await itemLabels(ui)).toEqual(['✓ Use exponential backoff'])
    await ui.unmount()
  }
})

test('the banner appears when files were edited and no decision was recorded', async ($, on) => {
  const { clock } = world(on, { replies: ['{"goal":{"text":"Fix the bug.","drift":null}}'] })
  await startSession($)
  await finishTurn($, clock)

  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    expect(await ui.find({ type: 'Text', text: 'No decisions yet — 1 turn of work' })).toBeDefined()
    await ui.unmount()
  }
})

test('no banner before any file was edited, nor once a decision exists', async ($, on) => {
  const { w, clock } = world(on, { messages: chatTurn, replies: [GOAL_REPLY] })
  await startSession($)
  const quiet = await mountPane($)
  expect(await quiet.find({ type: 'Text', text: /No decisions yet/ })).toBeUndefined()
  await quiet.unmount()

  w.messages = editTurn
  await finishTurn($, clock)
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: /No decisions yet/ })).toBeUndefined()
})

test('refresh bypasses the gate', async ($, on) => {
  const { w, clock } = world(on, { messages: chatTurn, replies: [GOAL_REPLY] })
  await startSession($)
  await finishTurn($, clock)
  expect(w.requests).toHaveLength(0)

  const ui = await mountPane($)
  await ui.press({ key: 'refresh' })
  await clock.settle()
  expect(w.requests).toHaveLength(1)
})

test('sections collapse and expand', async ($, on) => {
  const { clock } = world(on, { replies: [GOAL_REPLY] })
  await startSession($)
  await finishTurn($, clock)

  let ui = await mountPane($)
  expect(await ui.find({ type: 'Markdown', text: /call -> fail/ })).toBeDefined()
  await ui.press({ key: 'toggle:visual' })
  await ui.unmount()
  ui = await mountPane($)
  expect(await ui.find({ type: 'Markdown', text: /call -> fail/ })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'toggle:visual' })).toBeDefined()
})

test('state is saved under the session id and restored on the next start', async ($, on) => {
  const { w, clock } = world(on, { replies: [GOAL_REPLY] })
  await startSession($)
  await finishTurn($, clock)
  const saved = w.store.get('session:session-1') as CompassSession
  expect(saved.goal?.text).toMatch(/extractor retry/)
  expect(saved.snapshots).toHaveLength(1)
  expect(saved.cursor).toBe(editTurn.length)
})

test('a resumed session finds its saved state', async ($, on) => {
  const store = new Map<string, unknown>([['session:session-1', seeded()]])
  world(on, { store })
  await startSession($)
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Markdown', text: /Add retries/ })).toBeDefined()
  expect(await topicRows(ui)).toEqual(['▸ Other'])
})

test('another session id starts empty', async ($, on) => {
  const store = new Map<string, unknown>([['session:session-1', seeded()]])
  world(on, { store, sessionId: 'session-2' })
  await startSession($)
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Markdown' })).toBeUndefined()
})

test('a /clear wipes the saved state and empties the pane', async ($, on) => {
  const { w, clock } = world(on, { replies: [GOAL_REPLY] })
  await startSession($)
  await finishTurn($, clock)
  expect(w.store.has('session:session-1')).toBe(true)

  await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { sessionId: 'session-1' } as never })
  expect(w.store.has('session:session-1')).toBe(false)
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Markdown' })).toBeUndefined()
})

test('the oldest saved sessions are evicted past twenty', async ($, on) => {
  const { w, clock } = world(on, { replies: [GOAL_REPLY] })
  const entries = Array.from({ length: 20 }, (_, i) => ({ id: `old-${i}`, at: i }))
  for (const entry of entries) w.store.set(`session:${entry.id}`, emptySession())
  w.store.set('index', entries)
  await startSession($)
  await finishTurn($, clock)
  expect(w.store.has('session:old-0')).toBe(false)
  expect(w.store.has('session:old-1')).toBe(true)
  expect(w.store.has('session:session-1')).toBe(true)
})

test('the pane opens at session start unless autoOpen is off', async ($, on) => {
  const { w } = world(on)
  await startSession($)
  expect(w.opened).toEqual(['compass'])
})

test('autoOpen off keeps the pane closed', { options: { autoOpen: false } }, async ($, on) => {
  const { w } = world(on)
  await startSession($)
  expect(w.opened).toEqual([])
})

test('open questions are asked for only when the option is on', { options: { trackOpenQuestions: true } }, async ($, on) => {
  const { w, clock } = world(on, {
    replies: [
      JSON.stringify({
        goal: { text: 'G', drift: null },
        topics: [{ name: 'Queue', headline: '' }],
        items: [{ kind: 'open_question', text: 'Queue: which one?', topic: 'Queue' }],
      }),
    ],
  })
  await startSession($)
  await finishTurn($, clock)
  expect(w.requests[0]?.prompt).toContain('ENABLED_KINDS: decision, assumption, open_question')
  expect(await rowsAt($)).toEqual(['▸ Queue'])
  await press($, 'topic:t1')
  expect(await itemLabels(await mountPane($))).toEqual(['? Queue: which one?'])
})

test('the old tabs are gone', async ($, on) => {
  const { clock } = world(on, { replies: [GOAL_REPLY] })
  await startSession($)
  await finishTurn($, clock)
  const keys = (await (await mountPane($)).findAll({ type: 'Button' })).map(button => button.key)
  expect(keys.filter(key => key?.startsWith('tab:'))).toEqual([])
})

test('the prompt tells the updater to rewrite items over sixty characters and keep headlines short', () => {
  const { system } = buildPrompt({
    session: emptySession(),
    bodyColumns: 48,
    gates: NO_GATES,
    sessionTypeSetting: 'auto',
    delta: undefined,
  })
  expect(system).toContain('at most 60 characters')
  expect(system).toMatch(/active item in PREVIOUS_STATE whose text is over 60 characters must be rewritten/)
  expect(system).toContain('"subject: choice"')
})

