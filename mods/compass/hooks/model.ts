/**
 * Pure logic of compass: the session types and their item kinds, the turn
 * gate, the updater's prompt, parsing of its answer, merging that answer into
 * the session state and grouping items under their topics.
 */
import type { SessionMessage } from 'claude-code'

import type {
  CompassGoal,
  CompassItem,
  CompassItemKind,
  CompassSession,
  CompassSessionType,
  CompassSessionTypeSetting,
  CompassSnapshot,
  CompassTopic,
  CompassView,
  CompassVisual,
} from '../types'

export const DEFAULT_BODY_COLUMNS = 48
export const MAX_SNAPSHOTS = 50
export const MIN_PROSE_CHARS = 400
const MAX_DELTA_CHARS = 40_000
const MAX_RESULT_CHARS = 300
const MAX_INPUT_CHARS = 120
const MAX_MESSAGE_TEXT_CHARS = 2000
const MAX_ITEM_CHARS = 200
const MAX_TOPIC_NAME_CHARS = 40
const MAX_TOPIC_HEADLINE_CHARS = 100
const MAX_GOAL_CHARS = 400
const MAX_VISUAL_CHARS = 6000
const SESSION_BUDGET_CHARS = 120_000
const SAME_ITEM_SIMILARITY = 0.7

const FILE_EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit', 'MultiEdit']
const SUMMARY_INPUT_KEYS = ['file_path', 'path', 'command', 'pattern', 'query', 'url', 'description', 'prompt', 'skill']

export type KindClass = 'settled' | 'needs-review' | 'dropped'

type OptionGate = 'trackOpenQuestions' | 'trackRejected'

/** The config switches that turn the opt-in kinds on. */
export type Gates = Record<OptionGate, boolean>

export type KindSpec = {
  kind: CompassItemKind
  glyph: string
  /** How the kind reads in a reply to an item. */
  label: string
  kindClass: KindClass
  /** What the updater is told the kind means. */
  meaning: string
  gate?: OptionGate
}

type SessionTypeSpec = {
  title: string
  /** What the topics of this session type are, for the updater. */
  topicsAre: string
  kinds: readonly KindSpec[]
}

const DECISION_KINDS: readonly KindSpec[] = [
  { kind: 'decision', glyph: '✓', label: 'decided', kindClass: 'settled', meaning: 'something the user and assistant settled, or the user directed.' },
  {
    kind: 'assumption',
    glyph: '?',
    label: 'assumed',
    kindClass: 'needs-review',
    meaning: 'a choice the assistant made silently, without the user explicitly agreeing. Silent assumptions are the point of the panel: surface them.',
  },
  { kind: 'open_question', glyph: '?', label: 'open question', kindClass: 'needs-review', meaning: 'a question raised and left unanswered.', gate: 'trackOpenQuestions' },
  { kind: 'rejected', glyph: '✗', label: 'rejected', kindClass: 'dropped', meaning: 'an option that was considered and dropped; put the one-line reason in the text.', gate: 'trackRejected' },
]

