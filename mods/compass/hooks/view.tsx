/**
 * Draws the Compass pane: goal, topics of decisions (or hypotheses, or
 * findings) and visual as collapsible sections. Item text
 * wraps beside a fixed-width glyph Button, so continuation lines hang under
 * the text. A pure function of the state it is handed; presses go through the
 * actions the caller supplies, since `$` cannot cross an import.
 */
import type { Elements, RenderChildren, RenderSurface } from 'claude-code'

import type {
  CompassFilter,
  CompassItem,
  CompassRun,
  CompassSection,
  CompassSession,
  CompassSessionType,
  CompassView,
} from '../types'
import type { Gates, TopicGroup } from './model'
import {
  SESSION_TYPES,
  distinctHistory,
  formatAge,
  groupByTopic,
  hasNothingSettled,
  kindClassOf,
  kindSpec,
  shownItems,
} from './model'

const FIRST_ITEMS_SHOWN = 8
const MIN_ITEM_LABEL_CHARS = 12
const ITEM_INDENT = 2

const toggled = (list: readonly string[], value: string) =>
  list.includes(value) ? list.filter(entry => entry !== value) : [...list, value]

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

const truncated = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

export type PaneActions = {
  setView: (change: (view: CompassView) => CompassView) => unknown
  fillPrompt: (text: string) => unknown
  refresh: () => unknown
}

export type PaneModel = {
  elements: Elements[RenderSurface]
  session: CompassSession
  view: CompassView
  /** The type the pane works with: the config's fixed value, else the inferred one. */
  sessionType: CompassSessionType
  /** Which opt-in kinds the config switched on. */
  gates: Gates
  run: CompassRun
  now: number
  width: number
  actions: PaneActions
}

