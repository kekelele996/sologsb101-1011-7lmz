/**
 * useIdbTable：Dexie 单表增删改查 + 响应式订阅封装（数据库无关）。
 * 双库分权后，页面主要走各 store；此 hook 保留给只读场景按传入表实例使用。
 */
import { liveQuery, type Table } from 'dexie'
import { onScopeDispose, ref, shallowRef, type Ref } from 'vue'
import { createId } from '@/utils/id'

/** 所有持久化实体的公共字段 */
export interface IdbRecord {
  id: string
  createdAt?: number
  updatedAt?: number
}

/** 新增记录入参：id 与时间戳由封装层补齐 */
export type NewRecord<T extends IdbRecord> = Omit<T, 'id' | 'createdAt' | 'updatedAt'> & {
  id?: string
  createdAt?: number
  updatedAt?: number
}

export interface UseIdbTableOptions<T extends IdbRecord> {
  sortByUpdatedAt?: boolean
  immediate?: boolean
  onChange?: (rows: T[]) => void
}

export interface UseIdbTableResult<T extends IdbRecord> {
  rows: Ref<T[]>
  loading: Ref<boolean>
  ready: Ref<boolean>
  error: Ref<string | null>
  refresh: () => Promise<void>
  stop: () => void
  getById: (id: string) => Promise<T | undefined>
  list: () => Promise<T[]>
  create: (payload: NewRecord<T>, idPrefix?: string) => Promise<T>
  update: (id: string, patch: Partial<T>) => Promise<void>
  upsert: (row: T) => Promise<void>
  remove: (id: string) => Promise<void>
  bulkRemove: (ids: string[]) => Promise<void>
  bulkPut: (list: T[]) => Promise<void>
  clear: () => Promise<void>
}

/**
 * @param table 任意 Dexie 表实例（外业库或整编室库）
 */
export function useIdbTable<T extends IdbRecord>(
  table: Table<T, string>,
  options: UseIdbTableOptions<T> = {}
): UseIdbTableResult<T> {
  const { sortByUpdatedAt = true, immediate = true, onChange } = options

  const rows = ref([]) as Ref<T[]>
  const loading = ref(false)
  const ready = ref(false)
  const error = ref<string | null>(null)
  const subscription = shallowRef<{ unsubscribe: () => void } | null>(null)

  const applySort = (list: T[]): T[] => {
    if (!sortByUpdatedAt) return [...list]
    return [...list].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  }

  const refresh = async (): Promise<void> => {
    loading.value = true
    try {
      rows.value = applySort(await table.toArray())
      error.value = null
      ready.value = true
      onChange?.(rows.value)
    } catch (err) {
      error.value = err instanceof Error ? err.message : '读取本地数据失败'
    } finally {
      loading.value = false
    }
  }

  const stop = (): void => {
    subscription.value?.unsubscribe()
    subscription.value = null
  }

  const create = async (payload: NewRecord<T>, idPrefix = 'row'): Promise<T> => {
    const now = Date.now()
    const record = {
      ...(payload as object),
      id: payload.id ?? createId(idPrefix),
      createdAt: payload.createdAt ?? now,
      updatedAt: payload.updatedAt ?? now
    } as T
    await table.put(record)
    return record
  }

  const update = async (id: string, patch: Partial<T>): Promise<void> => {
    await table.update(id, { ...patch, updatedAt: Date.now() } as never)
  }

  const upsert = async (row: T): Promise<void> => {
    await table.put({ ...row, updatedAt: Date.now() } as T)
  }

  if (immediate) {
    const observable = liveQuery(async () => applySort(await table.toArray()))
    subscription.value = observable.subscribe({
      next: (list: T[]) => {
        rows.value = list
        error.value = null
        ready.value = true
        onChange?.(list)
      },
      error: (err: unknown) => {
        error.value = err instanceof Error ? err.message : '订阅本地数据失败'
      }
    })
    void refresh()
  }

  onScopeDispose(stop)

  return {
    rows,
    loading,
    ready,
    error,
    refresh,
    stop,
    getById: (id: string) => table.get(id),
    list: () => table.toArray(),
    create,
    update,
    upsert,
    remove: async (id: string) => {
      await table.delete(id)
    },
    bulkRemove: async (ids: string[]) => {
      await table.bulkDelete(ids)
    },
    bulkPut: async (list: T[]) => {
      await table.bulkPut(list)
    },
    clear: async () => {
      await table.clear()
    }
  }
}