/** One row per session type: its section title, topics and item kinds. */
export const SESSION_TYPES: Readonly<Record<CompassSessionType, SessionTypeSpec>> = {
  design: { title: 'Decisions', topicsAre: 'areas of the design, such as data model, API, UI or rollout', kinds: DECISION_KINDS },
  refactor: { title: 'Decisions', topicsAre: 'the constraints and invariants to preserve, and the scope of the change', kinds: DECISION_KINDS },
  debugging: {
    title: 'Hypotheses',
    topicsAre: 'the symptoms, or the areas of the system under suspicion',
    kinds: [
      { kind: 'confirmed', glyph: '✓', label: 'confirmed', kindClass: 'settled', meaning: 'a cause or fact the evidence has established.' },
      { kind: 'hypothesis', glyph: '?', label: 'hypothesis', kindClass: 'needs-review', meaning: 'a suspected cause not yet confirmed, including guesses the assistant is acting on.' },
      { kind: 'ruled_out', glyph: '✗', label: 'ruled out', kindClass: 'dropped', meaning: 'a hypothesis the evidence eliminated; put the one-line reason in the text.' },
    ],
  },
  research: {
    title: 'Findings',
    topicsAre: 'the sub-questions or themes of the research',
    kinds: [
      { kind: 'finding', glyph: '✓', label: 'finding', kindClass: 'settled', meaning: 'something the research established.' },
      { kind: 'open_question', glyph: '?', label: 'open question', kindClass: 'needs-review', meaning: 'a question raised and left unanswered.', gate: 'trackOpenQuestions' },
      { kind: 'dead_end', glyph: '✗', label: 'dead end', kindClass: 'dropped', meaning: 'a line of inquiry that was tried and dropped; put the one-line reason in the text.', gate: 'trackRejected' },
    ],
  },
  review: {
    title: 'Findings',
    topicsAre: 'the severity of the findings, or the area of the code they concern',
    kinds: [
      { kind: 'finding', glyph: '?', label: 'finding', kindClass: 'needs-review', meaning: 'an issue or concern that still needs the author or user to respond.' },
      { kind: 'resolved', glyph: '✓', label: 'resolved', kindClass: 'settled', meaning: 'a finding that was fixed or accepted.' },
      { kind: 'dismissed', glyph: '✗', label: 'dismissed', kindClass: 'dropped', meaning: 'a finding judged not worth acting on; put the one-line reason in the text.', gate: 'trackRejected' },
    ],
  },
}

const SESSION_TYPE_NAMES = Object.keys(SESSION_TYPES) as CompassSessionType[]
const ALL_KINDS = [...new Set(Object.values(SESSION_TYPES).flatMap(spec => spec.kinds.map(k => k.kind)))]

export const OTHER_TOPIC_ID = 'other'

export function sessionTypeSetting(options: Readonly<Record<string, unknown>>): CompassSessionTypeSetting {
  return SESSION_TYPE_NAMES.find(name => name === options.sessionType) ?? 'auto'
}

/** The type the pane and the prompt work with: the config's fixed value, else the inferred one, else design. */
export function resolveSessionType(setting: CompassSessionTypeSetting, inferred: CompassSessionType | null): CompassSessionType {
  return setting === 'auto' ? (inferred ?? 'design') : setting
}

export function gatesOf(options: Readonly<Record<string, unknown>>): Gates {
  return { trackOpenQuestions: options.trackOpenQuestions === true, trackRejected: options.trackRejected === true }
}

const isGateOn = (spec: KindSpec, gates: Gates) => spec.gate === undefined || gates[spec.gate]

/** Looks a kind up in the active type first, then in every type, so an item kept from an earlier type still has a class and glyph. */
export function kindSpec(type: CompassSessionType, kind: CompassItemKind): KindSpec | undefined {
  const own = SESSION_TYPES[type].kinds.find(spec => spec.kind === kind)
  return own ?? Object.values(SESSION_TYPES).flatMap(spec => spec.kinds).find(spec => spec.kind === kind)
}

/** The kinds the updater may use in the active type: those without a gate, and those whose switch is on. */
export function enabledKinds(type: CompassSessionType, gates: Gates): CompassItemKind[] {
  return SESSION_TYPES[type].kinds.filter(spec => isGateOn(spec, gates)).map(spec => spec.kind)
}

/** The items the pane lists: any kind that is not gated off, whether or not the active type has it. */
export function shownItems(session: CompassSession, type: CompassSessionType, gates: Gates): CompassItem[] {
  return activeItems(session).filter(item => {
    const spec = kindSpec(type, item.kind)
    return spec !== undefined && isGateOn(spec, gates)
  })
}

export const kindClassOf = (type: CompassSessionType, item: CompassItem): KindClass =>
  kindSpec(type, item.kind)?.kindClass ?? 'settled'

export function emptySession(): CompassSession {
  return {
    goal: null,
    visual: null,
    sessionType: null,
    topics: [],
    items: [],
    snapshots: [],
    version: 0,
    cursor: 0,
    nextSeq: 1,
    editTurns: 0,
    lastUpdatedAt: null,
  }
}

