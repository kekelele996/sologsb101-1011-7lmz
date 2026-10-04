/**
 * 持久化层（Dexie 封装）——外业 / 整编两侧各持一库，互不回写
 *
 * - 外业库 gbhydrogaug-field：stations（共享台账主本）、sections、verticals、points、discharges
 * - 整编库 gbhydrogaug-office：stations（台账副本，只读引用）、ratings、compares、conclusions
 * - 旧版共库 gbhydrogaug（v2）第一次打开时先迁移到两边再启用，迁移完成后删除旧库
 * - 两侧库之间只允许「外业 → 整编」的只读快照送交，整编室永不回写外业库
 * - 纯前端应用：不依赖任何后端服务或数据库服务
 */
import Dexie, { liveQuery, type Table } from 'dexie'
import type { Station } from '@/types/station'
import type { Section } from '@/types/section'
import type { Vertical } from '@/types/vertical'
import type { Point } from '@/types/point'
import type { Discharge } from '@/types/discharge'
import type { Rating } from '@/types/rating'
import type { Compare, CompareConclusion } from '@/types/compare'
import { calcDeviationPct, createPendingDelivery, judgeDeviation } from '@/types/compare'
import { fitPowerCurve } from '@/types/rating'
import { calcMeanVelocity, calcSectionDischarge, DEFAULT_WEIGHTS, round } from '@/utils/flow'

/** 外业组数据库：测次、垂线测深、流速测点、断面流量成果 */
export const FIELD_DB_NAME = 'gbhydrogaug-field'
/** 整编室数据库：定线号、关系点据、比测结论 */
export const OFFICE_DB_NAME = 'gbhydrogaug-office'
/** 旧版共库（v1/v2）：仅迁移期读取 */
export const LEGACY_DB_NAME = 'gbhydrogaug'
/** 应用展示名 */
export const DB_NAME = 'gbhydrogaug'

/** localStorage 侧少量元数据键名 */
export const LS_KEYS = {
  dbVersion: 'gbhydrogaug:db-version',
  splitMigration: 'gbhydrogaug:split-migration-v3',
  lastBackupAt: 'gbhydrogaug:last-backup-at',
  lastStationId: 'gbhydrogaug:last-station-id'
} as const

/** 备份文件结构，供 utils/export.ts 与导出页使用 */
export interface BackupPayload {
  app: 'gbhydrogaug'
  dbVersion: number
  exportedAt: string
  // 外业侧
  stations: Station[]
  sections: Section[]
  verticals: Vertical[]
  points: Point[]
  discharges: Discharge[]
  // 整编侧（stationsOffice 为共享台账副本）
  stationsOffice: Station[]
  ratings: Rating[]
  compares: Compare[]
  conclusions: CompareConclusion[]
}

/* -------------------------------- 外业库 -------------------------------- */

class FieldDatabase extends Dexie {
  stations!: Table<Station, string>
  sections!: Table<Section, string>
  verticals!: Table<Vertical, string>
  points!: Table<Point, string>
  discharges!: Table<Discharge, string>

  constructor() {
    super(FIELD_DB_NAME)
    this.version(1).stores({
      stations: 'id, name, river, sectionCode, catchmentKm2, updatedAt',
      sections: 'id, stationId, measureNo, method, stageM, measuredAt, updatedAt',
      verticals: 'id, sectionId, no, startDistanceM, depthM, updatedAt',
      points: 'id, verticalId, relativeDepth, velocityMs, updatedAt',
      discharges: 'id, sectionId, reported, revision, updatedAt'
    })
  }
}

/* -------------------------------- 整编库 -------------------------------- */

class OfficeDatabase extends Dexie {
  stations!: Table<Station, string>
  ratings!: Table<Rating, string>
  compares!: Table<Compare, string>
  conclusions!: Table<CompareConclusion, string>

  constructor() {
    super(OFFICE_DB_NAME)
    this.version(1).stores({
      stations: 'id, name, river, sectionCode, catchmentKm2, updatedAt',
      ratings: 'id, stationId, sectionId, lineNo, status, stageM, flowM3s, measuredAt, updatedAt',
      compares: 'id, ratingId, verdict, deviationPct, conclusionRev, comparedAt, updatedAt',
      conclusions: 'id, [lineNo+conclusionRev], lineNo, conclusionRev, concludedAt, updatedAt'
    })
  }
}

export const fieldDb = new FieldDatabase()
export const officeDb = new OfficeDatabase()

/** 当前数据结构版本号：两侧分库后的结构版本 */
export const DB_VERSION = 3

/** 生成主键：短前缀 + 时间戳 + 随机串，避免多标签页写入冲突 */
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

/* ------------------------ 断面流量成果：计算与指纹 ------------------------ */

/**
 * 由外业库当前垂线 / 测点实时计算某测次的断面流量成果（不落库）。
 * 页面展示与成果落库共用同一套算法。
 */
