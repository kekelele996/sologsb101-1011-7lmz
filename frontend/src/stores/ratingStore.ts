/**
 * 整编室 · 定线 store：关系点据、定线号台账、比测结论批次（均在整编室库）。
 *
 * 分权规则：
 *  - 点据只能由外业报出成果落入（createPointFromReport），不能凭空录入；
 *  - 报出后外业改动 → 相关点据 held 挂起（不参与定线、不挡别的），人工复核后 resolve/reject；
 *  - 重新定线追加 compareRuns（旧批次留存可查），并送交外业；
 *  - 送交失败只由整编室在本侧重试，外业那份不动。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { officeDb, watchTable } from '@/utils/officeDb'
import {
  availableReports,
  createPointFromReport,
  dispatchConclusion,
  ensureLine,
  fittingPoints,
  movePointLine,
  refitLine,
  removePoint,
  reviewPoint,
  syncAllRunDispatchStates,
  updatePoint
} from '@/utils/officeService'
import { applyOfficeInbox } from '@/utils/officeMessages'
import { retrySide } from '@/utils/transport'
import type { CompareRun, InReport, RatingLine, RatingPoint } from '@/types/office'
import type { RatingFitResult } from '@/types/rating'
import { curveFlow, fitPowerCurve } from '@/types/rating'
import { DEVIATION_LIMIT_PCT } from '@/types/compare'
import type { Station } from '@/types/station'
import { createEmptyRatingFilter, type RatingFilterState } from '@/types/rating'

export interface ReportOption extends InReport {
  used: boolean
}

export const useRatingStore = defineStore('rating', () => {
  const stations = ref<Station[]>([])
  const reports = ref<InReport[]>([])
  const ratingPoints = ref<RatingPoint[]>([])
  const ratingLines = ref<RatingLine[]>([])
  const compareRuns = ref<CompareRun[]>([])
  const ready = ref(false)
  const error = ref<string | null>(null)
  const filter = ref<RatingFilterState>(createEmptyRatingFilter())
  const activeLineNo = ref<string>('A')
  const deviationLimitPct = ref<number>(DEVIATION_LIMIT_PCT)
  const operator = ref<string>('林昭')

  let started = false

  function start(): void {
    if (started) return
    started = true
    watchTable<Station>(() => officeDb.stations).subscribe((rows) => {
      stations.value = rows
      ready.value = true
    })
    watchTable<InReport>(() => officeDb.inReports).subscribe((rows) => {
      reports.value = rows
    })
    watchTable<RatingPoint>(() => officeDb.ratingPoints).subscribe((rows) => {
      ratingPoints.value = rows
    })
    watchTable<RatingLine>(() => officeDb.ratingLines).subscribe((rows) => {
      ratingLines.value = rows
    })
    watchTable<CompareRun>(() => officeDb.compareRuns).subscribe((rows) => {
      compareRuns.value = rows
    })
  }

  /** 拉取新到消息（外业报出/改动）并入账 */
  async function refreshInbox(): Promise<{ reports: number; held: number }> {
    const result = await applyOfficeInbox()
    return { reports: result.reports, held: result.held }
  }

  const stationNameOf = (stationId: string): string =>
    stations.value.find((station) => station.id === stationId)?.name ?? '未知测站'

  /** 定线号集合：以点据里出现过的线号为准，并补台账 */
  const lineNos = computed<string[]>(() => {
    const set = new Set<string>()
    ratingPoints.value.forEach((p) => set.add(p.lineNo))
    ratingLines.value.forEach((l) => set.add(l.lineNo))
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  })

  /** 当前线全部点据（含非在案） */
  const pointsOfActiveLine = computed<RatingPoint[]>(() =>
    ratingPoints.value
      .filter((p) => p.lineNo === activeLineNo.value)
      .sort((a, b) => a.stageM - b.stageM)
  )

  /** 当前线可参与定线的点据 */
  const fittingPointsOfActiveLine = computed<RatingPoint[]>(() =>
    pointsOfActiveLine.value.filter((p) => p.status === 'active' || p.status === 'resolved')
  )

  const heldPoints = computed<RatingPoint[]>(() =>
    ratingPoints.value.filter((p) => p.status === 'held')
  )

  /** 当前定线实时拟合（只取在案点据） */
  const activeFit = computed<RatingFitResult>(() =>
    fitPowerCurve(
      fittingPointsOfActiveLine.value.map((p) => ({ stageM: p.stageM, flowM3s: p.flowM3s })),
      activeLineNo.value
    )
  )

  /** 点据行：含曲线流量、残差、挂起标记 */
  const pointRows = computed(() =>
    pointsOfActiveLine.value.map((point) => {
      const fit = activeFit.value
      const predicted = fit.valid ? curveFlow(fit, point.stageM) : 0
      const residualPct =
        fit.valid && point.flowM3s > 0
          ? Number((((point.flowM3s - predicted) / point.flowM3s) * 100).toFixed(2))
          : 0
      const verdict = Math.abs(residualPct) > deviationLimitPct.value ? '超限' : '合格'
      return { point, predicted, residualPct, verdict }
    })
  )

  const filteredRatings = computed<RatingPoint[]>(() =>
    ratingPoints.value.filter((point) => {
      const keyword = filter.value.keyword.trim()
      if (keyword.length > 0) {
        const haystack = `${point.measureNo}${point.lineNo}${stationNameOf(point.stationId)}`
        if (!haystack.includes(keyword)) return false
      }
      if (filter.value.stationIds.length > 0 && !filter.value.stationIds.includes(point.stationId)) return false
      if (filter.value.lineNos.length > 0 && !filter.value.lineNos.includes(point.lineNo)) return false
      if (filter.value.verdicts.length > 0) {
        const residual = pointRows.value.find((row) => row.point.id === point.id)
        const verdict = (residual?.verdict ?? '合格') as '合格' | '超限'
        if (!filter.value.verdicts.includes(verdict)) return false
      }
      return true
    })
  )

  const hasFilter = computed<boolean>(
    () =>
      filter.value.keyword.trim().length > 0 ||
      filter.value.stationIds.length > 0 ||
      filter.value.lineNos.length > 0 ||
      filter.value.verdicts.length > 0
  )

  /** 最新一轮比测结论（当前线） */
  const latestRun = computed<CompareRun | null>(() => {
    const runs = compareRuns.value
      .filter((run) => run.lineNo === activeLineNo.value)
      .sort((a, b) => b.createdAt - a.createdAt)
    return runs[0] ?? null
  })

  /** 当前线历史结论批次（旧结论可查） */
  const runsOfActiveLine = computed<CompareRun[]>(() =>
    compareRuns.value
      .filter((run) => run.lineNo === activeLineNo.value)
      .sort((a, b) => b.createdAt - a.createdAt)
  )

  /** 全站送交失败待重试的批次数（导航徽标） */
  const failedDispatchCount = computed<number>(
    () => compareRuns.value.filter((run) => run.dispatchStatus === 'failed').length
  )

  /** 最新结论的比测行（分析清单用） */
  const compareRows = computed(() => {
    const run = latestRun.value
    if (!run) return []
    return run.items
      .map((item) => ({
        run,
        item,
        stationName: stationNameOf(item.stationId),
        lineNo: run.lineNo
      }))
      .sort((a, b) => Math.abs(b.item.deviationPct) - Math.abs(a.item.deviationPct))
  })

  const overLimitRows = computed(() => compareRows.value.filter((row) => row.item.verdict === '超限'))

  const fitQuality = computed(() => {
    const run = latestRun.value
    return {
      compareCount: run?.total ?? 0,
      overLimitCount: run?.overLimit ?? 0,
      qualifyRatePct: run?.qualifyRatePct ?? 0,
      meanResidualPct: run?.meanResidualPct ?? 0,
      valid: run?.valid ?? false
    }
  })

  function patchFilter(patch: Partial<RatingFilterState>): void {
    filter.value = { ...filter.value, ...patch }
  }

  function resetFilter(): void {
    filter.value = createEmptyRatingFilter()
  }

  function setActiveLine(lineNo: string): void {
    activeLineNo.value = lineNo
  }

  function setDeviationLimit(limit: number): void {
    deviationLimitPct.value = limit
  }

  function setOperator(name: string): void {
    operator.value = name
  }

  /** 可落点的报出成果（当前线、未被取代、未在案） */
  async function reportOptions(lineNo: string): Promise<ReportOption[]> {
    return availableReports(lineNo)
  }

  /** 由外业报出成果落点据（唯一合法新增入口） */
  async function addPointFromReport(reportId: string, lineNo: string): Promise<RatingPoint> {
    const point = await createPointFromReport({ reportId, lineNo, stationId: '' })
    return point
  }

  async function editPoint(id: string, patch: Partial<RatingPoint>): Promise<void> {
    await updatePoint(id, patch)
  }

  async function changePointLine(id: string, lineNo: string): Promise<void> {
    await movePointLine(id, lineNo)
  }

  async function deletePoint(id: string): Promise<void> {
    await removePoint(id)
  }

  async function resolvePoint(id: string, note: string): Promise<void> {
    await reviewPoint({ id, action: 'resolve', reviewer: operator.value, note })
  }

  async function rejectPoint(id: string, note: string): Promise<void> {
    await reviewPoint({ id, action: 'reject', reviewer: operator.value, note })
  }

  async function addLine(lineNo: string, stationId: string, label?: string): Promise<void> {
    await ensureLine(lineNo, stationId, label)
  }

  /** 重新定线：追加比测结论批次（旧结论留存），并送交外业 */
  async function refitAndDispatch(lineNo?: string): Promise<{ run: CompareRun; fit: RatingFitResult }> {
    const target = lineNo ?? activeLineNo.value
    const usable = await fittingPoints(target)
    if (usable.length === 0) {
      throw new Error('当前定线号没有在案点据，无法定线')
    }
    const { run } = await refitLine({ lineNo: target, operator: operator.value, deviationLimitPct: deviationLimitPct.value })
    await dispatchConclusion(run.id)
    return { run, fit: activeFit.value }
  }

  /** 仅重定线出结论，暂不送交（用户也可稍后在档案页送交） */
  async function refitOnly(lineNo?: string): Promise<CompareRun> {
    const target = lineNo ?? activeLineNo.value
    const usable = await fittingPoints(target)
    if (usable.length === 0) throw new Error('当前定线号没有在案点据，无法定线')
    const { run } = await refitLine({ lineNo: target, operator: operator.value, deviationLimitPct: deviationLimitPct.value })
    return run
  }

  /** 送交某条历史结论批次 */
  async function sendRun(runId: string): Promise<void> {
    await dispatchConclusion(runId)
  }

  /**
   * 整编室按本侧重试送交：只刷整编室 outbox，再回填批次状态。
   * 外业库除了在通道恢复时接收 inbox 外不做任何改动。
   */
  async function retryDispatch(): Promise<{ sent: number; stillFailing: number }> {
    const result = await retrySide('office')
    await syncAllRunDispatchStates()
    return result
  }

  async function syncDispatchStates(): Promise<void> {
    await syncAllRunDispatchStates()
  }

  return {
    // state
    stations,
    reports,
    ratingPoints,
    ratingLines,
    compareRuns,
    ready,
    error,
    filter,
    activeLineNo,
    deviationLimitPct,
    operator,
    // derived
    lineNos,
    pointsOfActiveLine,
    fittingPointsOfActiveLine,
    heldPoints,
    activeFit,
    pointRows,
    filteredRatings,
    hasFilter,
    latestRun,
    runsOfActiveLine,
    failedDispatchCount,
    compareRows,
    overLimitRows,
    fitQuality,
    // lifecycle / actions
    start,
    refreshInbox,
    stationNameOf,
    patchFilter,
    resetFilter,
    setActiveLine,
    setDeviationLimit,
    setOperator,
    reportOptions,
    addPointFromReport,
    editPoint,
    changePointLine,
    deletePoint,
    resolvePoint,
    rejectPoint,
    addLine,
    refitAndDispatch,
    refitOnly,
    sendRun,
    retryDispatch,
    syncDispatchStates
  }
})
