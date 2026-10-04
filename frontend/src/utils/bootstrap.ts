/**
 * 双库启用引导（main.ts 首屏调用，幂等）：
 *  1. 打开外业库与整编室库；
 *  2. 若尚未完成分权启用（localStorage 无标记）：
 *     a. 发现旧单库 gbhydrogaug 且有数据 → 迁移规范化后装配到两边（旧库只读留档）；
 *     b. 否则 → 播种双库演示数据；
 *     装配完成后置「已启用」标记；
 *  3. 冲刷两侧发件箱（把可能残留的 pending/failed 尝试投递），各自处理收件箱。
 */
import { fieldDb, FIELD_DB_NAME, stampFieldDbVersion } from './fieldDb'
import { officeDb, OFFICE_DB_NAME, stampOfficeDbVersion } from './officeDb'
import { populateBothDatabases, sectionVersionDefaults, type LoadDataset } from './seed'
import { demoDataset } from './demoData'
import { readLegacyDatabase, legacyHasData, type LegacySnapshot } from './legacyDb'
import { flushSide } from './transport'
import { applyOfficeInbox } from './officeMessages'
import { applyFieldInbox } from './fieldMessages'

const ENABLED_KEY = 'gbhydrogaug:split-enabled-v1'

export interface BootstrapResult {
  mode: 'fresh' | 'migrated' | 'already'
  fieldDb: string
  officeDb: string
  legacyDetected: boolean
}

/** 把旧库快照规范化为双库装配输入 */
function normalizeLegacy(snapshot: LegacySnapshot): LoadDataset {
  const stations = snapshot.stations.map((s) => ({
    id: s.id,
    name: s.name,
    river: s.river,
    catchmentKm2: s.catchmentKm2,
    sectionCode: s.sectionCode,
    remark: s.remark,
    createdAt: s.createdAt ?? Date.now(),
    updatedAt: s.updatedAt ?? s.createdAt ?? Date.now()
  }))

  const sections = snapshot.sections.map((s) => ({
    id: s.id,
    stationId: s.stationId,
    measureNo: s.measureNo,
    startDistanceM: s.startDistanceM,
    stageM: s.stageM,
    method: (['流速仪', '浮标', 'ADCP'].includes(s.method) ? s.method : '流速仪') as LoadDataset['sections'][number]['method'],
    measuredAt: s.measuredAt,
    ...sectionVersionDefaults(),
    createdAt: s.createdAt ?? Date.now(),
    updatedAt: s.updatedAt ?? s.createdAt ?? Date.now()
  }))

  const verticals = snapshot.verticals.map((v) => ({
    id: v.id,
    sectionId: v.sectionId,
    no: v.no,
    startDistanceM: v.startDistanceM,
    depthM: v.depthM,
    pointCount: v.pointCount,
    bedNote: v.bedNote ?? '',
    createdAt: v.createdAt ?? Date.now(),
    updatedAt: v.updatedAt ?? v.createdAt ?? Date.now()
  }))

  const points = snapshot.points.map((pt) => ({
    id: pt.id,
    verticalId: pt.verticalId,
    relativeDepth: pt.relativeDepth,
    velocityMs: pt.velocityMs,
    weight: pt.weight,
    durationS: pt.durationS ?? 100,
    createdAt: pt.createdAt ?? Date.now(),
    updatedAt: pt.updatedAt ?? pt.createdAt ?? Date.now()
  }))

  const ratings = snapshot.ratings.map((r) => ({
    stationId: r.stationId,
    stageM: r.stageM,
    flowM3s: r.flowM3s,
    lineNo: r.lineNo,
    measureNo: r.measureNo,
    measuredAt: r.measuredAt
  }))

  return {
    stations,
    sections,
    verticals,
    points,
    ratings,
    baseTime: Date.now()
  }
}

function isEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) === '1'
  } catch {
    return false
  }
}

function markEnabled(): void {
  try {
    localStorage.setItem(ENABLED_KEY, '1')
  } catch {
    // 忽略
  }
}

/** 首屏启用入口：迁移旧库或播种，然后开始收发 */
export async function bootstrap(): Promise<BootstrapResult> {
  await fieldDb.open()
  await officeDb.open()
  stampFieldDbVersion()
  stampOfficeDbVersion()

  let mode: BootstrapResult['mode'] = 'already'
  let legacyDetected = false

  if (!isEnabled()) {
    const legacy = await readLegacyDatabase()
    legacyDetected = legacyHasData(legacy)
    if (legacyDetected && legacy) {
      await populateBothDatabases(normalizeLegacy(legacy))
      mode = 'migrated'
    } else {
      await populateBothDatabases(demoDataset)
      mode = 'fresh'
    }
    markEnabled()
  }

  // 先把两侧积压消息投出去，再各自入账（幂等，可反复执行）
  await flushSide('field')
  await flushSide('office')
  await applyOfficeInbox()
  await applyFieldInbox()

  return { mode, fieldDb: FIELD_DB_NAME, officeDb: OFFICE_DB_NAME, legacyDetected }
}

/** 双库都清空（重置演示数据用）：先清库再重新播种 */
export async function resetBothDatabases(): Promise<void> {
  await Promise.all([
    fieldDb.transaction(
      'rw',
      [fieldDb.stations, fieldDb.sections, fieldDb.verticals, fieldDb.points, fieldDb.outbox, fieldDb.inbox],
      async () => {
        await Promise.all([
          fieldDb.stations.clear(),
          fieldDb.sections.clear(),
          fieldDb.verticals.clear(),
          fieldDb.points.clear(),
          fieldDb.outbox.clear(),
          fieldDb.inbox.clear()
        ])
      }
    ),
    officeDb.transaction(
      'rw',
      [
        officeDb.stations,
        officeDb.stationRevs,
        officeDb.inReports,
        officeDb.ratingPoints,
        officeDb.ratingLines,
        officeDb.compareRuns,
        officeDb.outbox,
        officeDb.inbox
      ],
      async () => {
        await Promise.all([
          officeDb.stations.clear(),
          officeDb.stationRevs.clear(),
          officeDb.inReports.clear(),
          officeDb.ratingPoints.clear(),
          officeDb.ratingLines.clear(),
          officeDb.compareRuns.clear(),
          officeDb.outbox.clear(),
          officeDb.inbox.clear()
        ])
      }
    )
  ])
  await populateBothDatabases(demoDataset)
  await flushSide('field')
  await flushSide('office')
  await applyOfficeInbox()
  await applyFieldInbox()
}

/** 外业库清空（仅清外业侧，整编室那份不动；用于外业侧备份覆盖导入） */
export async function clearFieldDatabase(): Promise<void> {
  await fieldDb.transaction(
    'rw',
    [fieldDb.stations, fieldDb.sections, fieldDb.verticals, fieldDb.points, fieldDb.outbox, fieldDb.inbox],
    async () => {
      await Promise.all([
        fieldDb.stations.clear(),
        fieldDb.sections.clear(),
        fieldDb.verticals.clear(),
        fieldDb.points.clear(),
        fieldDb.outbox.clear(),
        fieldDb.inbox.clear()
      ])
    }
  )
}