export async function computeDischargeForSection(sectionId: string): Promise<{
  result: ReturnType<typeof calcSectionDischarge>
  verticalCount: number
  inputHash: string
} | null> {
  const section = await fieldDb.sections.get(sectionId)
  if (!section) return null
  const verticals = await fieldDb.verticals.where('sectionId').equals(sectionId).toArray()
  const points = verticals.length > 0 ? await fieldDb.points.where('verticalId').anyOf(verticals.map((v) => v.id)).toArray() : []
  const slices = verticals
    .sort((a, b) => a.startDistanceM - b.startDistanceM)
    .map((vertical) => {
      const verticalPoints = points
        .filter((point) => point.verticalId === vertical.id)
        .sort((a, b) => a.relativeDepth - b.relativeDepth)
      const meanVelocityMs = calcMeanVelocity(
        verticalPoints.map((point) => ({ velocityMs: point.velocityMs, weight: point.weight }))
      )
      return {
        id: vertical.id,
        no: vertical.no,
        startDistanceM: vertical.startDistanceM,
        depthM: vertical.depthM,
        meanVelocityMs,
        pointSignatures: verticalPoints.map(
          (point) => `${point.relativeDepth.toFixed(3)}/${point.velocityMs.toFixed(3)}/${point.weight.toFixed(4)}`
        )
      }
    })
  const result = calcSectionDischarge(
    slices.map((slice) => ({
      id: slice.id,
      no: slice.no,
      startDistanceM: slice.startDistanceM,
      depthM: slice.depthM,
      meanVelocityMs: slice.meanVelocityMs
    }))
  )
  const signature = slices
    .map((slice) => `${slice.no}:${slice.startDistanceM}/${slice.depthM}|${slice.pointSignatures.join(',')}`)
    .join(';')
  return { result, verticalCount: verticals.length, inputHash: hashSignature(`${sectionId}@${signature}`) }
}