export function emptyView(): CompassView {
  return {
    collapsed: [],
    filter: 'all',
    expandedTopicIds: [],
    collapsedReviewTopicIds: [],
    fullTopicIds: [],
    goalIndex: null,
    visualIndex: null,
    expandedItemIds: [],
  }
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

export type TurnFacts = {
  isEdit: boolean
  isQuestion: boolean
  proseChars: number
}

/** Reads what the turn that just ended did, from the rows after the last prompt the person typed. */
export function readTurnFacts(messages: readonly SessionMessage[], answer: string): TurnFacts {
  const promptAt = messages.findLastIndex(m => m.role === 'user' && !m.toolResults?.length)
  const turn = messages.slice(Math.max(promptAt, 0))
  const toolNames = turn.flatMap(m => m.toolUses.map(use => String(use.tool)))
  const proseChars = turn.reduce((sum, m) => (m.role === 'assistant' ? sum + m.text.length : sum), 0)

  return {
    isEdit: toolNames.some(name => FILE_EDIT_TOOLS.includes(name)),
    isQuestion: toolNames.includes('AskUserQuestion'),
    proseChars: Math.max(proseChars, answer.length),
  }
}

/** The gate skips a turn only when it edited nothing, asked nothing and said little. */
export function isWorthUpdating(facts: TurnFacts): boolean {
  return facts.isEdit || facts.isQuestion || facts.proseChars >= MIN_PROSE_CHARS
}

export function activeItems(session: CompassSession): CompassItem[] {
  return session.items.filter(item => item.status === 'active')
}

/** Whether files were edited and still nothing is settled: the banner's condition. */
export function hasNothingSettled(session: CompassSession, type: CompassSessionType): boolean {
  const hasSettled = activeItems(session).some(item => kindClassOf(type, item) === 'settled')
  return session.editTurns > 0 && !hasSettled
}

/** The distinct values a snapshot field has taken, oldest first, for the history steppers. */
export function distinctHistory<T extends CompassGoal | CompassVisual>(
  snapshots: readonly CompassSnapshot[],
  pick: (snapshot: CompassSnapshot) => T | null,
): T[] {
  const history: T[] = []
  for (const snapshot of snapshots) {
    const value = pick(snapshot)
    const previous = history[history.length - 1]
    if (value !== null && (previous === undefined || JSON.stringify(previous) !== JSON.stringify(value))) {
      history.push(value)
    }
  }
  return history
}

export function formatAge(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  return minutes < 60 ? `${minutes}m` : `${Math.round(minutes / 60)}h`
}

function summarizeInput(input: Record<string, unknown>): string {
  const key = SUMMARY_INPUT_KEYS.find(k => typeof input[k] === 'string')
  const value = key === undefined ? JSON.stringify(input) : `${key}=${String(input[key])}`
  return clip(oneLine(value), MAX_INPUT_CHARS)
}

/** Serializes the rows from `from` on, compactly, keeping the most recent ones within the size cap. */
export function serializeMessages(
  messages: readonly SessionMessage[],
  from: number,
  maxChars = MAX_DELTA_CHARS,
): string {
  const toolNameById = new Map<string, string>()
  for (const message of messages) {
    for (const use of message.toolUses) toolNameById.set(use.tool_use_id, String(use.tool))
  }

  const entries: string[] = []
  for (const message of messages.slice(from)) {
    const lines: string[] = []
    if (message.text.trim() !== '') {
      lines.push(`${message.role.toUpperCase()}: ${clip(message.text.trim(), MAX_MESSAGE_TEXT_CHARS)}`)
    }
    for (const use of message.toolUses) lines.push(`  tool ${use.tool} ${summarizeInput(use.input)}`)
    for (const result of message.toolResults ?? []) {
      const name = toolNameById.get(result.tool_use_id) ?? 'tool'
      const flag = result.isError ? ' (error)' : ''
      lines.push(`  result of ${name}${flag}: ${clip(oneLine(result.text), MAX_RESULT_CHARS)}`)
    }
    if (lines.length > 0) entries.push(lines.join('\n'))
  }

  const kept: string[] = []
  let total = 0
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as string
    if (total + entry.length > maxChars && kept.length > 0) {
      kept.push('[earlier messages omitted]')
      break
    }
    kept.push(entry)
    total += entry.length + 1
  }
  return kept.reverse().join('\n')
}