export function renderPane({ elements, session, view, sessionType, gates, run, now, width, actions }: PaneModel) {
  const { Box, Text, Button, Markdown } = elements
  const { setView } = actions

  const isOpen = (section: CompassSection) => !view.collapsed.includes(section)

  const heading = (section: CompassSection, title: string, ...extra: RenderChildren[]) => (
    <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
      <Button
        key={`toggle:${section}`}
        plain
        label={`${isOpen(section) ? '▼' : '▸'} ${title}`}
        onPress={() => setView(v => ({ ...v, collapsed: toggled(v.collapsed, section) as CompassSection[] }))}
      />
      {extra}
    </Box>
  )

  const stepper = (
    field: 'goalIndex' | 'visualIndex',
    length: number,
    shownAt: number,
    hotkeys: readonly [string, string],
  ) => {
    const step = (delta: number) =>
      setView(v => {
        const next = Math.max(0, Math.min(length - 1, (v[field] ?? length - 1) + delta))
        return { ...v, [field]: next === length - 1 ? null : next }
      })
    return length < 2
      ? []
      : [
          <Button key={`${field}:prev`} label="◀" hotkey={hotkeys[0]} onPress={() => step(-1)} />,
          <Text dimColor>
            v{shownAt + 1}/{length}
          </Text>,
          <Button key={`${field}:next`} label="▶" hotkey={hotkeys[1]} onPress={() => step(1)} />,
        ]
  }

  const goals = distinctHistory(session.snapshots, s => s.goal)
  const goalAt = view.goalIndex === null ? goals.length - 1 : Math.min(view.goalIndex, goals.length - 1)
  const goal = view.goalIndex === null ? session.goal : (goals[goalAt] ?? session.goal)

  const goalSection = (
    <Box flexDirection="column">
      {heading(
        'goal',
        'Goal',
        ...stepper('goalIndex', goals.length, goalAt, ['a', 's']),
        session.lastUpdatedAt === null ? null : <Text dimColor>↻ {formatAge(now - session.lastUpdatedAt)}</Text>,
        run.isUpdating ? <Text color="cyan">updating…</Text> : null,
        <Button key="refresh" label="Refresh" hotkey="r" onPress={() => actions.refresh()} />,
      )}
      {isOpen('goal') &&
        (goal === null ? (
          <Text dimColor>No goal yet; it appears after the first update.</Text>
        ) : (
          <Box flexDirection="column">
            <Markdown text={goal.text} />
            {goal.drift !== null && (
              <Text color="yellow" wrap="wrap">
                drift? {goal.drift}
              </Text>
            )}
          </Box>
        ))}
    </Box>
  )

  const itemRow = (item: CompassItem) => {
    const spec = kindSpec(sessionType, item.kind)
    const isRevisionsOpen = view.expandedItemIds.includes(item.id)
    const marker =
      item.createdVersion === session.version ? 'new' : item.updatedVersion === session.version ? 'changed' : null

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={1}>
          <Box flexShrink={0}>
            <Button
              key={`item:${item.id}`}
              plain
              label={spec?.glyph ?? '?'}
              onPress={() => actions.fillPrompt(`Re: ${spec?.label} "${item.text}" — `)}
            />
          </Box>
          <Box flexDirection="row" flexWrap="wrap" columnGap={1} flexGrow={1} flexShrink={1} minWidth={0}>
            <Text wrap="wrap">
              {item.text}
              {marker !== null && <Text dimColor>{` ${marker}`}</Text>}
            </Text>
            {item.revisions.length > 0 && (
              <Button
                key={`revs:${item.id}`}
                plain
                label={`${plural(item.revisions.length, 'rev')}${isRevisionsOpen ? '▴' : '▾'}`}
                onPress={() => setView(v => ({ ...v, expandedItemIds: toggled(v.expandedItemIds, item.id) }))}
              />
            )}
          </Box>
        </Box>
        {isRevisionsOpen &&
          [...item.revisions].reverse().map(revision => (
            <Box paddingLeft={ITEM_INDENT}>
              <Text dimColor wrap="wrap">
                v{revision.version}: {revision.text}
                {revision.reason === undefined ? '' : ` (${revision.reason})`}
              </Text>
            </Box>
          ))}
      </Box>
    )
  }

  const settled = shownItems(session, sessionType, gates)
  const classOf = (item: CompassItem) => kindClassOf(sessionType, item)
  const settledCount = settled.filter(item => classOf(item) === 'settled').length
  const reviewCount = settled.filter(item => classOf(item) === 'needs-review').length
  const filter: CompassFilter = view.filter === 'needs-review' && reviewCount > 0 ? 'needs-review' : 'all'

  const listed = filter === 'needs-review' ? settled.filter(item => classOf(item) === 'needs-review') : settled
  const groups = groupByTopic(session.topics, listed, classOf)

  const filterButtons = (['all', 'needs-review'] as const).map(choice => (
    <Button
      key={`filter:${choice}`}
      plain={choice === filter ? undefined : true}
      label={choice === 'all' ? 'all' : `needs review ${reviewCount}`}
      onPress={() => setView(v => ({ ...v, filter: choice }))}
    />
  ))
  const tally = (settledN: number, reviewN: number) => (
    <Box flexDirection="row" columnGap={1} flexShrink={0}>
      {settledN > 0 && <Text color="green">{`✓${settledN}`}</Text>}
      {reviewN > 0 && <Text color="yellow">{`?${reviewN}`}</Text>}
    </Box>
  )

  const topicBlock = (group: TopicGroup) => {
    const isReviewFilter = filter === 'needs-review'
    const isOpenTopic = isReviewFilter
      ? !(view.collapsedReviewTopicIds ?? []).includes(group.id)
      : view.expandedTopicIds.includes(group.id)
    const isFull = view.fullTopicIds.includes(group.id)
    const hiddenCount = group.items.length - FIRST_ITEMS_SHOWN
    const countsWidth = `✓${group.settledCount} ?${group.reviewCount}`.length + 1
    const nameLabel = truncated(
      `${isOpenTopic ? '▾' : '▸'} ${group.name}`,
      Math.max(MIN_ITEM_LABEL_CHARS, width - countsWidth),
    )

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" columnGap={1}>
          <Button
            key={`topic:${group.id}`}
            plain
            label={nameLabel}
            onPress={() =>
              setView(v =>
                isReviewFilter
                  ? { ...v, collapsedReviewTopicIds: toggled(v.collapsedReviewTopicIds ?? [], group.id) }
                  : { ...v, expandedTopicIds: toggled(v.expandedTopicIds, group.id) },
              )
            }
          />
          {tally(group.settledCount, group.reviewCount)}
        </Box>
        {group.headline !== '' && (
          <Box paddingLeft={ITEM_INDENT}>
            <Text dimColor wrap="wrap">
              {group.headline}
            </Text>
          </Box>
        )}
        {isOpenTopic && (
          <Box flexDirection="column" rowGap={1} paddingLeft={ITEM_INDENT}>
            {(isFull ? group.items : group.items.slice(0, FIRST_ITEMS_SHOWN)).map(itemRow)}
            {hiddenCount > 0 && (
              <Button
                key={`more:${group.id}`}
                plain
                dimColor
                label={isFull ? 'show less' : `+${hiddenCount} more`}
                onPress={() => setView(v => ({ ...v, fullTopicIds: toggled(v.fullTopicIds, group.id) }))}
              />
            )}
          </Box>
        )}
      </Box>
    )
  }

  const decisionsSection = (
    <Box flexDirection="column">
      {heading('decisions', `${SESSION_TYPES[sessionType].title} · ${sessionType}`)}
      {isOpen('decisions') && (
        <Box flexDirection="column" rowGap={1}>
          <Box flexDirection="row" columnGap={2} paddingLeft={ITEM_INDENT}>
            {filterButtons}
          </Box>
          {hasNothingSettled(session, sessionType) && (
            <Text bold inverse color="yellow">
              No {SESSION_TYPES[sessionType].title.toLowerCase()} yet — {plural(session.editTurns, 'turn')} of work
            </Text>
          )}
          {groups.length === 0 && !hasNothingSettled(session, sessionType) && <Text dimColor>Nothing here yet.</Text>}
          {groups.map(topicBlock)}
        </Box>
      )}
    </Box>
  )

  const visuals = distinctHistory(session.snapshots, s => s.visual)
  const visualAt = view.visualIndex === null ? visuals.length - 1 : Math.min(view.visualIndex, visuals.length - 1)
  const visual = view.visualIndex === null ? session.visual : (visuals[visualAt] ?? session.visual)

  const visualSection = (
    <Box flexDirection="column">
      {heading(
        'visual',
        visual === null ? 'Visual' : `Visual · ${visual.form}`,
        ...stepper('visualIndex', visuals.length, visualAt, ['z', 'x']),
      )}
      {isOpen('visual') &&
        (visual === null ? (
          <Text dimColor>A visual appears when one explains the session.</Text>
        ) : (
          <Markdown text={visual.markdown} />
        ))}
    </Box>
  )

  return (
    <Box flexDirection="column" width={width} rowGap={1}>
      {run.error !== null && (
        <Text dimColor wrap="truncate">
          {run.error}
        </Text>
      )}
      {goalSection}
      {decisionsSection}
      {visualSection}
    </Box>
  )
}