/** 轻量指纹（FNV-1a 变体）：垂线 / 测点任一变化指纹即变 */
function hashSignature(input: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/**
 * 重算并落库某测次的断面流量成果（外业侧）。
 * 未报出前反复试算始终为 r1；一旦已报出、垂线 / 测点又导致指纹变化则 revision +1
 * —— 整编室据此把引用旧版本的点据挂起等人复核。
 * 返回最新成果；测次不存在时返回 null。
 */
export async function recomputeDischarge(sectionId: string): Promise<Discharge | null> {
  const computed = await computeDischargeForSection(sectionId)
  if (!computed) return null
  const now = Date.now()
  const iso = new Date(now).toISOString()
  const existing = await fieldDb.discharges.where('sectionId').equals(sectionId).first()
  const changed = !existing || existing.inputHash !== computed.inputHash
  // 已报出后内容再改：成果版本 +1（整编室据此挂起引用旧版的点据）；未报出前始终为 r1
  const revision = existing ? (existing.reported && changed ? existing.revision + 1 : existing.revision) : 1
  const record: Discharge = {
    id: existing?.id ?? createId('dch'),
    sectionId,
    flowM3s: computed.result.flowM3s,
    areaM2: computed.result.areaM2,
    meanVelocityMs: computed.result.meanVelocityMs,
    maxDepthM: computed.result.maxDepthM,
    widthM: computed.result.widthM,
    verticalCount: computed.verticalCount,
    slices: computed.result.slices,
    inputHash: computed.inputHash,
    revision,
    reported: existing?.reported ?? false,
    reportedAt: existing?.reportedAt ?? null,
    computedAt: iso,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  }
  await fieldDb.discharges.put(record)
  return record
}

/* --------------------- 跨侧对账：报出后外业改动 → 挂起 --------------------- */

/**
 * 整编室点据与外业成果对账（整编室主动、只读外业库）：
 * 已落的点据若源测次成果版本对不上（外业报出后又改了垂线 / 测点），
 * 或源成果已不存在，则把这一条点据置为「挂起」等人复核；只挂自己一条，不挡别的。
 * 挂起后不会自动恢复，必须人工复核（采用新成果或作废），改由 ratingStore 执行。
 * 返回本次新挂起的点据 id 清单。
 */
export async function reconcileOfficeRatings(): Promise<string[]> {
  const ratings = await officeDb.ratings.toArray()
  const discharges = await fieldDb.discharges.toArray()
  const dischargeBySection = new Map(discharges.map((discharge) => [discharge.sectionId, discharge]))
  const now = Date.now()
  const iso = new Date(now).toISOString()
  const suspended: string[] = []
  await officeDb.transaction('rw', officeDb.ratings, async () => {
    for (const rating of ratings) {
      // 历史点据可能没有源测次（迁移留档），不参与自动对账
      if (!rating.sectionId) continue
      if (rating.status === '挂起') continue
      const discharge = dischargeBySection.get(rating.sectionId)
      if (!discharge || discharge.revision !== rating.sourceRevision) {
        rating.status = '挂起'
        rating.checkedAt = iso
        rating.updatedAt = now
        suspended.push(rating.id)
        await officeDb.ratings.put(rating)
      }
    }
  })
  return suspended
}

/* ------------------------------ 演示数据播种 ------------------------------ */

interface SeedStationBundle {
  station: Omit<Station, 'createdAt' | 'updatedAt'>
  sections: Array<Omit<Section, 'createdAt' | 'updatedAt'>>
  verticals: Array<Omit<Vertical, 'createdAt' | 'updatedAt'>>
  points: Array<Omit<Point, 'createdAt' | 'updatedAt'>>
}

/**
 * 播种演示数据：外业侧（3 测站 / 5 测次 / 8 垂线 / 26 测点 + 断面成果），
 * 整编侧（台账副本 / 13 点据 / 比测当前结论 + 首版结论历史）。
 */
export async function seedDemoData(): Promise<void> {
  const now = Date.now()
  const iso = new Date(now).toISOString()

  const stationBundles: SeedStationBundle[] = [
    {
      station: {
        id: 'stn_lh01',
        name: '龙门水文站',
        river: '澜沧江',
        catchmentKm2: 45200,
        sectionCode: 'CS-LM-01',
        remark: '基本水文站，缆道测流，断面稳定'
      },
      sections: [
        {
          id: 'sec_lh_2406',
          stationId: 'stn_lh01',
          measureNo: '2024-06-001',
          startDistanceM: 12.5,
          stageM: 5.42,
          method: '流速仪',
          measuredAt: '2024-06-12T08:30:00.000Z'
        },
        {
          id: 'sec_lh_2407',
          stationId: 'stn_lh01',
          measureNo: '2024-07-002',
          startDistanceM: 12.5,
          stageM: 6.15,
          method: 'ADCP',
          measuredAt: '2024-07-18T09:10:00.000Z'
        }
      ],
      verticals: [
        { id: 'vrt_lh_1', sectionId: 'sec_lh_2406', no: 1, startDistanceM: 6.5, depthM: 1.4, pointCount: 2, bedNote: '左岸浅滩，砾石河床' },
        { id: 'vrt_lh_2', sectionId: 'sec_lh_2406', no: 2, startDistanceM: 14.0, depthM: 3.2, pointCount: 3, bedNote: '主流，砂卵石' },
        { id: 'vrt_lh_3', sectionId: 'sec_lh_2406', no: 3, startDistanceM: 22.0, depthM: 2.1, pointCount: 2, bedNote: '右岸缓流，细砂' },
        { id: 'vrt_lh_4', sectionId: 'sec_lh_2407', no: 1, startDistanceM: 8.0, depthM: 3.8, pointCount: 3, bedNote: 'ADCP 走航断面，主槽' }
      ],
      points: [
        { id: 'pnt_lh_11', verticalId: 'vrt_lh_1', relativeDepth: 0.2, velocityMs: 0.62, weight: 0.5, durationS: 100 },
        { id: 'pnt_lh_12', verticalId: 'vrt_lh_1', relativeDepth: 0.8, velocityMs: 0.48, weight: 0.5, durationS: 100 },
        { id: 'pnt_lh_21', verticalId: 'vrt_lh_2', relativeDepth: 0.2, velocityMs: 1.42, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_lh_22', verticalId: 'vrt_lh_2', relativeDepth: 0.6, velocityMs: 1.18, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_lh_23', verticalId: 'vrt_lh_2', relativeDepth: 0.8, velocityMs: 0.96, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_lh_31', verticalId: 'vrt_lh_3', relativeDepth: 0.2, velocityMs: 0.82, weight: 0.5, durationS: 100 },
        { id: 'pnt_lh_32', verticalId: 'vrt_lh_3', relativeDepth: 0.8, velocityMs: 0.64, weight: 0.5, durationS: 100 },
        { id: 'pnt_lh_41', verticalId: 'vrt_lh_4', relativeDepth: 0.2, velocityMs: 1.86, weight: 1 / 3, durationS: 120 },
        { id: 'pnt_lh_42', verticalId: 'vrt_lh_4', relativeDepth: 0.6, velocityMs: 1.64, weight: 1 / 3, durationS: 120 },
        { id: 'pnt_lh_43', verticalId: 'vrt_lh_4', relativeDepth: 0.8, velocityMs: 1.32, weight: 1 / 3, durationS: 120 }
      ]
    },
    {
      station: {
        id: 'stn_qj02',
        name: '青矶水位站',
        river: '沅江',
        catchmentKm2: 1860,
        sectionCode: 'CS-QJ-02',
        remark: '小河站，浮标法为主，洪水期加测'
      },
      sections: [
        {
          id: 'sec_qj_2405',
          stationId: 'stn_qj02',
          measureNo: '2024-05-003',
          startDistanceM: 4.2,
          stageM: 3.18,
          method: '浮标',
          measuredAt: '2024-05-22T07:50:00.000Z'
        },
        {
          id: 'sec_qj_2408',
          stationId: 'stn_qj02',
          measureNo: '2024-08-004',
          startDistanceM: 4.2,
          stageM: 4.36,
          method: '流速仪',
          measuredAt: '2024-08-09T06:40:00.000Z'
        }
      ],
      verticals: [
        { id: 'vrt_qj_1', sectionId: 'sec_qj_2405', no: 1, startDistanceM: 2.4, depthM: 1.1, pointCount: 2, bedNote: '浮标上断面' },
        { id: 'vrt_qj_2', sectionId: 'sec_qj_2405', no: 2, startDistanceM: 6.8, depthM: 1.9, pointCount: 2, bedNote: '浮标中泓' },
        { id: 'vrt_qj_3', sectionId: 'sec_qj_2408', no: 1, startDistanceM: 3.1, depthM: 1.6, pointCount: 3, bedNote: '涨水期，流速仪三点法' },
        { id: 'vrt_qj_4', sectionId: 'sec_qj_2408', no: 2, startDistanceM: 7.6, depthM: 2.4, pointCount: 3, bedNote: '主槽，卵石夹砂' }
      ],
      points: [
        { id: 'pnt_qj_11', verticalId: 'vrt_qj_1', relativeDepth: 0.2, velocityMs: 0.54, weight: 0.5, durationS: 100 },
        { id: 'pnt_qj_12', verticalId: 'vrt_qj_1', relativeDepth: 0.8, velocityMs: 0.42, weight: 0.5, durationS: 100 },
        { id: 'pnt_qj_21', verticalId: 'vrt_qj_2', relativeDepth: 0.2, velocityMs: 0.88, weight: 0.5, durationS: 100 },
        { id: 'pnt_qj_22', verticalId: 'vrt_qj_2', relativeDepth: 0.8, velocityMs: 0.7, weight: 0.5, durationS: 100 },
        { id: 'pnt_qj_31', verticalId: 'vrt_qj_3', relativeDepth: 0.2, velocityMs: 1.06, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_qj_32', verticalId: 'vrt_qj_3', relativeDepth: 0.6, velocityMs: 0.92, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_qj_33', verticalId: 'vrt_qj_3', relativeDepth: 0.8, velocityMs: 0.78, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_qj_41', verticalId: 'vrt_qj_4', relativeDepth: 0.2, velocityMs: 1.34, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_qj_42', verticalId: 'vrt_qj_4', relativeDepth: 0.6, velocityMs: 1.2, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_qj_43', verticalId: 'vrt_qj_4', relativeDepth: 0.8, velocityMs: 1.04, weight: 1 / 3, durationS: 100 }
      ]
    },
    {
      station: {
        id: 'stn_bs03',
        name: '白沙滩巡测站',
        river: '澜沧江',
        catchmentKm2: 51200,
        sectionCode: 'CS-BS-03',
        remark: '巡测断面，与龙门站比测'
      },
      sections: [
        {
          id: 'sec_bs_2406',
          stationId: 'stn_bs03',
          measureNo: '2024-06-005',
          startDistanceM: 18.0,
          stageM: 5.36,
          method: 'ADCP',
          measuredAt: '2024-06-20T10:05:00.000Z'
        }
      ],
      verticals: [
        { id: 'vrt_bs_1', sectionId: 'sec_bs_2406', no: 1, startDistanceM: 10.0, depthM: 2.6, pointCount: 3, bedNote: 'ADCP 左半断面' },
        { id: 'vrt_bs_2', sectionId: 'sec_bs_2406', no: 2, startDistanceM: 24.0, depthM: 3.4, pointCount: 3, bedNote: 'ADCP 右半断面' }
      ],
      points: [
        { id: 'pnt_bs_11', verticalId: 'vrt_bs_1', relativeDepth: 0.2, velocityMs: 1.22, weight: 1 / 3, durationS: 120 },
        { id: 'pnt_bs_12', verticalId: 'vrt_bs_1', relativeDepth: 0.6, velocityMs: 1.08, weight: 1 / 3, durationS: 120 },
        { id: 'pnt_bs_13', verticalId: 'vrt_bs_1', relativeDepth: 0.8, velocityMs: 0.9, weight: 1 / 3, durationS: 120 },
        { id: 'pnt_bs_21', verticalId: 'vrt_bs_2', relativeDepth: 0.2, velocityMs: 1.46, weight: 1 / 3, durationS: 120 },
        { id: 'pnt_bs_22', verticalId: 'vrt_bs_2', relativeDepth: 0.6, velocityMs: 1.3, weight: 1 / 3, durationS: 120 },
        { id: 'pnt_bs_23', verticalId: 'vrt_bs_2', relativeDepth: 0.8, velocityMs: 1.1, weight: 1 / 3, durationS: 120 }
      ]
    }
  ]

  // 水位流量关系点据：A 线龙门、B 线青矶；C 线含 2 个明显偏离点（演示挂红）
  const ratingSeeds: Array<Omit<Rating, 'createdAt' | 'updatedAt' | 'status' | 'checkedAt' | 'sourceRevision' | 'sectionId'> & { sectionId?: string }> = [
    { id: 'rat_lh_a1', stationId: 'stn_lh01', stageM: 4.01, flowM3s: 97.5, lineNo: 'A', measureNo: '2024-04-001', measuredAt: '2024-04-08T08:00:00.000Z' },
    { id: 'rat_lh_a2', stationId: 'stn_lh01', stageM: 4.52, flowM3s: 138.7, lineNo: 'A', measureNo: '2024-05-002', measuredAt: '2024-05-16T08:00:00.000Z' },
    { id: 'rat_lh_a3', stationId: 'stn_lh01', stageM: 5.42, flowM3s: 217.2, lineNo: 'A', measureNo: '2024-06-001', measuredAt: '2024-06-12T08:30:00.000Z', sectionId: 'sec_lh_2406' },
    { id: 'rat_lh_a4', stationId: 'stn_lh01', stageM: 6.15, flowM3s: 298.5, lineNo: 'A', measureNo: '2024-07-002', measuredAt: '2024-07-18T09:10:00.000Z', sectionId: 'sec_lh_2407' },
    { id: 'rat_lh_a5', stationId: 'stn_lh01', stageM: 7.03, flowM3s: 428.1, lineNo: 'A', measureNo: '2024-08-006', measuredAt: '2024-08-21T08:20:00.000Z' },
    { id: 'rat_qj_b1', stationId: 'stn_qj02', stageM: 2.84, flowM3s: 42.3, lineNo: 'B', measureNo: '2023-05-001', measuredAt: '2023-05-11T07:30:00.000Z' },
    { id: 'rat_qj_b2', stationId: 'stn_qj02', stageM: 3.18, flowM3s: 56.1, lineNo: 'B', measureNo: '2024-05-003', measuredAt: '2024-05-22T07:50:00.000Z', sectionId: 'sec_qj_2405' },
    { id: 'rat_qj_b3', stationId: 'stn_qj02', stageM: 3.72, flowM3s: 78.4, lineNo: 'B', measureNo: '2024-07-001', measuredAt: '2024-07-02T08:10:00.000Z' },
    { id: 'rat_qj_b4', stationId: 'stn_qj02', stageM: 4.36, flowM3s: 115.6, lineNo: 'B', measureNo: '2024-08-004', measuredAt: '2024-08-09T06:40:00.000Z', sectionId: 'sec_qj_2408' },
    { id: 'rat_bs_c1', stationId: 'stn_bs03', stageM: 4.9, flowM3s: 168.0, lineNo: 'C', measureNo: '2024-05-004', measuredAt: '2024-05-28T09:00:00.000Z' },
    { id: 'rat_bs_c2', stationId: 'stn_bs03', stageM: 5.36, flowM3s: 203.5, lineNo: 'C', measureNo: '2024-06-005', measuredAt: '2024-06-20T10:05:00.000Z', sectionId: 'sec_bs_2406' },
    { id: 'rat_bs_c3', stationId: 'stn_bs03', stageM: 5.88, flowM3s: 325.0, lineNo: 'C', measureNo: '2024-07-007', measuredAt: '2024-07-25T09:30:00.000Z' },
    { id: 'rat_bs_c4', stationId: 'stn_bs03', stageM: 6.44, flowM3s: 288.0, lineNo: 'C', measureNo: '2024-08-008', measuredAt: '2024-08-15T09:40:00.000Z' }
  ]

  await fieldDb.transaction(
    'rw',
    [fieldDb.stations, fieldDb.sections, fieldDb.verticals, fieldDb.points, fieldDb.discharges],
    async () => {
      const stamp = (row: { id: string }): { createdAt: number; updatedAt: number } => ({
        createdAt: now + row.id.length,
        updatedAt: now + row.id.length
      })

      await fieldDb.stations.bulkPut(
        stationBundles.map((bundle) => ({ ...bundle.station, ...stamp(bundle.station) }))
      )
      await fieldDb.sections.bulkPut(
        stationBundles.flatMap((bundle) =>
          bundle.sections.map((section) => ({ ...section, ...stamp(section) }))
        )
      )
      await fieldDb.verticals.bulkPut(
        stationBundles.flatMap((bundle) =>
          bundle.verticals.map((vertical) => ({ ...vertical, ...stamp(vertical) }))
        )
      )
      await fieldDb.points.bulkPut(
        stationBundles.flatMap((bundle) =>
          bundle.points.map((point) => ({ ...point, ...stamp(point) }))
        )
      )
    }
  )

  // 外业断面流量成果：按当前垂线测点算出；演示测次均已报出整编室
  const sectionIds = stationBundles.flatMap((bundle) => bundle.sections.map((section) => section.id))
  const discharges: Discharge[] = []
  for (const sectionId of sectionIds) {
    const record = await recomputeDischarge(sectionId)
    if (record) {
      const reported: Discharge = { ...record, reported: true, reportedAt: iso, updatedAt: now }
      await fieldDb.discharges.put(reported)
      discharges.push(reported)
    }
  }

  const officeRatings: Rating[] = ratingSeeds.map((seed) => {
    const linked = discharges.find((discharge) => discharge.sectionId === seed.sectionId)
    return {
      ...seed,
      sectionId: seed.sectionId ?? '',
      sourceRevision: linked?.revision ?? 0,
      status: '正常',
      checkedAt: iso,
      createdAt: now,
      updatedAt: now
    }
  })

  // 比测当前结论 + 首版结论历史（每定线号一版）
  const lineGroups = new Map<string, Rating[]>()
  officeRatings.forEach((rating) => {
    const list = lineGroups.get(rating.lineNo) ?? []
    list.push(rating)
    lineGroups.set(rating.lineNo, list)
  })

  const compares: Compare[] = []
  const conclusions: CompareConclusion[] = []
  lineGroups.forEach((ratings, lineNo) => {
    const fit = fitPowerCurve(
      ratings.filter((r) => r.status === '正常').map((r) => ({ stageM: r.stageM, flowM3s: r.flowM3s })),
      lineNo
    )
    let overLimitCount = 0
    ratings.forEach((rating) => {
      const predicted = fit.valid
        ? round(fit.a * Math.pow(Math.max(rating.stageM - fit.h0, 1e-6), fit.b), 2)
        : rating.flowM3s
      const deviationPct = calcDeviationPct(rating.flowM3s, predicted)
      const verdict = judgeDeviation(deviationPct)
      if (verdict === '超限') overLimitCount += 1
      compares.push({
        id: `cmp_${rating.id}`,
        ratingId: rating.id,
        measuredFlow: rating.flowM3s,
        curveFlow: predicted,
        deviationPct,
        verdict,
        operator: lineNo === 'C' ? '周渝' : '林昭',
        comparedAt: rating.measuredAt,
        conclusionRev: 1,
        createdAt: now,
        updatedAt: now
      })
    })
    const sampleCount = ratings.length
    conclusions.push({
      id: createId('ccl'),
      lineNo,
      conclusionRev: 1,
      a: fit.a,
      b: fit.b,
      h0: fit.h0,
      sampleCount,
      meanResidualPct: fit.meanResidualPct,
      maxResidualPct: fit.maxResidualPct,
      qualifyRatePct: sampleCount === 0 ? 0 : Number((((sampleCount - overLimitCount) / sampleCount) * 100).toFixed(1)),
      overLimitCount,
      delivery: { ...createPendingDelivery(), status: '送交成功', lastAttemptAt: iso },
      operator: lineNo === 'C' ? '周渝' : '林昭',
      concludedAt: iso,
      createdAt: now,
      updatedAt: now
    })
  })

  await officeDb.transaction(
    'rw',
    [officeDb.stations, officeDb.ratings, officeDb.compares, officeDb.conclusions],
    async () => {
      // 整编室持共享台账副本（只读引用站名，编辑仍走外业主本）
      await officeDb.stations.bulkPut(
        stationBundles.map((bundle) => ({ ...bundle.station, createdAt: now, updatedAt: now }))
      )
      await officeDb.ratings.bulkPut(officeRatings)
      await officeDb.compares.bulkPut(compares)
      await officeDb.conclusions.bulkPut(conclusions)
    }
  )
}

/* ------------------------ 旧共库 → 两侧分库的迁移 ------------------------ */

interface LegacyRow {
  [key: string]: unknown
}

/** 旧版共库（v2）结构，仅用于迁移读取 */
class LegacyDatabase extends Dexie {
  [tableName: string]: unknown
  constructor() {
    super(LEGACY_DB_NAME)
    this.version(1).stores({
      stations: 'id, name, river, sectionCode',
      sections: 'id, stationId, measureNo, method',
      verticals: 'id, sectionId, no',
      points: 'id, verticalId, relativeDepth',
      ratings: 'id, stationId, lineNo, stageM',
      compares: 'id, ratingId, verdict'
    })
    this.version(2).stores({
      stations: 'id, name, river, sectionCode, catchmentKm2, updatedAt',
      sections: 'id, stationId, measureNo, method, stageM, measuredAt, updatedAt',
      verticals: 'id, sectionId, no, startDistanceM, depthM, updatedAt',
      points: 'id, verticalId, relativeDepth, velocityMs, updatedAt',
      ratings: 'id, stationId, lineNo, stageM, flowM3s, measuredAt, updatedAt',
      compares: 'id, ratingId, verdict, deviationPct, comparedAt, updatedAt'
    })
  }
}

/**
 * 第一次打开：旧共库数据先迁移到外业 / 整编两边再启用。
 * - 外业：stations / sections / verticals / points，并按垂线测点补算断面流量成果（标记已报出）
 * - 整编：台账副本 + 点据（按测站 + 测次号挂回源测次与成果版本）+ 比测结论 + 首版结论历史
 * - 任一侧库非空视为已迁移，避免重复搬运；迁移成功后删除旧共库
 */
export async function migrateLegacyDatabaseIfNeeded(): Promise<{ migrated: boolean; seeded: boolean }> {
  const marker = readMigrationMarker()
  const [fieldHasData, officeHasData, legacyExists] = await Promise.all([
    fieldDb.stations.count().then((count) => count > 0),
    officeDb.ratings.count().then((count) => count > 0),
    Dexie.exists(LEGACY_DB_NAME)
  ])

  if (marker) return { migrated: false, seeded: false }
  if (!legacyExists) {
    // 全新环境：两侧库都空才播种，避免覆盖导入数据
    if (!fieldHasData && !officeHasData) {
      await seedDemoData()
    }
    writeMigrationMarker()
    return { migrated: false, seeded: !fieldHasData && !officeHasData }
  }
  if (fieldHasData || officeHasData) {
    // 新库已有人用、旧库还在：旧库视为废弃，只补标记不再搬运
    writeMigrationMarker()
    return { migrated: false, seeded: false }
  }

  const legacy = new LegacyDatabase()
  await legacy.open()
  try {
    const read = async (name: string): Promise<LegacyRow[]> =>
      (legacy as unknown as { table: (name: string) => Table<LegacyRow, string> }).table(name).toArray()
    const [stations, sections, verticals, points, ratings, compares] = await Promise.all([
      read('stations'),
      read('sections'),
      read('verticals'),
      read('points'),
      read('ratings'),
      read('compares')
    ])

    // ---- 外业侧：原样落四表 ----
    await fieldDb.transaction(
      'rw',
      [fieldDb.stations, fieldDb.sections, fieldDb.verticals, fieldDb.points],
      async () => {
        if (stations.length) await fieldDb.stations.bulkPut(stations as unknown as Station[])
        if (sections.length) await fieldDb.sections.bulkPut(sections as unknown as Section[])
        if (verticals.length) await fieldDb.verticals.bulkPut(verticals as unknown as Vertical[])
        if (points.length) await fieldDb.points.bulkPut(points as unknown as Point[])
      }
    )
    // 按现有垂线测点补算断面流量；旧库时整编室已能用这些测次，统一标记已报出
    const now = Date.now()
    const iso = new Date(now).toISOString()
    const discharges: Discharge[] = []
    for (const section of sections as unknown as Section[]) {
      const record = await recomputeDischarge(section.id)
      if (record) {
        const reported: Discharge = { ...record, reported: true, reportedAt: iso, updatedAt: now }
        await fieldDb.discharges.put(reported)
        discharges.push(reported)
      }
    }

    // ---- 整编侧：台账副本 + 点据（挂源测次）+ 比测当前结论 + 首版历史 ----
    const dischargeByKey = new Map(
      discharges.map((discharge) => {
        const section = (sections as unknown as Section[]).find((item) => item.id === discharge.sectionId)
        return [`${section?.stationId ?? ''}|${section?.measureNo ?? ''}`, discharge]
      })
    )
    const migratedRatings: Rating[] = (ratings as unknown as Array<LegacyRow & Partial<Rating>>).map((row) => {
      const discharge = dischargeByKey.get(`${String(row.stationId ?? '')}|${String(row.measureNo ?? '')}`)
      const time = typeof row.updatedAt === 'number' ? row.updatedAt : now
      return {
        id: String(row.id),
        stationId: String(row.stationId ?? ''),
        stageM: Number(row.stageM ?? 0),
        flowM3s: Number(row.flowM3s ?? 0),
        lineNo: String(row.lineNo ?? 'A'),
        measureNo: String(row.measureNo ?? ''),
        measuredAt: typeof row.measuredAt === 'string' ? row.measuredAt : iso,
        sectionId: discharge?.sectionId ?? '',
        sourceRevision: discharge?.revision ?? 0,
        status: '正常',
        checkedAt: iso,
        createdAt: typeof row.createdAt === 'number' ? row.createdAt : time,
        updatedAt: time
      }
    })

    const legacyCompares = compares as unknown as Array<LegacyRow & Partial<Compare>>
    const migratedCompares: Compare[] = legacyCompares.map((row) => ({
      id: String(row.id),
      ratingId: String(row.ratingId ?? ''),
      measuredFlow: Number(row.measuredFlow ?? 0),
      curveFlow: Number(row.curveFlow ?? 0),
      deviationPct: Number(row.deviationPct ?? 0),
      verdict: row.verdict === '超限' ? '超限' : '合格',
      operator: String(row.operator ?? ''),
      comparedAt: typeof row.comparedAt === 'string' ? row.comparedAt : iso,
      conclusionRev: 1,
      createdAt: typeof row.createdAt === 'number' ? row.createdAt : now,
      updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : now
    }))

    const conclusions: CompareConclusion[] = []
    const lineNos = Array.from(new Set(migratedRatings.map((rating) => rating.lineNo)))
    lineNos.forEach((lineNo) => {
      const lineRatings = migratedRatings.filter((rating) => rating.lineNo === lineNo)
      const fit = fitPowerCurve(
        lineRatings.map((rating) => ({ stageM: rating.stageM, flowM3s: rating.flowM3s })),
        lineNo
      )
      const lineCompares = migratedCompares.filter((compare) =>
        lineRatings.some((rating) => rating.id === compare.ratingId)
      )
      const overLimitCount = lineCompares.filter((compare) => compare.verdict === '超限').length
      const sampleCount = lineCompares.length
      conclusions.push({
        id: createId('ccl'),
        lineNo,
        conclusionRev: 1,
        a: fit.a,
        b: fit.b,
        h0: fit.h0,
        sampleCount: lineRatings.length,
        meanResidualPct: fit.meanResidualPct,
        maxResidualPct: fit.maxResidualPct,
        qualifyRatePct: sampleCount === 0 ? 0 : Number((((sampleCount - overLimitCount) / sampleCount) * 100).toFixed(1)),
        overLimitCount,
        delivery: { ...createPendingDelivery(), status: '送交成功', lastAttemptAt: iso },
        operator: '迁移补登',
        concludedAt: iso,
        createdAt: now,
        updatedAt: now
      })
    })

    await officeDb.transaction(
      'rw',
      [officeDb.stations, officeDb.ratings, officeDb.compares, officeDb.conclusions],
      async () => {
        if (stations.length) await officeDb.stations.bulkPut(stations as unknown as Station[])
        if (migratedRatings.length) await officeDb.ratings.bulkPut(migratedRatings)
        if (migratedCompares.length) await officeDb.compares.bulkPut(migratedCompares)
        if (conclusions.length) await officeDb.conclusions.bulkPut(conclusions)
      }
    )

    // 搬运完成且行数核对一致后，删除旧共库
    const fieldStations = await fieldDb.stations.count()
    const officeRatingsCount = await officeDb.ratings.count()
    if (fieldStations === stations.length && officeRatingsCount === ratings.length) {
      await legacy.close()
      await Dexie.delete(LEGACY_DB_NAME)
    } else {
      await legacy.close()
    }
    writeMigrationMarker()
    return { migrated: true, seeded: false }
  } catch (error) {
    legacy.close()
    throw error
  }
}

function readMigrationMarker(): boolean {
  try {
    return localStorage.getItem(LS_KEYS.splitMigration) === 'done'
  } catch {
    return false
  }
}

function writeMigrationMarker(): void {
  try {
    localStorage.setItem(LS_KEYS.splitMigration, 'done')
  } catch {
    // 隐私模式下 localStorage 不可用，忽略即可
  }
}

/** 打开两侧数据库并执行首次迁移 / 播种，随后做一次跨侧对账 */
export async function initDatabase(): Promise<{ migrated: boolean; seeded: boolean }> {
  await Promise.all([fieldDb.open(), officeDb.open()])
  const result = await migrateLegacyDatabaseIfNeeded()
  await reconcileOfficeRatings()
  stampDbVersion()
  return result
}

/** 清空两侧全部业务表（导入覆盖与重置共用）；清空后播种再打迁移标记 */
export async function clearAllTables(): Promise<void> {
  await fieldDb.transaction(
    'rw',
    [fieldDb.stations, fieldDb.sections, fieldDb.verticals, fieldDb.points, fieldDb.discharges],
    async () => {
      await Promise.all([
        fieldDb.stations.clear(),
        fieldDb.sections.clear(),
        fieldDb.verticals.clear(),
        fieldDb.points.clear(),
        fieldDb.discharges.clear()
      ])
    }
  )
  await officeDb.transaction(
    'rw',
    [officeDb.stations, officeDb.ratings, officeDb.compares, officeDb.conclusions],
    async () => {
      await Promise.all([
        officeDb.stations.clear(),
        officeDb.ratings.clear(),
        officeDb.compares.clear(),
        officeDb.conclusions.clear()
      ])
    }
  )
}

/** 清空并重新播种演示数据 */
export async function resetDatabase(): Promise<void> {
  await clearAllTables()
  await seedDemoData()
}

/** 统计各表行数，供页脚概览与导出页展示 */
export async function countAll(): Promise<Record<string, number>> {
  const [stations, sections, verticals, points, discharges, ratings, compares, conclusions] = await Promise.all([
    fieldDb.stations.count(),
    fieldDb.sections.count(),
    fieldDb.verticals.count(),
    fieldDb.points.count(),
    fieldDb.discharges.count(),
    officeDb.ratings.count(),
    officeDb.compares.count(),
    officeDb.conclusions.count()
  ])
  return { stations, sections, verticals, points, discharges, ratings, compares, conclusions }
}

/** 写入结构版本号到 localStorage，便于导出页比对 */
export function stampDbVersion(): void {
  try {
    localStorage.setItem(LS_KEYS.dbVersion, String(DB_VERSION))
  } catch {
    // 隐私模式下 localStorage 不可用，忽略即可
  }
}

export function readStampedDbVersion(): number {
  try {
    const raw = localStorage.getItem(LS_KEYS.dbVersion)
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DB_VERSION
  } catch {
    return DB_VERSION
  }
}

export function stampBackupTime(iso: string): void {
  try {
    localStorage.setItem(LS_KEYS.lastBackupAt, iso)
  } catch {
    // 忽略
  }
}

export function readLastBackupAt(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastBackupAt)
  } catch {
    return null
  }
}

export function readLastStationId(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastStationId)
  } catch {
    return null
  }
}

export function writeLastStationId(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(LS_KEYS.lastStationId)
    else localStorage.setItem(LS_KEYS.lastStationId, id)
  } catch {
    // 忽略
  }
}

/** 计算某垂线的平均流速（页面展示共用同一套算法） */
export function verticalMeanVelocity(points: Point[]): number {
  return calcMeanVelocity(points.map((point) => ({ velocityMs: point.velocityMs, weight: point.weight })))
}

/** 供页面兜底：v2 迁移曾用的默认权重（外部文件可能引用） */
export { DEFAULT_WEIGHTS }
