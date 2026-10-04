/**
 * 整编室业务服务：
 *  - 落点据只能来自 inReports（外业已算出断面流量并报出的测次）；
 *  - 挂起点据可复核（恢复参与定线 / 判定弃用），挂起不挡其他点据；
 *  - 重新定线：用 active/resolved 点据拟合幂函数，追加 compareRuns 结论批次（旧批次留存），
 *    并把结论送交外业；送交失败只由整编室按 outbox 重试，外业那份不动。
 */
import { officeDb } from './officeDb'
import { createId } from './id'
import { enqueueMessage } from './transport'
import type { InReport, RatingPoint, RatingPointStatus, CompareRun, CompareItem } from '@/types/office'
import type { CompareConclusionPayload } from '@/types/dispatch'
import {
  calcDeviationPct,
  judgeDeviation,
  DEVIATION_LIMIT_PCT
} from '@/types/compare'
import { curveFlow, fitPowerCurve, type RatingFitResult } from '@/types/rating'

/** 可参与定线的点据状态（挂起与弃用都不参与） */
const FIT_STATUSES: RatingPointStatus[] = ['active', 'resolved']

/** 该定线号下可参与定线的点据（水位升序） */
export async function fittingPoints(lineNo: string): Promise<RatingPoint[]> {
  const rows = await officeDb.ratingPoints.where('lineNo').equals(lineNo).toArray()
  return rows.filter((p) => FIT_STATUSES.includes(p.status)).sort((a, b) => a.stageM - b.stageM)
}

/** 某报出成果是否已落到某定线号（同一测次同一定线号只允许一个在案点据） */
export async function findPointForReport(
  reportId: string,
  lineNo: string
): Promise<RatingPoint | undefined> {
  const rows = await officeDb.ratingPoints.where('reportId').equals(reportId).toArray()
  return rows.find((p) => p.lineNo === lineNo)
}

/**
 * 由报出成果落点据。这是整编室新增点据的唯一入口。
 * 已被更新版本取代的报出不能落点；同测次同线号已有非弃用点据时拒绝重复。
 */
export async function createPointFromReport(input: {
  reportId: string
  lineNo: string
  stationId: string
}): Promise<RatingPoint> {
  const report = await officeDb.inReports.get(input.reportId)
  if (!report) throw new Error('报出成果不存在：整编室只认外业已报出断面流量的测次')
  if (report.superseded) {
    throw new Error('该报出已被更新版本取代，请用最新报出成果落点')
  }

  return officeDb.transaction('rw', [officeDb.ratingPoints, officeDb.ratingLines], async () => {
    const duplicates = await officeDb.ratingPoints.where('sectionId').equals(report.sectionId).toArray()
    const clash = duplicates.find(
      (p) => p.lineNo === input.lineNo && p.status !== 'rejected'
    )
    if (clash) {
      throw new Error(`测次 ${report.measureNo} 在 ${input.lineNo} 线已有在案点据，不能重复落`)
    }
    const now = Date.now()
    const point: RatingPoint = {
      id: createId('rat'),
      stationId: input.stationId || report.stationId,
      lineNo: input.lineNo,
      stageM: report.stageM,
      flowM3s: report.flowM3s,
      measureNo: report.measureNo,
      sectionId: report.sectionId,
      reportId: report.id,
      sourceRevision: report.revision,
      measuredAt: report.measuredAt,
      status: 'active',
      holdReason: 'none',
      heldAt: null,
      holdNote: '',
      reviewedBy: '',
      reviewedAt: null,
      reviewNote: '',
      createdAt: now,
      updatedAt: now
    }
    await officeDb.ratingPoints.put(point)
    await ensureLine(input.lineNo, report.stationId)
    return point
  })
}

/** 确保定线号台账存在（落点 / 手动建线共用） */
export async function ensureLine(lineNo: string, stationId: string, label = ''): Promise<void> {
  const existing = await officeDb.ratingLines.get(lineNo)
  if (existing) return
  const now = Date.now()
  await officeDb.ratingLines.put({
    lineNo,
    stationId,
    label: label || `${lineNo} 线`,
    enabled: true,
    createdAt: now,
    updatedAt: now
  })
}

/** 调整点据所属定线号（整编室内部操作，不改变来源快照） */
export async function movePointLine(id: string, lineNo: string): Promise<void> {
  const point = await officeDb.ratingPoints.get(id)
  if (!point) return
  await officeDb.transaction('rw', [officeDb.ratingPoints, officeDb.ratingLines], async () => {
    await officeDb.ratingPoints.update(id, { lineNo, updatedAt: Date.now() } as never)
    const station = await officeDb.stations.get(point.stationId)
    await ensureLine(lineNo, station?.id ?? point.stationId)
  })
}

export async function updatePoint(id: string, patch: Partial<RatingPoint>): Promise<void> {
  await officeDb.ratingPoints.update(id, { ...patch, updatedAt: Date.now() } as never)
}

/** 删除点据（整编室操作）；其历史比测结论仍保留在 compareRuns 中可查 */
export async function removePoint(id: string): Promise<void> {
  await officeDb.ratingPoints.delete(id)
}

/** 复核挂起点据：确认有效（恢复参与定线）或判定弃用（退出定线但留档） */
export async function reviewPoint(input: {
  id: string
  action: 'resolve' | 'reject'
  reviewer: string
  note: string
}): Promise<void> {
  const point = await officeDb.ratingPoints.get(input.id)
  if (!point) throw new Error('点据不存在')
  const now = Date.now()
  const patch: Partial<RatingPoint> = {
    reviewedBy: input.reviewer || '整编室',
    reviewedAt: now,
    reviewNote: input.note,
    updatedAt: now
  }
  if (input.action === 'resolve') {
    patch.status = 'resolved'
    patch.holdReason = 'none'
    patch.heldAt = null
  } else {
    patch.status = 'rejected'
  }
  await officeDb.ratingPoints.update(input.id, patch as never)
}

