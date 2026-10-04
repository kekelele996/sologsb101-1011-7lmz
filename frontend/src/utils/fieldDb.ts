/**
 * 外业组库 gbhydrogaug_field（v1）。
 * 属主边界：测站、断面测次、垂线测深、流速测点、断面流量成果、对外发件箱，
 * 以及整编室送交的比测结论收件箱。整编室的点据/定线/比测表在这里不存在。
 *
 * 关键点：
 * - 报出（reportSection）写一份不可变成果快照到 outbox，再经消息通道投递。
 * - 报出后任何垂线/测点/测次头改动都会 bump revision 并发 section-changed 通知。
 * - 外业绝不写整编室业务表；投递失败只重试本侧 outbox。
 */
import Dexie, { liveQuery, type Table } from 'dexie'
import type { Station } from '@/types/station'
import type { Section } from '@/types/section'
import type { Vertical } from '@/types/vertical'
import type { Point } from '@/types/point'
import type { InboxMessage, OutboxMessage } from '@/types/dispatch'

/** 外业库名（浏览器 IndexedDB） */
export const FIELD_DB_NAME = 'gbhydrogaug_field'
export const FIELD_DB_VERSION = 1

class FieldDatabase extends Dexie {
  stations!: Table<Station, string>
  sections!: Table<Section, string>
  verticals!: Table<Vertical, string>
  points!: Table<Point, string>
  /** 对外发件箱：断面流量报出 / 测站同步 / 改动通知（本侧重试依据） */
  outbox!: Table<OutboxMessage, string>
  /** 收件箱：整编室送交的比测结论（只读台账，外业那份不动） */
  inbox!: Table<InboxMessage, string>

  constructor() {
    super(FIELD_DB_NAME)
    this.version(FIELD_DB_VERSION).stores({
      stations: 'id, name, river, sectionCode, catchmentKm2, updatedAt',
      sections: 'id, stationId, measureNo, method, stageM, measuredAt, reported, revision, updatedAt',
      verticals: 'id, sectionId, no, startDistanceM, depthM, updatedAt',
      points: 'id, verticalId, relativeDepth, velocityMs, updatedAt',
      outbox: 'id, kind, status, to, updatedAt',
      inbox: 'id, kind, from, applied, receivedAt'
    })
  }
}

export const fieldDb = new FieldDatabase()

/** 生成主键：短前缀 + 时间戳 + 随机串 */
export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now().toString(36)}${rand}`
}

/** 订阅单表变化（liveQuery），返回取消订阅函数 */
export function watchTable<T>(table: () => Table<T, string>): { subscribe: (cb: (rows: T[]) => void) => () => void } {
  return {
    subscribe(cb: (rows: T[]) => void): () => void {
      const observable = liveQuery(async () => table().toArray())
      const subscription = observable.subscribe({
        next: (rows: T[]) => cb(rows),
        error: () => cb([])
      })
      return () => subscription.unsubscribe()
    }
  }
}

/* ----------------------------- 外业库元数据 ----------------------------- */

export const FIELD_LS_KEYS = {
  dbVersion: 'gbhydrogaug:field-db-version',
  lastBackupAt: 'gbhydrogaug:field-last-backup-at',
  lastStationId: 'gbhydrogaug:last-station-id'
} as const

export function stampFieldDbVersion(): void {
  try {
    localStorage.setItem(FIELD_LS_KEYS.dbVersion, String(FIELD_DB_VERSION))
  } catch {
    // 隐私模式忽略
  }
}

export function readLastStationId(): string | null {
  try {
    return localStorage.getItem(FIELD_LS_KEYS.lastStationId)
  } catch {
    return null
  }
}

export function writeLastStationId(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(FIELD_LS_KEYS.lastStationId)
    else localStorage.setItem(FIELD_LS_KEYS.lastStationId, id)
  } catch {
    // 忽略
  }
}

export function readLastBackupAt(): string | null {
  try {
    return localStorage.getItem(FIELD_LS_KEYS.lastBackupAt)
  } catch {
    return null
  }
}

export function stampBackupTime(iso: string): void {
  try {
    localStorage.setItem(FIELD_LS_KEYS.lastBackupAt, iso)
  } catch {
    // 忽略
  }
}
