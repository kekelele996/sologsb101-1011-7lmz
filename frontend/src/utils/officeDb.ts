/**
 * 整编室库 gbhydrogaug_office（v1）。
 * 属主边界：定线号台账、水位流量关系点据、比测结论批次、对外发件箱，
 * 以及外业组报来的断面流量成果收件箱与只读测站名册。
 *
 * 关键点：
 * - 落点据只从 inReports（外业已算出断面流量的报出成果）选取，不允许凭空录入。
 * - 收到 section-changed 通知时把来源点据置 held 挂起，挂起不影响其他点据定线。
 * - 重新定线追加 compareRuns 批次，旧批次保留可查；送交外业失败只重试本侧 outbox。
 */
import Dexie, { liveQuery, type Table } from 'dexie'
import type { Station } from '@/types/station'
import type { CompareRun, InReport, RatingLine, RatingPoint } from '@/types/office'
import type { InboxMessage, OutboxMessage } from '@/types/dispatch'

/** 整编室库名（浏览器 IndexedDB） */
export const OFFICE_DB_NAME = 'gbhydrogaug_office'
export const OFFICE_DB_VERSION = 1

class OfficeDatabase extends Dexie {
  /** 只读测站名册：由外业 station-sync 维护，整编室不改 */
  stations!: Table<Station, string>
  /** 测站名册版本：stationId → revision（用于只接受更新版本） */
  stationRevs!: Table<{ stationId: string; revision: number }, string>
  /** 外业报来的断面流量成果（落点据唯一合法来源） */
  inReports!: Table<InReport, string>
  /** 关系点据（整编室属主，可挂起/复核） */
  ratingPoints!: Table<RatingPoint, string>
  /** 定线号台账 */
  ratingLines!: Table<RatingLine, string>
  /** 比测结论批次（追加留存，旧结论可查） */
  compareRuns!: Table<CompareRun, string>
  /** 对外发件箱：送交比测结论（整编侧重试依据） */
  outbox!: Table<OutboxMessage, string>
  /** 收件箱：测站同步 / 断面流量报出 / 测次改动通知 */
  inbox!: Table<InboxMessage, string>

  constructor() {
    super(OFFICE_DB_NAME)
    this.version(OFFICE_DB_VERSION).stores({
      stations: 'id, name, river, sectionCode, updatedAt',
      stationRevs: 'stationId, revision',
      inReports: 'id, stationId, sectionId, measureNo, revision, superseded, receivedAt',
      ratingPoints:
        'id, stationId, lineNo, sectionId, reportId, status, holdReason, sourceRevision, measuredAt, updatedAt',
      ratingLines: 'lineNo, stationId, enabled, updatedAt',
      compareRuns: 'id, lineNo, stationId, dispatchStatus, concludedAt, createdAt',
      outbox: 'id, kind, status, to, updatedAt',
      inbox: 'id, kind, from, applied, receivedAt'
    })
  }
}

export const officeDb = new OfficeDatabase()

/** 订阅单表变化（liveQuery） */
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

/* ----------------------------- 整编室元数据 ----------------------------- */

export const OFFICE_LS_KEYS = {
  dbVersion: 'gbhydrogaug:office-db-version',
  lastBackupAt: 'gbhydrogaug:office-last-backup-at'
} as const

export function stampOfficeDbVersion(): void {
  try {
    localStorage.setItem(OFFICE_LS_KEYS.dbVersion, String(OFFICE_DB_VERSION))
  } catch {
    // 忽略
  }
}

export function readLastBackupAt(): string | null {
  try {
    return localStorage.getItem(OFFICE_LS_KEYS.lastBackupAt)
  } catch {
    return null
  }
}

export function stampBackupTime(iso: string): void {
  try {
    localStorage.setItem(OFFICE_LS_KEYS.lastBackupAt, iso)
  } catch {
    // 忽略
  }
}