function buildInstructions(type: CompassSessionType, gates: Gates, isFixed: boolean): string {
  const spec = SESSION_TYPES[type]
  const kindLines = spec.kinds.map(
    k => `  - kind "${k.kind}": ${k.meaning}${k.gate === undefined ? '' : ' (only when listed under ENABLED_KINDS)'}`,
  )
  const settled = spec.kinds.find(k => k.kindClass === 'settled')
  const dropped = spec.kinds.find(k => k.kindClass === 'dropped')
  const reviewKinds = spec.kinds.filter(k => k.kindClass === 'needs-review' && isGateOn(k, gates))
  const confirmRule =
    settled === undefined || reviewKinds.length === 0
      ? ''
      : `\n  When the user confirms an item of kind ${reviewKinds.map(k => `"${k.kind}"`).join(' or ')} in the conversation, it becomes "${settled.kind}": send it again with the same id and kind "${settled.kind}".`
  const rejectRule =
    dropped === undefined
      ? ''
      : `\n  When the user rejects an item, remove it (see removed), or, if "${dropped.kind}" is listed under ENABLED_KINDS, send it again with the same id and kind "${dropped.kind}" and the reason in the text.`
  const sessionTypeRule = isFixed
    ? `sessionType: fixed as "${type}" by the person; omit the key.`
    : `sessionType: one of ${SESSION_TYPE_NAMES.join(', ')} (design covers feature work). Infer it from the conversation; PREVIOUS_STATE shows the current one. Keep it stable and change it only when the session clearly changed nature. The kinds below stay in force for this update even if you change it; the new type's kinds apply from the next update.`

  return `You maintain "compass", a small side panel that helps a person follow a coding-assistant session at a glance. After a turn you get the panel's previous state and the conversation since the last update, and you reply with what changed.

Reply with ONE JSON object and nothing else: no prose, no code fence. Shape:
{
  "noChange": boolean,
  "sessionType"?: string,
  "goal": { "text": string, "drift": null | string },
  "topics": [ { "id"?: string, "name": string, "headline": string } ],
  "items": [ { "id"?: string, "kind": string, "text": string, "topic"?: string, "supersedes"?: string, "reason"?: string } ],
  "removed": [ { "id": string, "reason": string } ],
  "visual": null | { "form": string, "markdown": string }
}

Be very concise and high-signal. Prefer fewer items; a panel with three sharp lines beats ten vague ones.

noChange: true when nothing in the new messages moves the panel. Then send no other key.

${sessionTypeRule}

goal: restate in your own words what you think the user's goals are and what problem they are trying to solve, in one to three sentences. Rewrite it as it sharpens, but keep it stable when nothing sharpened. If the recent turns wandered off the goal, set drift to a one-line reason and leave the goal text alone; never rewrite the goal just because the work drifted. Use drift null when the work is on-goal. Always send goal unless noChange.

topics: group the active items into 3 to 6 topics of your choosing; here they are ${spec.topicsAre}. A topic is { id?, name, headline }: name is one to three words; headline is one short line of at most 60 characters stating the key choice in that area; shorten any PREVIOUS_STATE headline over 60 characters. Ids are mandatory to reuse: send a topic's id from PREVIOUS_STATE to keep or rename it, and merge two topics by sending the surviving id with its new name and moving the items. Send only topics that are new or changed. Assign EVERY active item a topic: set the item's "topic" to a topic id (or, for a topic you create in this update, its name). Items whose topic is null in PREVIOUS_STATE need one now. To move an item without changing it, send just { "id", "topic" }. A topic left with no active items disappears.

items: ONLY items that are new or whose text, kind or topic changed. Omit unchanged items; they stay.
${kindLines.join('\n')}
  Keep an item only if the user would plausibly revisit it, or it chose one option over alternatives; pure mechanics and implementation steps are not items. Item text has the form "subject: choice", at most 60 characters, no markdown. Any active item in PREVIOUS_STATE whose text is over 60 characters must be rewritten this update into that form, sent with its id and a short reason, even if nothing else about it changed. Prefer revising an existing item over adding a near-duplicate. Aim for at most five active items per topic. Never invent items: only record what the messages show. Items in PREVIOUS_STATE may carry a kind from an earlier session type; leave them alone unless they change.
  Ids are mandatory to reuse. To change an existing item, send its id with the new text and a one-line "reason" for the change. Never send a new item for something already in PREVIOUS_STATE.
  "supersedes": use instead of id when a new item replaces an existing one outright (give the old id and a "reason").${confirmRule}${rejectRule}
removed: ids of items that stopped being true, each with a one-line reason.

visual: at most one picture of the session's subject, in whatever form explains it best: dataflow, state chart, sequence, tree, table or matrix, before/after, timeline, pseudo-code, code-shape sketch, or something else. Omit the "visual" key to keep the current one, send null to clear it, send an object to replace it. Only replace it when the subject changed or the picture is wrong; a stale-but-right picture is fine. "form" is a short label. "markdown" is Markdown: a fenced code block with box-drawing or ASCII, a Markdown table, or fenced pseudo-code. No SVG, no images, no HTML. Every line must fit COLUMNS characters.`
}