/**
 * 重新定线并生成比测结论批次。
 * 仅用 active/resolved 点据拟合；逐点偏差按新曲线重算。
 * 返回新批次（已持久化）。送交外业由 dispatchConclusion 单独负责。
 */
export async function refitLine(input: {
  lineNo: string
  operator: string
  deviationLimitPct?: number
}): Promise<{ run: CompareRun; fit: RatingFitResult }> {
  const limit = input.deviationLimitPct ?? DEVIATION_LIMIT_PCT
  const points = await fittingPoints(input.lineNo)
  const fit = fitPowerCurve(
    points.map((p) => ({ stageM: p.stageM, flowM3s: p.flowM3s })),
    input.lineNo
  )

  const items: CompareItem[] = points.map((p) => {
    const predicted = fit.valid ? curveFlow(fit, p.stageM) : p.flowM3s
    const deviationPct = calcDeviationPct(p.flowM3s, predicted)
    return {
      ratingId: p.id,
      measureNo: p.measureNo,
      stationId: p.stationId,
      stageM: p.stageM,
      measuredFlow: p.flowM3s,
      curveFlow: predicted,
      deviationPct,
      verdict: judgeDeviation(deviationPct, limit),
      pointStatus: p.status
    }
  })
  const overLimit = items.filter((i) => i.verdict === '超限').length
  const total = items.length
  const runId = createId('run')
  const now = Date.now()
  const stationId = points[0]?.stationId ?? ''
  const run: CompareRun = {
    id: runId,
    lineNo: input.lineNo,
    stationId,
    a: fit.a,
    b: fit.b,
    h0: fit.h0,
    valid: fit.valid,
    sampleCount: fit.sampleCount,
    meanResidualPct: fit.meanResidualPct,
    maxResidualPct: fit.maxResidualPct,
    r2: fit.r2,
    items,
    total,
    qualified: total - overLimit,
    overLimit,
    qualifyRatePct: total === 0 ? 0 : Number((((total - overLimit) / total) * 100).toFixed(1)),
    operator: input.operator || '整编室',
    concludedAt: new Date(now).toISOString(),
    dispatchStatus: 'none',
    lastDispatchError: '',
    createdAt: now,
    updatedAt: now
  }
  await officeDb.compareRuns.put(run)
  return { run, fit }
}

/**
 * 把某条结论批次送交外业。只写整编室自己的 outbox；
 * 失败时批次置 failed 并可由 retryConclusion 在本侧重试，外业那份不动。
 */
export async function dispatchConclusion(runId: string): Promise<void> {
  const run = await officeDb.compareRuns.get(runId)
  if (!run) throw new Error('结论批次不存在')
  const station = await officeDb.stations.get(run.stationId)
  const payload: CompareConclusionPayload = {
    runId: run.id,
    lineNo: run.lineNo,
    stationId: run.stationId,
    stationName: station?.name ?? '未知测站',
    fit: {
      a: run.a,
      b: run.b,
      h0: run.h0,
      valid: run.valid,
      sampleCount: run.sampleCount,
      meanResidualPct: run.meanResidualPct,
      maxResidualPct: run.maxResidualPct,
      r2: run.r2
    },
    items: run.items.map((i) => ({
      ratingId: i.ratingId,
      measureNo: i.measureNo,
      stageM: i.stageM,
      measuredFlow: i.measuredFlow,
      curveFlow: i.curveFlow,
      deviationPct: i.deviationPct,
      verdict: i.verdict
    })),
    summary: {
      total: run.total,
      qualified: run.qualified,
      overLimit: run.overLimit,
      qualifyRatePct: run.qualifyRatePct
    },
    operator: run.operator,
    concludedAt: run.concludedAt
  }

  await officeDb.compareRuns.update(runId, { dispatchStatus: 'pending', updatedAt: Date.now() } as never)
  await enqueueMessage('office', 'compare-conclusion', payload)
  await syncRunDispatchState(runId)
}

/** 按 outbox 实际状态回填批次的送交状态（发送台账为准） */
export async function syncRunDispatchState(runId: string): Promise<void> {
  const box = await officeDb.outbox.get(`msg_conclusion__${runId}`)
  if (!box) return
  await officeDb.compareRuns.update(runId, {
    dispatchStatus: box.status,
    lastDispatchError: box.lastError,
    updatedAt: Date.now()
  } as never)
}

/** 同步全部批次的送交状态（重试/页面刷新后调用） */
export async function syncAllRunDispatchStates(): Promise<void> {
  const runs = await officeDb.compareRuns.toArray()
  for (const run of runs) {
    await syncRunDispatchState(run.id)
  }
}

/** 可落点的报出成果（未被取代、且在指定定线号尚无在案点据） */
export async function availableReports(lineNo: string): Promise<Array<InReport & { used: boolean }>> {
  const reports = await officeDb.inReports.toArray()
  const points = await officeDb.ratingPoints.where('lineNo').equals(lineNo).toArray()
  const usedSections = new Set(points.filter((p) => p.status !== 'rejected').map((p) => p.sectionId))
  return reports
    .filter((r) => !r.superseded)
    .sort((a, b) => Date.parse(b.measuredAt) - Date.parse(a.measuredAt))
    .map((r) => ({ ...r, used: usedSections.has(r.sectionId) }))
}
