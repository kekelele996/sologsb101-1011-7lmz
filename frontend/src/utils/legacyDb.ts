/**
 * 旧单库 gbhydrogaug 的只读访问器（v2 结构）。
 * 仅在首次启用双库时用于迁移读取，迁移完成后不再打开、也不删除旧库（留档）。
 */
import Dexie from 'dexie'

export const LEGACY_DB_NAME = 'gbhydrogaug'

export interface LegacyStation {
  id: string
  name: string
  river: string
  catchmentKm2: number
  sectionCode: string
  remark: string
  createdAt?: number
  updatedAt?: number
}

export interface LegacySection {
  id: string
  stationId: string
  measureNo: string
  startDistanceM: number
  stageM: number
  method: string
  measuredAt: string
  createdAt?: number
  updatedAt?: number
}

export interface LegacyVertical {
  id: string
  sectionId: string
  no: number
  startDistanceM: number
  depthM: number
  pointCount: number
  bedNote: string
  createdAt?: number
  updatedAt?: number
}

export interface LegacyPoint {
  id: string
  verticalId: string
  relativeDepth: number
  velocityMs: number
  weight: number
  durationS: number
  createdAt?: number
  updatedAt?: number
}

export interface LegacyRating {
  id: string
  stationId: string
  stageM: number
  flowM3s: number
  lineNo: string
  measureNo: string
  measuredAt: string
  createdAt?: number
  updatedAt?: number
}

export interface LegacyCompare {
  id: string
  ratingId: string
  measuredFlow: number
  curveFlow: number
  deviationPct: number
  verdict: '合格' | '超限'
  operator: string
  comparedAt: string
  createdAt?: number
  updatedAt?: number
}

export interface LegacySnapshot {
  stations: LegacyStation[]
  sections: LegacySection[]
  verticals: LegacyVertical[]
  points: LegacyPoint[]
  ratings: LegacyRating[]
  compares: LegacyCompare[]
}

/** 以「不升级、不创建」的方式打开旧库读取数据；不存在则返回 null */
export async function readLegacyDatabase(): Promise<LegacySnapshot | null> {
  const exists = await Dexie.exists(LEGACY_DB_NAME)
  if (!exists) return null
  const legacy = new Dexie(LEGACY_DB_NAME)
  legacy.version(2).stores({
    stations: 'id, name, river, sectionCode, catchmentKm2, updatedAt',
    sections: 'id, stationId, measureNo, method, stageM, measuredAt, updatedAt',
    verticals: 'id, sectionId, no, startDistanceM, depthM, updatedAt',
    points: 'id, verticalId, relativeDepth, velocityMs, updatedAt',
    ratings: 'id, stationId, lineNo, stageM, flowM3s, measuredAt, updatedAt',
    compares: 'id, ratingId, verdict, deviationPct, comparedAt, updatedAt'
  })
  try {
    await legacy.open()
    const [stations, sections, verticals, points, ratings, compares] = await Promise.all([
      legacy.table('stations').toArray(),
      legacy.table('sections').toArray(),
      legacy.table('verticals').toArray(),
      legacy.table('points').toArray(),
      legacy.table('ratings').toArray(),
      legacy.table('compares').toArray()
    ])
    return { stations, sections, verticals, points, ratings, compares } as LegacySnapshot
  } finally {
    legacy.close()
  }
}

/** 旧库是否含任何业务数据 */
export function legacyHasData(snapshot: LegacySnapshot | null): boolean {
  if (!snapshot) return false
  return (
    snapshot.stations.length > 0 ||
    snapshot.sections.length > 0 ||
    snapshot.ratings.length > 0
  )
}
