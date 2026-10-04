/**
 * 双库分权端到端验证（fake-indexeddb，全新环境）：
 * 1. bootstrap 播种 → 两库各持数据；
 * 2. 整编落点据只认已报出测次；
 * 3. 外业报出后改测点 → 对应点据挂起，别的点据不受影响；
 * 4. 重新定线追加比测结论（旧结论留存）；
 * 5. 通道故障送交失败 → 只整编侧重试成功，外业数据不变。
 */
import 'fake-indexeddb/auto'

// Node 测试环境补 localStorage（故障开关/启用标记依赖它）
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

import { bootstrap } from '../src/utils/bootstrap'
import { fieldDb } from '../src/utils/fieldDb'
import { officeDb } from '../src/utils/officeDb'
import {
  availableReports,
  createPointFromReport,
  dispatchConclusion,
  fittingPoints,
  refitLine,
  reviewPoint,
  syncAllRunDispatchStates
} from '../src/utils/officeService'
import { applyOfficeInbox } from '../src/utils/officeMessages'
import { applyFieldInbox } from '../src/utils/fieldMessages'
import { isChannelBlocked, retrySide, setChannelBlocked } from '../src/utils/transport'
import { notifySectionsChanged } from '../src/utils/fieldService'

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

async function main(): Promise<void> {
  // 1. 全新播种
  const result = await bootstrap()
  check('全新环境 bootstrap 模式为 fresh', result.mode === 'fresh')
  check('外业库有测站/测次/垂线/测点', (await fieldDb.stations.count()) === 3 && (await fieldDb.sections.count()) === 6)
  check('整编室名册有测站（同步而来）', (await officeDb.stations.count()) === 3)
  const inReports = await officeDb.inReports.toArray()
  check('整编室收到已算出成果的报出（5 个带垂线测次）', inReports.length === 5, `actual=${inReports.length}`)
  const runs0 = await officeDb.compareRuns.toArray()
  check('播种后整编室已有首轮比测结论（A/B/C）', runs0.length === 3, `actual=${runs0.length}`)
  const seedConclusions = await fieldDb.inbox.where('kind').equals('compare-conclusion').count()
  check('首轮结论已送交外业收件箱（旧结论可查）', seedConclusions === 3, `actual=${seedConclusions}`)

  // 2. 落点据只认报出：未报出测次 sec_lh_2409 不能落；
  //    播种时对得上报出的点据已在案，故 06-001/07-002 标 used。
  const reportsA = await availableReports('A')
  check('可落报出里不含未报出测次', !reportsA.some((r) => r.sectionId === 'sec_lh_2409'))
  const lh06 = reportsA.find((r) => r.sectionId === 'sec_lh_2406')
  const lh07 = reportsA.find((r) => r.sectionId === 'sec_lh_2407')
  check('06-001 / 07-002 报出存在且已在案（used）', !!lh06 && !!lh07 && lh06!.used && lh07!.used)
  // 同测次同线号重复落点应拒绝
  let dupError = ''
  try {
    await createPointFromReport({ reportId: lh06!.id, lineNo: 'A', stationId: '' })
  } catch (e) {
    dupError = (e as Error).message
  }
  check('同测次同线号禁止重复落点', dupError.includes('已有在案点据'))

  // 把一份报出落到它尚未在案的另一定线号（允许跨线，同测次同线仍唯一）
  const qj05 = (await officeDb.inReports.where('sectionId').equals('sec_qj_2405').toArray())[0]
  await createPointFromReport({ reportId: qj05.id, lineNo: 'A', stationId: '' })
  const aPointsExtra = await officeDb.ratingPoints.where('lineNo').equals('A').toArray()
  check('可把报出落到其尚未在案的另一定线号', aPointsExtra.some((p) => p.sectionId === 'sec_qj_2405'))

  const fitA = await fittingPoints('A')
  check('A 线在案点据为 3（播种2 + 跨线落1）', fitA.length === 3, `actual=${fitA.length}`)

  // 4. 外业报出后改测点 → 挂起
  // sec_lh_2406 已在 A 线落点；修改其一个测点流速
  const point = await fieldDb.points.where('verticalId').equals('vrt_lh_1').first()
  await fieldDb.points.update(point!.id, { velocityMs: 0.99, updatedAt: Date.now() })
  const vertical = await fieldDb.verticals.get('vrt_lh_1')
  await notifySectionsChanged([vertical!.sectionId], '外业修改了流速测点')
  await applyOfficeInbox()
  const heldPoints = await officeDb.ratingPoints.where('status').equals('held').toArray()
  const held06 = heldPoints.find((p) => p.sectionId === 'sec_lh_2406')
  check('改动后对应点据挂起', !!held06, `held=${heldPoints.length}`)
  const held07 = heldPoints.find((p) => p.sectionId === 'sec_lh_2407')
  check('挂起不影响别的点据（07-002 未挂）', !held07)
  const fitAAfter = await fittingPoints('A')
  check('挂起点据退出定线（A 在案剩 2）', fitAAfter.length === 2, `actual=${fitAAfter.length}`)

  // 复核：确认有效恢复
  await reviewPoint({ id: held06!.id, action: 'resolve', reviewer: '测试', note: '复核确认' })
  const fitAResolved = await fittingPoints('A')
  check('复核确认后恢复参与定线（A 在案回到 3）', fitAResolved.length === 3)

  // 5. 重新定线追加结论 + 旧结论留存（用 B 线，播种在案点 05-003/08-004 共2点仍不足3；
  // 用历史迁移场景外，这里直接验证 compareRuns 追加不覆盖：对 A 线 refit 即使 invalid 也追加一批）
  const runsBefore = await officeDb.compareRuns.where('lineNo').equals('A').count()
  const { run: newRun } = await refitLine({ lineNo: 'A', operator: '测试员', deviationLimitPct: 8 })
  const runsAfter = await officeDb.compareRuns.where('lineNo').equals('A').count()
  check('重新定线追加一批结论（不覆盖旧批次）', runsAfter === runsBefore + 1, `${runsBefore}->${runsAfter}`)
  check('新结论批次有独立 runId', !!newRun.id && newRun.operator === '测试员')

  // 6. 通道故障：送交失败只留在整编 outbox，外业 inbox 无新结论
  setChannelBlocked('office', 'field', true)
  check('故障开关生效', isChannelBlocked('office', 'field'))
  const fieldConclusionsBefore = await fieldDb.inbox.where('kind').equals('compare-conclusion').count()
  await dispatchConclusion(newRun.id)
  await syncAllRunDispatchStates()
  const runRow = await officeDb.compareRuns.get(newRun.id)
  check('故障下送交状态为 failed', runRow?.dispatchStatus === 'failed')
  const fieldConclusionsMid = await fieldDb.inbox.where('kind').equals('compare-conclusion').count()
  check('故障时外业未收到新结论', fieldConclusionsMid === fieldConclusionsBefore)

  // 外业那份不动：统计外业业务表行数
  const fieldSections = await fieldDb.sections.count()
  const fieldVerticals = await fieldDb.verticals.count()

  // 恢复通道，仅整编侧重试
  setChannelBlocked('office', 'field', false)
  const retry = await retrySide('office')
  await syncAllRunDispatchStates()
  await applyFieldInbox()
  const runRow2 = await officeDb.compareRuns.get(newRun.id)
  const fieldConclusionsAfter = await fieldDb.inbox.where('kind').equals('compare-conclusion').count()
  check('整编侧重试后送达（sent≥1）', retry.sent >= 1, `sent=${retry.sent}`)
  check('重试后批次状态 delivered', runRow2?.dispatchStatus === 'delivered')
  check('外业收到该结论（inbox +1）', fieldConclusionsAfter === fieldConclusionsBefore + 1)
  check('重试过程外业业务数据不变', (await fieldDb.sections.count()) === fieldSections && (await fieldDb.verticals.count()) === fieldVerticals)

  console.log(`\n通过 ${passed} 项断言`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
