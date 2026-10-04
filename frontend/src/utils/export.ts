/**
 * 备份导入导出：两侧分库整库 JSON 快照的组装、校验、下载与导入。
 * 与 utils/db.ts 的 BackupPayload 结构保持一致：
 * 外业侧 stations/sections/verticals/points/discharges；
 * 整编侧 stationsOffice/ratings/compares/conclusions。
 */
import {
  fieldDb,
  officeDb,
  DB_NAME,
  DB_VERSION,
  createId,
  clearAllTables,
  stampBackupTime,
  type BackupPayload
} from '@/utils/db'

/** 备份集合键名（前五个为外业侧，后四个为整编侧） */
export const BACKUP_KEYS = [
  'stations',
  'sections',
  'verticals',
  'points',
  'discharges',
  'stationsOffice',
  'ratings',
  'compares',
  'conclusions'
] as const
export type BackupKey = (typeof BACKUP_KEYS)[number]

/** 各表行数统计（导出页展示与导入结果回执共用） */
export type CountMap = Record<BackupKey, number>

/** 组装当前两侧数据的完整快照 */
export async function buildBackupPayload(): Promise<BackupPayload> {
  const [stations, sections, verticals, points, discharges, stationsOffice, ratings, compares, conclusions] =
    await Promise.all([
      fieldDb.stations.toArray(),
      fieldDb.sections.toArray(),
      fieldDb.verticals.toArray(),
      fieldDb.points.toArray(),
      fieldDb.discharges.toArray(),
      officeDb.stations.toArray(),
      officeDb.ratings.toArray(),
      officeDb.compares.toArray(),
      officeDb.conclusions.toArray()
    ])
  return {
    app: 'gbhydrogaug',
    dbVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    stations,
    sections,
    verticals,
    points,
    discharges,
    stationsOffice,
    ratings,
    compares,
    conclusions
  }
}

/** 兼容旧版（v2，六表共库）备份文件的读取 */
function readLegacyArrays(obj: Partial<BackupPayload> & Record<string, unknown>): {
  stations: BackupPayload['stations']
  sections: BackupPayload['sections']
  verticals: BackupPayload['verticals']
  points: BackupPayload['points']
  discharges: BackupPayload['discharges']
  stationsOffice: BackupPayload['stationsOffice']
  ratings: BackupPayload['ratings']
  compares: BackupPayload['compares']
  conclusions: BackupPayload['conclusions']
  legacy: boolean
} {
  const asArray = <T>(key: string): T[] => (Array.isArray(obj[key]) ? (obj[key] as T[]) : [])
  const stations = asArray<BackupPayload['stations'][number]>('stations')
  const legacy = !Array.isArray(obj.discharges)
  return {
    stations,
    sections: asArray('sections'),
    verticals: asArray('verticals'),
    points: asArray('points'),
    discharges: asArray('discharges'),
    stationsOffice: Array.isArray(obj.stationsOffice) ? (obj.stationsOffice as BackupPayload['stationsOffice']) : stations,
    ratings: asArray('ratings'),
    compares: asArray('compares'),
    conclusions: asArray('conclusions'),
    legacy
  }
}

