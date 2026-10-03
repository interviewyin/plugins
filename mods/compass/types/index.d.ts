/**
 * Type contract of compass: the values the plugin keeps in `$.state`.
 */

/** The kinds of every session type; which ones a session uses is decided by its `CompassSessionType`. */
export type CompassItemKind =
  | 'decision'
  | 'assumption'
  | 'open_question'
  | 'rejected'
  | 'confirmed'
  | 'hypothesis'
  | 'ruled_out'
  | 'finding'
  | 'dead_end'
  | 'resolved'
  | 'dismissed'

/** The nature of the session, which sets the section title and the kinds of its items. */
export type CompassSessionType = 'design' | 'debugging' | 'refactor' | 'research' | 'review'

/** What the config can fix the session type to; `auto` lets the updater infer it. */
export type CompassSessionTypeSetting = 'auto' | CompassSessionType

/** A group of items the updater chose, shown as one row; `headline` states the key choice in that area. */
export type CompassTopic = {
  id: string
  name: string
  headline: string
  /** The session version of the update that created or last renamed it, or moved an item into it. */
  updatedVersion: number
}

/** `superseded` items are hidden: replaced, removed, or (from an older version) dismissed. */
export type CompassItemStatus = 'active' | 'superseded'

/** An earlier text of an item: `version` is the item version the text had, `at` when it was replaced. */
export type CompassRevision = {
  version: number
  text: string
  reason?: string
  at: number
}

export type CompassItem = {
  id: string
  kind: CompassItemKind
  text: string
  status: CompassItemStatus
  /** Starts at 1 and counts the item's texts; `revisions` holds the earlier ones. */
  version: number
  revisions: CompassRevision[]
  /** The id of its topic; null until the updater assigns one, and then it shows under Other. */
  topic: string | null
  /** The session version of the update that created it, for the `new` marker. */
  createdVersion: number
  /** The session version of the update that last changed it, for the `changed` marker. */
  updatedVersion: number
}

export type CompassGoal = {
  text: string
  /** One-line reason the recent turns look off-goal; null when they do not. */
  drift: string | null
}

export type CompassVisual = {
  /** Short label of the form chosen: dataflow, state chart, sequence, table, ... */
  form: string
  markdown: string
}

export type CompassSnapshot = {
  version: number
  at: number
  goal: CompassGoal | null
  visual: CompassVisual | null
}

/** Everything that survives a resume: what the updater built. */
export type CompassSession = {
  goal: CompassGoal | null
  visual: CompassVisual | null
  /** What the session is about; null until the updater has inferred it, and then it reads as design. */
  sessionType: CompassSessionType | null
  topics: CompassTopic[]
  items: CompassItem[]
  /** One per successful update that changed something; capped at the last 50. */
  snapshots: CompassSnapshot[]
  /** Bumped by every update that changed something. */
  version: number
  /** How many `$.session.messages()` rows the last successful update has read. */
  cursor: number
  /** Source of item and topic ids. */
  nextSeq: number
  /** Turns that edited files, for the no-decisions banner. */
  editTurns: number
  lastUpdatedAt: number | null
}

export type CompassSection = 'goal' | 'decisions' | 'visual'

/** `needs-review` shows only the topics and items that are still waiting for the person. */
export type CompassFilter = 'all' | 'needs-review'

/** What the pane shows right now; never persisted. */
export type CompassView = {
  collapsed: CompassSection[]
  filter: CompassFilter
  /** Topics whose items are listed. */
  expandedTopicIds: string[]
  /** Topics the person closed under `needs-review`, where topics otherwise start open. */
  collapsedReviewTopicIds: string[]
  /** Topics whose list shows every item instead of the first few. */
  fullTopicIds: string[]
  /** Index into the distinct goals of the history; null follows the latest. */
  goalIndex: number | null
  visualIndex: number | null
  expandedItemIds: string[]
}

export type CompassRun = {
  isUpdating: boolean
  /** When the running update claimed the slot; a claim older than a few minutes is taken as dead. */
  updatingSince: number | null
  /** One line shown dim in the pane header when the last update was discarded. */
  error: string | null
  /** Last width the pane drew into, handed to the updater as its column budget. */
  bodyColumns: number
}

declare module 'claude-code' {
  interface PluginState {
    compass: {
      session: CompassSession
      view: CompassView
      run: CompassRun
    }
  }
}