export type PromptInput = {
  session: CompassSession
  bodyColumns: number
  gates: Gates
  sessionTypeSetting: CompassSessionTypeSetting
  /** The serialized new messages; absent when the model sees the transcript itself (fork). */
  delta?: string
}

export function buildPrompt({ session, bodyColumns, gates, sessionTypeSetting: setting, delta }: PromptInput): {
  system: string
  data: string
} {
  const type = resolveSessionType(setting, session.sessionType)
  const topicIds = new Set(session.topics.map(topic => topic.id))
  const previousState = {
    sessionType: type,
    goal: session.goal,
    topics: session.topics.map(({ id, name, headline }) => ({ id, name, headline })),
    items: activeItems(session).map(({ id, kind, text, topic }) => ({
      id,
      kind,
      text,
      topic: topic !== null && topicIds.has(topic) ? topic : null,
    })),
    visual: session.visual,
  }
  const sections = [
    `COLUMNS: ${bodyColumns}`,
    `ENABLED_KINDS: ${enabledKinds(type, gates).join(', ')}`,
    `PREVIOUS_STATE:\n${JSON.stringify(previousState)}`,
  ]
  sections.push(
    delta === undefined
      ? 'NEW_MESSAGES:\n(the conversation above; PREVIOUS_STATE already covers what you have seen before, so read for what is new)'
      : `NEW_MESSAGES:\n${delta === '' ? '(none)' : delta}`,
  )
  return { system: buildInstructions(type, gates, setting !== 'auto'), data: sections.join('\n\n') }
}

export type UpdateItem = {
  id?: string
  /** Absent only on a move, which sends just an id and a topic. */
  kind?: CompassItemKind
  text?: string
  topic?: string
  supersedes?: string
  reason?: string
}

export type UpdateTopic = {
  id?: string
  name: string
  headline: string
}

export type CompassUpdate = {
  noChange: boolean
  sessionType?: CompassSessionType
  goal?: CompassGoal
  topics: UpdateTopic[]
  items: UpdateItem[]
  removed: { id: string; reason: string }[]
  /** Absent keeps the current visual, null clears it. */
  visual?: CompassVisual | null
}

function extractJsonObject(raw: string): unknown {
  const start = raw.indexOf('{')
  if (start < 0) return undefined
  let depth = 0
  let isInString = false
  let isEscaped = false
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]
    if (isInString) {
      if (isEscaped) isEscaped = false
      else if (ch === '\\') isEscaped = true
      else if (ch === '"') isInString = false
    } else if (ch === '"') isInString = true
    else if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) {
      try {
        return JSON.parse(raw.slice(start, i + 1))
      } catch {
        return undefined
      }
    }
  }
  return undefined
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function parseVisual(value: unknown): CompassVisual | undefined {
  if (!isRecord(value) || typeof value.form !== 'string' || typeof value.markdown !== 'string') return undefined
  const markdown = value.markdown.trim()
  const isRefused = /<svg|<img|!\[[^\]]*\]\(/i.test(markdown)
  if (markdown === '' || markdown.length > MAX_VISUAL_CHARS || isRefused) return undefined
  return { form: clip(oneLine(value.form), 40) || 'visual', markdown }
}

const optionalText = (field: unknown) => (typeof field === 'string' && field.trim() !== '' ? field.trim() : undefined)