/** 校验外部 JSON 是否为本站可识别的备份文件 */
export function validateBackup(input: unknown): { ok: boolean; errors: string[]; payload: BackupPayload | null } {
  const errors: string[] = []
  if (typeof input !== 'object' || input === null) {
    return { ok: false, errors: ['文件内容不是合法的 JSON 对象'], payload: null }
  }
  const obj = input as Partial<BackupPayload> & Record<string, unknown>
  if (obj.app !== 'gbhydrogaug' && obj.app !== undefined) {
    errors.push('app 字段应为 gbhydrogaug，文件来源不明')
  }
  // 新旧两版都必须含核心六表；discharges/stationsOffice/conclusions 为 v3 新增
  for (const key of ['stations', 'sections', 'verticals', 'points', 'ratings', 'compares'] as const) {
    if (!Array.isArray(obj[key])) errors.push(`${key} 字段缺失或不是数组`)
  }
  if (errors.length > 0) return { ok: false, errors, payload: null }
  const parts = readLegacyArrays(obj)
  const payload: BackupPayload = {
    app: 'gbhydrogaug',
    dbVersion: typeof obj.dbVersion === 'number' ? obj.dbVersion : DB_VERSION,
    exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : new Date().toISOString(),
    stations: parts.stations,
    sections: parts.sections,
    verticals: parts.verticals,
    points: parts.points,
    discharges: parts.discharges,
    stationsOffice: parts.stationsOffice,
    ratings: parts.ratings,
    compares: parts.compares,
    conclusions: parts.conclusions
  }
  return { ok: true, errors, payload }
}

/** 统计快照各表行数 */
export function countPayload(payload: BackupPayload): CountMap {
  return {
    stations: payload.stations.length,
    sections: payload.sections.length,
    verticals: payload.verticals.length,
    points: payload.points.length,
    discharges: payload.discharges.length,
    stationsOffice: payload.stationsOffice.length,
    ratings: payload.ratings.length,
    compares: payload.compares.length,
    conclusions: payload.conclusions.length
  }
}

/** 导出 JSON 文件到浏览器下载目录 */
export async function exportBackupJson(): Promise<{ fileName: string; counts: CountMap }> {
  const payload = await buildBackupPayload()
  const fileName = `${DB_NAME}-backup-v${payload.dbVersion}-${payload.exportedAt
    .slice(0, 19)
    .replace(/[:T]/g, '')}.json`
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
  stampBackupTime(payload.exportedAt)
  return { fileName, counts: countPayload(payload) }
}

/** 读取用户选择的备份文件文本 */
export function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('文件读取失败'))
    reader.readAsText(file, 'utf-8')
  })
}

/**
 * 导入快照：overwrite=true 先清空两侧全部表，否则按主键合并。
 * 外业四表 + 成果落外业库；台账副本、点据、比测、结论历史落整编库。
 */
export async function importBackup(payload: BackupPayload, overwrite: boolean): Promise<CountMap> {
  if (overwrite) await clearAllTables()
  await fieldDb.transaction(
    'rw',
    [fieldDb.stations, fieldDb.sections, fieldDb.verticals, fieldDb.points, fieldDb.discharges],
    async () => {
      await fieldDb.stations.bulkPut(payload.stations)
      await fieldDb.sections.bulkPut(payload.sections)
      await fieldDb.verticals.bulkPut(payload.verticals)
      await fieldDb.points.bulkPut(payload.points)
      if (payload.discharges.length > 0) await fieldDb.discharges.bulkPut(payload.discharges)
    }
  )
  await officeDb.transaction(
    'rw',
    [officeDb.stations, officeDb.ratings, officeDb.compares, officeDb.conclusions],
    async () => {
      await officeDb.stations.bulkPut(payload.stationsOffice)
      await officeDb.ratings.bulkPut(payload.ratings)
      await officeDb.compares.bulkPut(payload.compares)
      if (payload.conclusions.length > 0) await officeDb.conclusions.bulkPut(payload.conclusions)
    }
  )
  return countPayload(payload)
}

