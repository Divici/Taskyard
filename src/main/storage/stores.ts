import { join } from 'node:path'
import type { z } from 'zod'
import { defaultSettings, emptyLayout, emptyTasks } from '@shared/defaults'
import type { StorageChanged, StorageStatus, StoreFiles, StoreName } from '@shared/ipc'
import {
  LayoutFileSchema,
  SettingsFileSchema,
  TasksFileSchema,
  type LayoutFile,
  type SettingsFile,
  type TasksFile
} from '@shared/schema'
import { SCHEMA_VERSION } from '@shared/version'
import { JsonStore } from './json-store'
import {
  LAYOUT_MIGRATIONS,
  SETTINGS_MIGRATIONS,
  TASKS_MIGRATIONS,
  type MigrationTable
} from './migrations'
import { OpsJournal } from './ops-journal'
import type { StorageLog } from './versioned-file'

/** The data files in userData. */
export const DATA_FILES = {
  settings: 'settings.json',
  layout: 'layout.json',
  tasks: 'tasks.json',
  ops: 'ops.json'
} as const

/**
 * zod schema per renderer store. Loading uses it as is (field defaults fill older files);
 * inbound `storage:save` data goes through `parseExact` with it, which forbids defaults and
 * unknown keys at every depth.
 */
export const STORE_SCHEMAS: { readonly [N in StoreName]: z.ZodType<StoreFiles[N]> } = {
  settings: SettingsFileSchema,
  layout: LayoutFileSchema,
  tasks: TasksFileSchema
}

const MIGRATIONS: { readonly [N in StoreName]: MigrationTable } = {
  settings: SETTINGS_MIGRATIONS,
  layout: LAYOUT_MIGRATIONS,
  tasks: TASKS_MIGRATIONS
}

const DEFAULTS: { readonly [N in StoreName]: () => StoreFiles[N] } = {
  settings: defaultSettings,
  layout: emptyLayout,
  tasks: emptyTasks
}

export interface StorageOptions {
  /** The userData folder. */
  dir: string
  log: StorageLog
  now?: () => Date
  debounceMs?: number
  /** Every accepted save of a renderer store; main broadcasts it as `storage:changed`. */
  onChange?: (change: StorageChanged) => void
}

export interface Storage {
  readonly settings: JsonStore<SettingsFile>
  readonly layout: JsonStore<LayoutFile>
  readonly tasks: JsonStore<TasksFile>
  readonly ops: OpsJournal
  store<N extends StoreName>(name: N): JsonStore<StoreFiles[N]>
  /** Boot step "stores load": every store plus the move journal. */
  loadAll(): Promise<void>
  /** True while any store has data that is not on disk yet. */
  hasPendingWrites(): boolean
  /** Writes every pending store; rejects after all were attempted if any failed. */
  flushAll(): Promise<void>
  flushAllSync(): void
  status(): StorageStatus
}

function describeFailures(failures: Array<[string, unknown]>): string {
  return failures
    .map(([name, error]) => `${name}: ${error instanceof Error ? error.message : String(error)}`)
    .join('; ')
}

export function createStorage(options: StorageOptions): Storage {
  function jsonStore<N extends StoreName>(name: N): JsonStore<StoreFiles[N]> {
    return new JsonStore<StoreFiles[N]>({
      name,
      path: join(options.dir, DATA_FILES[name]),
      schema: STORE_SCHEMAS[name],
      version: SCHEMA_VERSION,
      migrations: MIGRATIONS[name],
      defaults: DEFAULTS[name],
      log: options.log,
      now: options.now,
      debounceMs: options.debounceMs,
      onChange: ({ revision, data }) =>
        options.onChange?.({ store: name, revision, data } as StorageChanged)
    })
  }

  const stores: { readonly [N in StoreName]: JsonStore<StoreFiles[N]> } = {
    settings: jsonStore('settings'),
    layout: jsonStore('layout'),
    tasks: jsonStore('tasks')
  }
  const ops = new OpsJournal({
    path: join(options.dir, DATA_FILES.ops),
    log: options.log,
    now: options.now
  })
  const all = [stores.settings, stores.layout, stores.tasks] as const

  return {
    ...stores,
    ops,
    store: (name) => stores[name],

    async loadAll() {
      await Promise.all([...all.map((store) => store.load()), ops.load()])
    },

    hasPendingWrites() {
      return all.some((store) => store.hasPendingWrite())
    },

    async flushAll() {
      const results = await Promise.allSettled(all.map((store) => store.flush()))
      const failures = results.flatMap((result, index): Array<[string, unknown]> =>
        result.status === 'rejected' ? [[all[index].name, result.reason]] : []
      )
      if (failures.length > 0) {
        throw new AggregateError(
          failures.map(([, error]) => error),
          `storage: flush failed (${describeFailures(failures)})`
        )
      }
    },

    flushAllSync() {
      const failures: Array<[string, unknown]> = []
      for (const store of all) {
        try {
          store.flushSync()
        } catch (error) {
          failures.push([store.name, error])
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(
          failures.map(([, error]) => error),
          `storage: sync flush failed (${describeFailures(failures)})`
        )
      }
    },

    status() {
      const files = [...all, ops]
      return {
        readOnly: files.flatMap((file) => (file.readOnly ? [file.readOnly] : [])),
        recovered: files.flatMap((file) => (file.recovered ? [file.recovered] : []))
      }
    }
  }
}