function parseItem(value: unknown): UpdateItem | undefined {
  if (!isRecord(value)) return undefined
  const id = optionalText(value.id)
  const topic = optionalText(value.topic)
  const kind = ALL_KINDS.find(k => k === value.kind)
  const text = typeof value.text === 'string' ? clip(oneLine(value.text), MAX_ITEM_CHARS) : ''

  if (kind === undefined || text === '') return id !== undefined && topic !== undefined ? { id, topic } : undefined
  return {
    id,
    kind,
    text,
    topic,
    supersedes: optionalText(value.supersedes),
    reason: optionalText(value.reason) && clip(oneLine(value.reason as string), MAX_ITEM_CHARS),
  }
}

function parseTopic(value: unknown): UpdateTopic | undefined {
  if (!isRecord(value) || typeof value.name !== 'string') return undefined
  const name = clip(oneLine(value.name), MAX_TOPIC_NAME_CHARS)
  const headline = typeof value.headline === 'string' ? clip(oneLine(value.headline), MAX_TOPIC_HEADLINE_CHARS) : ''
  return name === '' ? undefined : { id: optionalText(value.id), name, headline }
}

/** Reads the updater's answer; undefined when it holds no usable JSON object. */
export function parseUpdate(raw: string): CompassUpdate | undefined {
  const parsed = extractJsonObject(raw)
  if (!isRecord(parsed)) return undefined
  if (parsed.noChange === true) return { noChange: true, topics: [], items: [], removed: [] }

  const hasAnyKey = ['goal', 'sessionType', 'topics', 'items', 'removed', 'visual'].some(key => key in parsed)
  const topics = parsed.topics ?? []
  const items = parsed.items ?? []
  const removed = parsed.removed ?? []
  if (!hasAnyKey || !Array.isArray(topics) || !Array.isArray(items) || !Array.isArray(removed)) return undefined

  const update: CompassUpdate = {
    noChange: false,
    sessionType: SESSION_TYPE_NAMES.find(name => name === parsed.sessionType),
    topics: topics.flatMap(topic => parseTopic(topic) ?? []),
    items: items.flatMap(item => parseItem(item) ?? []),
    removed: removed.flatMap(entry =>
      isRecord(entry) && typeof entry.id === 'string'
        ? [{ id: entry.id, reason: typeof entry.reason === 'string' ? clip(oneLine(entry.reason), MAX_ITEM_CHARS) : '' }]
        : [],
    ),
  }
  if (isRecord(parsed.goal) && typeof parsed.goal.text === 'string' && parsed.goal.text.trim() !== '') {
    const drift = typeof parsed.goal.drift === 'string' ? oneLine(parsed.goal.drift) : ''
    update.goal = { text: clip(parsed.goal.text.trim(), MAX_GOAL_CHARS), drift: drift === '' ? null : drift }
  }
  if (parsed.visual === null) update.visual = null
  else if ('visual' in parsed) update.visual = parseVisual(parsed.visual)
  return update
}

const normalize = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

function similarity(a: string, b: string): number {
  const left = new Set(normalize(a).split(' '))
  const right = new Set(normalize(b).split(' '))
  const shared = [...left].filter(word => right.has(word)).length
  return (2 * shared) / (left.size + right.size)
}

/** Finds the entry from before this update that an update entry talks about: by id, else by text closeness. */
function findClosest<T extends { id: string }>(
  entries: readonly T[],
  id: string | undefined,
  text: string | undefined,
  textOf: (entry: T) => string,
  isLive: (entry: T) => boolean,
): T | undefined {
  const byId = id === undefined ? undefined : entries.find(entry => entry.id === id)
  if (byId !== undefined || text === undefined) return byId

  let best: T | undefined
  let bestScore = SAME_ITEM_SIMILARITY
  for (const entry of entries) {
    const score = isLive(entry) ? similarity(textOf(entry), text) : 0
    if (score >= bestScore) {
      best = entry
      bestScore = score
    }
  }
  return best
}

export type MergeContext = {
  now: number
  gates: Gates
  sessionTypeSetting: CompassSessionTypeSetting
  /** The row count the update has read, becoming the session's cursor. */
  cursor: number
}

