/**
 * 旧单库迁移验证：
 * 预置旧库 gbhydrogaug（v2，含旧六表数据）→ bootstrap 应识别为 migrated，
 * 并把外业数据迁到外业库、点据/比测迁到整编室库；
 * 无报出对应的旧点据留档但不参与定线；旧库保留不删。
 */
import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { LEGACY_DB_NAME } from '../src/utils/legacyDb'
import { bootstrap } from '../src/utils/bootstrap'
import { fieldDb } from '../src/utils/fieldDb'
import { officeDb } from '../src/utils/officeDb'

const memoryStore = new Map<string, string>()
;(globalThis as { localStorage?: Storage }).localStorage = {
  getItem: (key: string) => (memoryStore.has(key) ? memoryStore.get(key)! : null),
  setItem: (key: string, value: string) => void memoryStore.set(key, String(value)),
  removeItem: (key: string) => void memoryStore.delete(key),
  clear: () => memoryStore.clear(),
  key: (index: number) => Array.from(memoryStore.keys())[index] ?? null,
  get length() {
    return memoryStore.size
  }
} as Storage

let passed = 0
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    console.error(`  ✗ ${name} ${extra}`)
    process.exitCode = 1
  }
}

async function seedLegacy(): Promise<void> {
  const legacy = new Dexie(LEGACY_DB_NAME)
  legacy.version(2).stores({
    stations: 'id, name, river, sectionCode, catchmentKm2, updatedAt',
    sections: 'id, stationId, measureNo, method, stageM, measuredAt, updatedAt',
    verticals: 'id, sectionId, no, startDistanceM, depthM, updatedAt',
    points: 'id, verticalId, relativeDepth, velocityMs, updatedAt',
    ratings: 'id, stationId, lineNo, stageM, flowM3s, measuredAt, updatedAt',
    compares: 'id, ratingId, verdict, deviationPct, comparedAt, updatedAt'
  })
  const now = Date.now()
  await legacy.table('stations').bulkPut([
    { id: 's1', name: '旧站', river: '旧河', catchmentKm2: 100, sectionCode: 'CS-1', remark: '', createdAt: now, updatedAt: now }
  ])
  await legacy.table('sections').bulkPut([
    { id: 'sec1', stationId: 's1', measureNo: '2024-01-001', startDistanceM: 1, stageM: 5, method: '流速仪', measuredAt: '2024-01-01T00:00:00.000Z', createdAt: now, updatedAt: now }
  ])
  await legacy.table('verticals').bulkPut([
    { id: 'v1', sectionId: 'sec1', no: 1, startDistanceM: 0, depthM: 2, pointCount: 2, bedNote: '', createdAt: now, updatedAt: now },
    { id: 'v2', sectionId: 'sec1', no: 2, startDistanceM: 8, depthM: 3, pointCount: 2, bedNote: '', createdAt: now, updatedAt: now }
  ])
  await legacy.table('points').bulkPut([
    { id: 'p1', verticalId: 'v1', relativeDepth: 0.2, velocityMs: 1, weight: 0.5, durationS: 100, createdAt: now, updatedAt: now },
    { id: 'p2', verticalId: 'v1', relativeDepth: 0.8, velocityMs: 0.8, weight: 0.5, durationS: 100, createdAt: now, updatedAt: now },
    { id: 'p3', verticalId: 'v2', relativeDepth: 0.2, velocityMs: 1.2, weight: 0.5, durationS: 100, createdAt: now, updatedAt: now },
    { id: 'p4', verticalId: 'v2', relativeDepth: 0.8, velocityMs: 1, weight: 0.5, durationS: 100, createdAt: now, updatedAt: now }
  ])
  await legacy.table('ratings').bulkPut([
    // 对得上报出测次（同站同测次号同水位）
    { id: 'r1', stationId: 's1', stageM: 5, flowM3s: 200, lineNo: 'A', measureNo: '2024-01-001', measuredAt: '2024-01-01T00:00:00.000Z', createdAt: now, updatedAt: now },
    // 无报出对应的历史点据
    { id: 'r2', stationId: 's1', stageM: 9, flowM3s: 900, lineNo: 'A', measureNo: '2020-01-009', measuredAt: '2020-09-01T00:00:00.000Z', createdAt: now, updatedAt: now }
  ])
  await legacy.table('compares').bulkPut([
    { id: 'c1', ratingId: 'r1', measuredFlow: 200, curveFlow: 201, deviationPct: 0.5, verdict: '合格', operator: '旧人', comparedAt: '2024-01-02T00:00:00.000Z', createdAt: now, updatedAt: now }
  ])
  legacy.close()
}

async function main(): Promise<void> {
  await seedLegacy()
  const result = await bootstrap()
  check('识别到旧库并走迁移', result.mode === 'migrated', `mode=${result.mode}`)
  check('外业库迁入测站/测次/垂线/测点',
    (await fieldDb.stations.count()) === 1 &&
    (await fieldDb.sections.count()) === 1 &&
    (await fieldDb.verticals.count()) === 2 &&
    (await fieldDb.points.count()) === 4)
  const migratedSection = await fieldDb.sections.get('sec1')
  check('迁入测次已带报出版本字段且视为已报出', migratedSection?.reported === true && migratedSection?.reportedRevision === 1)
  check('整编室名册来自同步', (await officeDb.stations.count()) === 1)
  check('整编室收到该测次报出成果', (await officeDb.inReports.where('sectionId').equals('sec1').count()) === 1)
  const officePoints = await officeDb.ratingPoints.toArray()
  const active = officePoints.filter((p) => p.status === 'active' || p.status === 'resolved')
  const rejected = officePoints.filter((p) => p.status === 'rejected')
  check('对得上报出的旧点据正常在案', active.some((p) => p.measureNo === '2024-01-001' && p.sectionId === 'sec1'))
  check('无报出对应的旧点据留档但弃用不定线', rejected.some((p) => p.measureNo === '2020-01-009'))
  check('整编室按迁移点据生成了比测结论批次', (await officeDb.compareRuns.count()) >= 1)
  check('旧库仍保留（未删除）', await Dexie.exists(LEGACY_DB_NAME))
  console.log(`\n通过 ${passed} 项断言`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