/** 追加式导入：为导入数据重新分配 id，避免覆盖现有档案（两侧引用同步重映射） */
export function remapIds(payload: BackupPayload): BackupPayload {
  const stationMap = new Map<string, string>()
  const sectionMap = new Map<string, string>()
  const verticalMap = new Map<string, string>()
  const ratingMap = new Map<string, string>()

  const stations = payload.stations.map((station) => {
    const id = createId('stn')
    stationMap.set(station.id, id)
    return { ...station, id }
  })
  const sections = payload.sections.map((section) => {
    const id = createId('sec')
    sectionMap.set(section.id, id)
    return { ...section, id, stationId: stationMap.get(section.stationId) ?? section.stationId }
  })
  const verticals = payload.verticals.map((vertical) => {
    const id = createId('vrt')
    verticalMap.set(vertical.id, id)
    return { ...vertical, id, sectionId: sectionMap.get(vertical.sectionId) ?? vertical.sectionId }
  })
  const points = payload.points.map((point) => ({
    ...point,
    id: createId('pnt'),
    verticalId: verticalMap.get(point.verticalId) ?? point.verticalId
  }))
  const discharges = payload.discharges.map((discharge) => ({
    ...discharge,
    id: createId('dch'),
    sectionId: sectionMap.get(discharge.sectionId) ?? discharge.sectionId
  }))
  const stationsOffice = payload.stationsOffice.map((station) => ({
    ...station,
    id: stationMap.get(station.id) ?? station.id
  }))
  const ratings = payload.ratings.map((rating) => {
    const id = createId('rat')
    ratingMap.set(rating.id, id)
    return {
      ...rating,
      id,
      stationId: stationMap.get(rating.stationId) ?? rating.stationId,
      sectionId: rating.sectionId ? sectionMap.get(rating.sectionId) ?? '' : ''
    }
  })
  const compares = payload.compares.map((compare) => ({
    ...compare,
    id: createId('cmp'),
    ratingId: ratingMap.get(compare.ratingId) ?? compare.ratingId
  }))
  const conclusions = payload.conclusions.map((conclusion) => ({
    ...conclusion,
    id: createId('ccl')
  }))
  return {
    ...payload,
    stations,
    sections,
    verticals,
    points,
    discharges,
    stationsOffice,
    ratings,
    compares,
    conclusions
  }
}

/**
 * 生成结论文本：按测站输出最新水位、断面测次、定线参数与超限点据。
 * 供导出页的「检测结论」区域使用。
 */
export interface ConclusionLine {
  stationId: string
  stationName: string
  river: string
  sectionCount: number
  latestStageM: number | null
  ratingCount: number
  suspendedCount: number
  overLimitCount: number
  fitText: string
}

export function buildConclusionLines(
  payload: BackupPayload,
  fits: Array<{ lineNo: string; valid: boolean; a: number; b: number; h0: number; meanResidualPct: number; sampleCount: number }>
): ConclusionLine[] {
  return payload.stations.map((station) => {
    const sections = payload.sections.filter((section) => section.stationId === station.id)
    const latest = sections.reduce<number | null>((acc, section) => {
      if (acc === null) return section.stageM
      return section.stageM > acc ? section.stageM : acc
    }, null)
    const ratings = payload.ratings.filter((rating) => rating.stationId === station.id)
    const activeRatings = ratings.filter((rating) => rating.status === '正常')
    const ratingIds = new Set(activeRatings.map((rating) => rating.id))
    const overLimitCount = payload.compares.filter(
      (compare) => ratingIds.has(compare.ratingId) && compare.verdict === '超限'
    ).length
    const suspendedCount = ratings.filter((rating) => rating.status === '挂起').length
    const lines = Array.from(new Set(activeRatings.map((rating) => rating.lineNo)))
    const fitParts = lines.map((lineNo) => {
      const fit = fits.find((item) => item.lineNo === lineNo)
      if (!fit || !fit.valid) return `${lineNo} 线未定线`
      return `${lineNo} 线 Q=${fit.a}·(H-${fit.h0})^${fit.b}，残差 ${fit.meanResidualPct}%（${fit.sampleCount} 点）`
    })
    return {
      stationId: station.id,
      stationName: station.name,
      river: station.river,
      sectionCount: sections.length,
      latestStageM: latest,
      ratingCount: activeRatings.length,
      suspendedCount,
      overLimitCount,
      fitText: fitParts.length > 0 ? fitParts.join('；') : '暂无关系点据'
    }
  })
}