function reviseItem(
  item: CompassItem,
  out: UpdateItem,
  topic: string | null,
  version: number,
  now: number,
): CompassItem {
  const kind = out.kind ?? item.kind
  const isTextChanged = out.text !== undefined && normalize(out.text) !== normalize(item.text)
  const isRevived = item.status !== 'active'
  if (!isTextChanged && kind === item.kind && topic === item.topic && !isRevived) return item

  const isRevised = isTextChanged || kind !== item.kind || isRevived
  return {
    ...item,
    kind,
    topic,
    status: 'active',
    ...(isTextChanged && {
      text: out.text,
      version: item.version + 1,
      revisions: [...item.revisions, { version: item.version, text: item.text, reason: out.reason, at: now }],
    }),
    ...(isRevised && { updatedVersion: version }),
  }
}

/** Merges an updater answer into the session. */
export function applyUpdate(session: CompassSession, update: CompassUpdate, ctx: MergeContext): CompassSession {
  const version = session.version + 1
  let nextSeq = session.nextSeq
  let items = [...session.items]
  let topics = [...session.topics]
  const touchedTopicIds = new Set<string>()

  const sessionType =
    ctx.sessionTypeSetting === 'auto' ? (update.sessionType ?? session.sessionType ?? 'design') : ctx.sessionTypeSetting
  const kinds = enabledKinds(resolveSessionType(ctx.sessionTypeSetting, session.sessionType), ctx.gates)

  const topicIdByRef = new Map<string, string>()
  const mintTopic = (name: string, headline: string) => {
    const born: CompassTopic = { id: `t${nextSeq++}`, name, headline, updatedVersion: version }
    topics = [...topics, born]
    touchedTopicIds.add(born.id)
    return born.id
  }
  for (const out of update.topics) {
    const match = findClosest(session.topics, out.id, out.name, topic => topic.name, () => true)
    const id = match?.id ?? mintTopic(out.name, out.headline)
    if (out.id !== undefined) topicIdByRef.set(out.id, id)
    topicIdByRef.set(normalize(out.name), id)
    if (match !== undefined && (match.name !== out.name || match.headline !== out.headline)) {
      topics = topics.map(topic => (topic.id === id ? { ...topic, name: out.name, headline: out.headline, updatedVersion: version } : topic))
    }
  }

  /** A topic reference is an id or a name; an unknown name becomes a new topic with no headline yet. */
  const resolveTopic = (ref: string | undefined): string | undefined => {
    if (ref === undefined) return undefined
    const named = topics.find(topic => topic.id === ref || normalize(topic.name) === normalize(ref))
    return topicIdByRef.get(ref) ?? topicIdByRef.get(normalize(ref)) ?? named?.id ?? mintTopic(clip(oneLine(ref), MAX_TOPIC_NAME_CHARS), '')
  }

  for (const out of update.items) {
    if (out.kind !== undefined && !kinds.includes(out.kind)) continue
    const match = findClosest(session.items, out.id, out.text, item => item.text, item => item.status !== 'superseded')
    const topic = resolveTopic(out.topic)
    if (match !== undefined) {
      const nextTopic = topic ?? match.topic
      if (topic !== undefined && topic !== match.topic) touchedTopicIds.add(topic)
      items = items.map(item => (item.id === match.id ? reviseItem(item, out, nextTopic, version, ctx.now) : item))
      continue
    }
    if (out.kind === undefined || out.text === undefined) continue

    const replaced = items.find(item => item.id === out.supersedes)
    const isReplaceable = replaced !== undefined && replaced.status === 'active'
    const born: CompassItem = {
      id: `i${nextSeq++}`,
      kind: out.kind,
      text: out.text,
      status: 'active',
      version: isReplaceable ? replaced.version + 1 : 1,
      revisions: isReplaceable
        ? [...replaced.revisions, { version: replaced.version, text: replaced.text, reason: out.reason, at: ctx.now }]
        : [],
      topic: topic ?? (isReplaceable ? replaced.topic : null),
      createdVersion: version,
      updatedVersion: version,
    }
    items = [
      ...items.map(item =>
        isReplaceable && item === replaced ? { ...item, status: 'superseded' as const, updatedVersion: version } : item,
      ),
      born,
    ]
  }

  for (const gone of update.removed) {
    items = items.map(item =>
      item.id === gone.id && item.status === 'active'
        ? { ...item, status: 'superseded' as const, updatedVersion: version }
        : item,
    )
  }

  const usedTopicIds = new Set(items.filter(item => item.status === 'active').map(item => item.topic))
  topics = topics
    .filter(topic => usedTopicIds.has(topic.id))
    .map(topic => (touchedTopicIds.has(topic.id) ? { ...topic, updatedVersion: version } : topic))

  const goal = update.goal ?? session.goal
  const visual = update.visual === undefined ? session.visual : update.visual
  const isChanged =
    JSON.stringify([goal, visual, items, topics, sessionType]) !==
    JSON.stringify([session.goal, session.visual, session.items, session.topics, session.sessionType])
  if (!isChanged) return { ...session, cursor: ctx.cursor, lastUpdatedAt: ctx.now }

  const snapshot: CompassSnapshot = { version, at: ctx.now, goal, visual }
  return {
    ...session,
    goal,
    visual,
    sessionType,
    topics,
    items,
    version,
    nextSeq,
    cursor: ctx.cursor,
    lastUpdatedAt: ctx.now,
    snapshots: [...session.snapshots, snapshot].slice(-MAX_SNAPSHOTS),
  }
}

/**
 * `$.store` holds 4 MiB of JSON across all keys: drops the oldest snapshots,
 * then superseded items, until one session fits its budget.
 */
export function fitToBudget(session: CompassSession): CompassSession {
  let fitted = session
  while (JSON.stringify(fitted).length > SESSION_BUDGET_CHARS && fitted.snapshots.length > 1) {
    fitted = { ...fitted, snapshots: fitted.snapshots.slice(Math.ceil(fitted.snapshots.length / 4)) }
  }
  if (JSON.stringify(fitted).length > SESSION_BUDGET_CHARS) {
    fitted = { ...fitted, items: fitted.items.filter(item => item.status !== 'superseded') }
  }
  return fitted
}

/** Reads a session stored by any version; statuses from the version with accept and dismiss are folded into active and hidden, and items from before topics have none. */
export function migrateSession(stored: Partial<CompassSession>): CompassSession {
  const items = (stored.items ?? []).map(item => {
    const status: string = item.status
    return {
      ...item,
      topic: item.topic ?? null,
      status: status === 'active' || status === 'accepted' ? 'active' : 'superseded',
    } as CompassItem
  })
  const { clips: _clips, ...kept } = stored as Partial<CompassSession> & { clips?: unknown }
  return { ...emptySession(), ...kept, items }
}

export type TopicGroup = {
  id: string
  name: string
  headline: string
  /** Newest first. */
  items: CompassItem[]
  settledCount: number
  reviewCount: number
}

/**
 * Groups items under their topics, newest item first; items whose topic is
 * missing or gone fall under Other. Topics holding needs-review items come
 * first, then the most recently changed.
 */
export function groupByTopic(
  topics: readonly CompassTopic[],
  items: readonly CompassItem[],
  classOf: (item: CompassItem) => KindClass,
): TopicGroup[] {
  const known = new Map(topics.map(topic => [topic.id, topic]))
  const members = new Map<string, CompassItem[]>()
  for (const item of items) {
    const id = item.topic !== null && known.has(item.topic) ? item.topic : OTHER_TOPIC_ID
    members.set(id, [item, ...(members.get(id) ?? [])])
  }

  const groups = [...members.entries()].map(([id, groupItems]) => {
    const topic = known.get(id)
    const changedAt = Math.max(topic?.updatedVersion ?? 0, ...groupItems.map(item => item.updatedVersion))
    const group: TopicGroup = {
      id,
      name: topic?.name ?? 'Other',
      headline: topic?.headline ?? '',
      items: groupItems,
      settledCount: groupItems.filter(item => classOf(item) === 'settled').length,
      reviewCount: groupItems.filter(item => classOf(item) === 'needs-review').length,
    }
    return { group, changedAt }
  })
  const isOther = (id: string) => (id === OTHER_TOPIC_ID ? 1 : 0)
  return groups
    .sort(
      (a, b) =>
        Number(b.group.reviewCount > 0) - Number(a.group.reviewCount > 0) ||
        b.changedAt - a.changedAt ||
        isOther(a.group.id) - isOther(b.group.id),
    )
    .map(({ group }) => group)
}
