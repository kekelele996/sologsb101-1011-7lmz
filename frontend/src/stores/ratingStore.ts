/**
 * 定线 store（整编室）：维护关系点据、当前比测结论、结论版本历史与送交状态。
 *
 * 归属边界：
 * - 只读外业库的测次与断面流量成果（fieldDb），落点据只认「已算出断面流量且已报出」的测次；
 * - 点据落库时带走外业成果快照（水位 / 断面流量 / 成果版本），存整编室自己的库；
 * - 外业报出后再改垂线测点 → 成果版本变 → reconcileWithField() 把引用旧版的点据挂起，
 *   只挂自己一条，不挡别的；恢复必须人工复核（采用新成果或作废）；
 * - 重新定线后当前比测结论原地刷新，并追加一版结论历史（旧结论照旧可查）；
 * - 送交失败只在整编库本侧重试，外业库那份成果不动。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { fieldDb, officeDb, createId, watchTable, reconcileOfficeRatings } from '@/utils/db'
import type { Compare, CompareConclusion, CompareDelivery, CompareRow } from '@/types/compare'
import { DEVIATION_LIMIT_PCT, calcDeviationPct, createPendingDelivery, judgeDeviation } from '@/types/compare'
import type { Rating, RatingFitResult, RatingFilterState, RatingStatus } from '@/types/rating'
import {
  createEmptyRatingFilter,
  curveFlow,
  fitPowerCurve,
  isRatingActive
} from '@/types/rating'
import type { Station } from '@/types/station'
import type { Section } from '@/types/section'
import type { Discharge } from '@/types/discharge'
import { isDischargeUsable } from '@/types/discharge'

/** 外业送交整编室的落点据候选项：已算出断面流量且已报出的测次 */
export interface ReportedMeasureCandidate {
  sectionId: string
  stationId: string
  measureNo: string
  stageM: number
  flowM3s: number
  method: Section['method']
  measuredAt: string
  revision: number
  /** 是否已被本定线号在同一成果版本引用（正常点据） */
  usedByLines: string[]
}

/** 送交尝试结果（只写整编库，外业无感知） */
export interface DeliveryAttemptResult {
  ok: boolean
  conclusion: CompareConclusion
  error?: string
}

export const useRatingStore = defineStore('rating', () => {
  const ratings = ref<Rating[]>([])
  const compares = ref<Compare[]>([])
  const conclusions = ref<CompareConclusion[]>([])
  const stations = ref<Station[]>([])
  // 外业库只读视图
  const fieldSections = ref<Section[]>([])
  const fieldDischarges = ref<Discharge[]>([])
  const ready = ref(false)
  const error = ref<string | null>(null)
  const filter = ref<RatingFilterState>(createEmptyRatingFilter())
  /** 当前定线号（跨页保留） */
  const activeLineNo = ref<string>('A')
  const deviationLimitPct = ref<number>(DEVIATION_LIMIT_PCT)
  /**
   * 演示开关：打开后下一次送交结论会失败，用于演示
   * 「送交失败后只有整编室按本侧重试，外业组那份不动」。
   */
  const simulateDeliveryFailure = ref(false)

  let started = false

  function start(): void {
    if (started) return
    started = true
    watchTable<Rating>(() => officeDb.ratings).subscribe((rows) => {
      ratings.value = rows
      ready.value = true
      error.value = null
    })
    watchTable<Compare>(() => officeDb.compares).subscribe((rows) => {
      compares.value = rows
    })
    watchTable<CompareConclusion>(() => officeDb.conclusions).subscribe((rows) => {
      conclusions.value = rows
    })
    watchTable<Station>(() => officeDb.stations).subscribe((rows) => {
      stations.value = rows
    })
    watchTable<Section>(() => fieldDb.sections).subscribe((rows) => {
      fieldSections.value = rows
    })
    watchTable<Discharge>(() => fieldDb.discharges).subscribe((rows) => {
      fieldDischarges.value = rows
    })
  }

  const lineNos = computed<string[]>(() => {
    const set = new Set<string>()
    ratings.value.forEach((rating) => set.add(rating.lineNo))
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  })

  const stationNameOf = (stationId: string): string =>
    stations.value.find((station) => station.id === stationId)?.name ?? '未知测站'

  /** 可落为关系点据的外业测次：断面流量已算出且已报出 */
  const reportedCandidates = computed<ReportedMeasureCandidate[]>(() => {
    return fieldDischarges.value
      .filter((discharge) => discharge.reported && isDischargeUsable(discharge))
      .map((discharge) => {
        const section = fieldSections.value.find((item) => item.id === discharge.sectionId)
        if (!section) return null
        const usedByLines = ratings.value
          .filter(
            (rating) =>
              rating.sectionId === section.id &&
              rating.status === '正常' &&
              rating.sourceRevision === discharge.revision
          )
          .map((rating) => rating.lineNo)
        return {
          sectionId: section.id,
          stationId: section.stationId,
          measureNo: section.measureNo,
          stageM: section.stageM,
          flowM3s: discharge.flowM3s,
          method: section.method,
          measuredAt: section.measuredAt,
          revision: discharge.revision,
          usedByLines
        }
      })
      .filter((item): item is ReportedMeasureCandidate => item !== null)
  })

  /** 某测次的候选（定点据对话框回显用） */
  function candidateOfSection(sectionId: string): ReportedMeasureCandidate | null {
    return reportedCandidates.value.find((item) => item.sectionId === sectionId) ?? null
  }

  /** 逐定线号的拟合结果（仅正常点据参与；挂起点据剔除，不挡别的点） */
  const allFits = computed<RatingFitResult[]>(() =>
    lineNos.value.map((lineNo) => {
      const points = activeRatingsOfLine(lineNo).map((rating) => ({
        stageM: rating.stageM,
        flowM3s: rating.flowM3s
      }))
      return fitPowerCurve(points, lineNo)
    })
  )

  function activeRatingsOfLine(lineNo: string): Rating[] {
    return ratings.value.filter((rating) => rating.lineNo === lineNo && isRatingActive(rating))
  }

  const activeFit = computed<RatingFitResult>(() => {
    const found = allFits.value.find((fit) => fit.lineNo === activeLineNo.value)
    if (found) return found
    return fitPowerCurve([], activeLineNo.value)
  })

  /** 当前定线号全部点据（含挂起），挂起不参与曲线，单独打标 */
  const pointRows = computed(() =>
    ratings.value
      .filter((rating) => rating.lineNo === activeLineNo.value)
      .sort((a, b) => a.stageM - b.stageM)
      .map((rating) => {
        const fit = activeFit.value
        const predicted = fit.valid && rating.status === '正常' ? curveFlow(fit, rating.stageM) : 0
        const residualPct =
          fit.valid && rating.status === '正常' && rating.flowM3s > 0
            ? Number((((rating.flowM3s - predicted) / rating.flowM3s) * 100).toFixed(2))
            : 0
        return { rating, predicted, residualPct }
      })
  )

  /** 挂起点据清单（等人复核） */
  const suspendedRatings = computed<Rating[]>(() =>
    ratings.value
      .filter((rating) => rating.status === '挂起')
      .sort((a, b) => b.updatedAt - a.updatedAt)
  )

  /** 按筛选条件过滤后的点据 */
  const filteredRatings = computed<Rating[]>(() =>
    ratings.value.filter((rating) => {
      const keyword = filter.value.keyword.trim()
      if (keyword.length > 0) {
        const haystack = `${rating.measureNo}${rating.lineNo}${stationNameOf(rating.stationId)}`
        if (!haystack.includes(keyword)) return false
      }
      if (filter.value.stationIds.length > 0 && !filter.value.stationIds.includes(rating.stationId)) return false
      if (filter.value.lineNos.length > 0 && !filter.value.lineNos.includes(rating.lineNo)) return false
      if (filter.value.statuses.length > 0 && !filter.value.statuses.includes(rating.status)) return false
      if (filter.value.verdicts.length > 0) {
        const compare = compares.value.find((item) => item.ratingId === rating.id)
        if (!compare || !filter.value.verdicts.includes(compare.verdict)) return false
      }
      return true
    })
  )

  const hasFilter = computed<boolean>(
    () =>
      filter.value.keyword.trim().length > 0 ||
      filter.value.stationIds.length > 0 ||
      filter.value.lineNos.length > 0 ||
      filter.value.verdicts.length > 0 ||
      filter.value.statuses.length > 0
  )

  /** 当前比测行：比测记录 + 点据 + 测站名（挂起点据带状态，不参与合格统计） */
  const compareRows = computed<CompareRow[]>(() =>
    compares.value
      .map((compare) => {
        const rating = ratings.value.find((item) => item.id === compare.ratingId) ?? null
        return {
          compare,
          rating,
          stationName: rating ? stationNameOf(rating.stationId) : '点据已删除',
          lineNo: rating?.lineNo ?? '-'
        }
      })
      .sort((a, b) => Math.abs(b.compare.deviationPct) - Math.abs(a.compare.deviationPct))
  )

  const overLimitRows = computed<CompareRow[]>(() =>
    compareRows.value.filter((row) => row.rating?.status === '正常' && row.compare.verdict === '超限')
  )

  /** 定线质量派生值：平均残差与合格点占比（只统计正常点据） */
  const fitQuality = computed(() => {
    const valid = allFits.value.filter((fit) => fit.valid)
    const meanResidual = valid.length
      ? Number((valid.reduce((sum, fit) => sum + fit.meanResidualPct, 0) / valid.length).toFixed(2))
      : 0
    const activeRows = compareRows.value.filter((row) => row.rating?.status === '正常')
    const total = activeRows.length
    const over = activeRows.filter((row) => row.compare.verdict === '超限').length
    return {
      validLineCount: valid.length,
      meanResidualPct: meanResidual,
      compareCount: total,
      overLimitCount: over,
      qualifyRatePct: total === 0 ? 0 : Number((((total - over) / total) * 100).toFixed(1))
    }
  })

  /** 某定线号的结论版本历史（新版本在前，旧结论照旧可查） */
  function conclusionHistory(lineNo: string): CompareConclusion[] {
    return conclusions.value
      .filter((conclusion) => conclusion.lineNo === lineNo)
      .sort((a, b) => b.conclusionRev - a.conclusionRev)
  }

  /** 某定线号当前生效结论（版本号最大的一版） */
  function currentConclusion(lineNo: string): CompareConclusion | null {
    return conclusionHistory(lineNo)[0] ?? null
  }

  /** 待重试的送交失败结论 */
  const failedDeliveries = computed<CompareConclusion[]>(() =>
    conclusions.value
      .filter((conclusion) => conclusion.delivery.status === '送交失败')
      .sort((a, b) => b.updatedAt - a.updatedAt)
  )

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

  function setSimulateDeliveryFailure(value: boolean): void {
    simulateDeliveryFailure.value = value
  }

  /* --------------------------- 点据：送交 / 复核 --------------------------- */

  /**
   * 整编室落点据：只认外业已算出断面流量、且已报出的测次。
   * 带走送交时刻的快照（水位 / 断面流量 / 成果版本），与外业库解耦。
   */
  async function createRatingFromSection(input: {
    sectionId: string
    lineNo: string
  }): Promise<Rating> {
    // 直接读外业库最新值（store 的 liveQuery 副本可能尚未刷新），整编室只读不写
    const discharge = await fieldDb.discharges.where('sectionId').equals(input.sectionId).first()
    const section = await fieldDb.sections.get(input.sectionId)
    if (!discharge || !section) {
      throw new Error('该测次还没有断面流量成果，整编室只接收已算出成果的测次')
    }
    if (!discharge.reported) {
      throw new Error('该测次尚未报出断面流量，等外业组报出后再落点据')
    }
    if (!isDischargeUsable(discharge)) {
      throw new Error('该测次断面流量成果无效（无垂线或流量为 0），不能落点据')
    }
    const lineNo = input.lineNo.trim() || 'A'
    const duplicate = ratings.value.find(
      (rating) =>
        rating.sectionId === section.id &&
        rating.lineNo === lineNo &&
        rating.status === '正常' &&
        rating.sourceRevision === discharge.revision
    )
    if (duplicate) {
      throw new Error(`测次 ${section.measureNo} 的当前成果已在 ${lineNo} 线落过点据`)
    }
    const now = Date.now()
    const iso = new Date(now).toISOString()
    const row: Rating = {
      id: createId('rat'),
      stationId: section.stationId,
      stageM: section.stageM,
      flowM3s: discharge.flowM3s,
      lineNo,
      measureNo: section.measureNo,
      sectionId: section.id,
      sourceRevision: discharge.revision,
      status: '正常',
      checkedAt: iso,
      measuredAt: section.measuredAt,
      createdAt: now,
      updatedAt: now
    }
    await officeDb.ratings.put(row)
    await rebuildCompares(lineNo)
    return row
  }

  /** 整编室自有调整：把点据挪到另一定线号（快照数据本身不允许手工改） */
  async function changeRatingLine(id: string, lineNo: string): Promise<void> {
    const rating = ratings.value.find((item) => item.id === id)
    if (!rating || rating.lineNo === lineNo) return
    const previousLine = rating.lineNo
    await officeDb.ratings.update(id, { lineNo, updatedAt: Date.now() } as never)
    await Promise.all([rebuildCompares(previousLine), rebuildCompares(lineNo)])
  }

  async function removeRating(id: string): Promise<void> {
    const rating = ratings.value.find((item) => item.id === id)
    await officeDb.transaction('rw', [officeDb.ratings, officeDb.compares], async () => {
      await officeDb.compares.where('ratingId').equals(id).delete()
      await officeDb.ratings.delete(id)
    })
    if (rating) await rebuildCompares(rating.lineNo)
  }

  /**
   * 与外业侧对账：源成果版本变化的点据挂起等人复核。
   * 有新挂起时，受影响定线重新出结论（挂起条不参与拟合，不挡别的点）。
   */
  async function reconcileWithField(): Promise<string[]> {
    const suspendedIds = await reconcileOfficeRatings()
    if (suspendedIds.length > 0) {
      const affectedLines = Array.from(
        new Set(
          suspendedIds
            .map((id) => ratings.value.find((rating) => rating.id === id)?.lineNo)
            .filter((lineNo): lineNo is string => !!lineNo)
        )
      )
      await Promise.all(affectedLines.map((lineNo) => rebuildCompares(lineNo)))
    }
    return suspendedIds
  }

  /**
   * 人工复核：采用外业最新成果，刷新快照与版本，恢复正常并重新出结论。
   */
  async function resumeRatingWithLatest(id: string): Promise<Rating> {
    const rating = ratings.value.find((item) => item.id === id)
    if (!rating) throw new Error('点据不存在')
    // 直接读外业库最新成果，避免 liveQuery 副本滞后
    const discharge = await fieldDb.discharges.where('sectionId').equals(rating.sectionId).first()
    const section = await fieldDb.sections.get(rating.sectionId)
    if (!discharge || !section || !isDischargeUsable(discharge)) {
      throw new Error('外业侧已没有可用的断面流量成果，无法采用新成果')
    }
    const now = Date.now()
    const iso = new Date(now).toISOString()
    const updated: Rating = {
      ...rating,
      stationId: section.stationId,
      stageM: section.stageM,
      flowM3s: discharge.flowM3s,
      measureNo: section.measureNo,
      measuredAt: section.measuredAt,
      sourceRevision: discharge.revision,
      status: '正常',
      checkedAt: iso,
      updatedAt: now
    }
    await officeDb.ratings.put(updated)
    await rebuildCompares(updated.lineNo)
    return updated
  }

  /** 人工复核：作废挂起点据（连同其当前比测记录），并重新出该线结论 */
  async function rejectSuspendedRating(id: string): Promise<void> {
    await removeRating(id)
  }

  /** 保持挂起：仅刷新检查时间（复核人员确认暂不处理，不挡其他点据） */
  async function keepSuspendedRating(id: string): Promise<void> {
    await officeDb.ratings.update(id, { checkedAt: new Date().toISOString(), updatedAt: Date.now() } as never)
  }

  /* ------------------------- 定线 / 比测结论版本化 ------------------------- */

  /**
   * 重新定线并刷新比测结论：
   * - 当前比测记录（compares）原地刷新为新版；
   * - 结论历史（conclusions）追加一版，旧版保留可查；
   * - 新结论自动尝试一次送交，失败仅记录在整编库本侧，等待按本侧重试。
   * 返回新版本号（点据不足以定线时返回上一版号，不追加历史）。
   */
  async function rebuildCompares(lineNo?: string): Promise<number> {
    const targetLine = lineNo ?? activeLineNo.value
    const active = activeRatingsOfLine(targetLine)
    const fit = fitPowerCurve(
      active.map((rating) => ({ stageM: rating.stageM, flowM3s: rating.flowM3s })),
      targetLine
    )

    const now = Date.now()
    const iso = new Date(now).toISOString()

    // 该线已不再正常参与的点据，其当前比测记录剔除（结论历史里旧版仍可查）
    const activeIds = new Set(active.map((rating) => rating.id))

    let conclusion: CompareConclusion
    let nextRev = 1
    await officeDb.transaction(
      'rw',
      [officeDb.compares, officeDb.conclusions],
      async () => {
        const lineConclusions = await officeDb.conclusions.where('lineNo').equals(targetLine).toArray()
        nextRev = lineConclusions.length === 0 ? 1 : Math.max(...lineConclusions.map((item) => item.conclusionRev)) + 1

        const lineRatingIds = ratings.value
          .filter((rating) => rating.lineNo === targetLine)
          .map((rating) => rating.id)
        const staleCompareIds =
          lineRatingIds.length > 0
            ? (await officeDb.compares.where('ratingId').anyOf(lineRatingIds).toArray())
                .filter((item) => !activeIds.has(item.ratingId))
                .map((item) => item.id)
            : []
        if (staleCompareIds.length > 0) await officeDb.compares.bulkDelete(staleCompareIds)

        const rows: Compare[] = active.map((rating) => {
          const predicted = fit.valid ? curveFlow(fit, rating.stageM) : rating.flowM3s
          const deviationPct = calcDeviationPct(rating.flowM3s, predicted)
          return {
            id: `cmp_${rating.id}`,
            ratingId: rating.id,
            measuredFlow: rating.flowM3s,
            curveFlow: predicted,
            deviationPct,
            verdict: judgeDeviation(deviationPct, deviationLimitPct.value),
            operator: '林昭',
            comparedAt: rating.measuredAt,
            conclusionRev: nextRev,
            createdAt: now,
            updatedAt: now
          }
        })

        const overLimitCount = rows.filter((row) => row.verdict === '超限').length
        const sampleCount = rows.length
        conclusion = {
          id: createId('ccl'),
          lineNo: targetLine,
          conclusionRev: nextRev,
          a: fit.a,
          b: fit.b,
          h0: fit.h0,
          sampleCount: active.length,
          meanResidualPct: fit.meanResidualPct,
          maxResidualPct: fit.maxResidualPct,
          qualifyRatePct:
            sampleCount === 0 ? 0 : Number((((sampleCount - overLimitCount) / sampleCount) * 100).toFixed(1)),
          overLimitCount,
          delivery: createPendingDelivery(),
          operator: '林昭',
          concludedAt: iso,
          createdAt: now,
          updatedAt: now
        }

        if (rows.length > 0) await officeDb.compares.bulkPut(rows)
        await officeDb.conclusions.put(conclusion)
      }
    )

    // 送交只走整编室一侧：成功失败都只改整编库结论行，外业成果不动
    await attemptDelivery(conclusion!.id)
    return nextRev
  }

  /**
   * 送交某版比测结论（整编室 → 外业 / 台账通道的本地模拟）。
   * 失败只落在本侧 delivery 上并可重试；任何情况下都不写外业库。
   */
  async function attemptDelivery(conclusionId: string): Promise<DeliveryAttemptResult> {
    const conclusion = await officeDb.conclusions.get(conclusionId)
    if (!conclusion) throw new Error('结论不存在')
    if (conclusion.delivery.status === '送交成功') {
      return { ok: true, conclusion }
    }
    const now = Date.now()
    const iso = new Date(now).toISOString()
    const attempts = conclusion.delivery.attempts + 1
    let delivery: CompareDelivery
    if (simulateDeliveryFailure.value) {
      delivery = {
        status: '送交失败',
        lastAttemptAt: iso,
        lastError: '外业通道暂不可用（演示失败），请稍后按本侧重试',
        attempts
      }
    } else {
      delivery = { status: '送交成功', lastAttemptAt: iso, lastError: '', attempts }
    }
    const updated: CompareConclusion = { ...conclusion, delivery, updatedAt: now }
    await officeDb.conclusions.put(updated)
    return delivery.status === '送交成功'
      ? { ok: true, conclusion: updated }
      : { ok: false, conclusion: updated, error: delivery.lastError }
  }

  /** 只重试整编库本侧的送交失败结论；外业那份数据完全不动 */
  async function retryFailedDeliveries(lineNo?: string): Promise<{ success: number; failed: number }> {
    const targets = conclusions.value.filter(
      (conclusion) => conclusion.delivery.status === '送交失败' && (!lineNo || conclusion.lineNo === lineNo)
    )
    let success = 0
    let failed = 0
    for (const conclusion of targets) {
      const result = await attemptDelivery(conclusion.id)
      if (result.ok) success += 1
      else failed += 1
    }
    return { success, failed }
  }

  return {
    ratings,
    compares,
    conclusions,
    stations,
    fieldSections,
    fieldDischarges,
    ready,
    error,
    filter,
    activeLineNo,
    activeFit,
    deviationLimitPct,
    simulateDeliveryFailure,
    lineNos,
    allFits,
    pointRows,
    suspendedRatings,
    filteredRatings,
    hasFilter,
    compareRows,
    overLimitRows,
    fitQuality,
    reportedCandidates,
    failedDeliveries,
    start,
    stationNameOf,
    candidateOfSection,
    conclusionHistory,
    currentConclusion,
    patchFilter,
    resetFilter,
    setActiveLine,
    setDeviationLimit,
    setSimulateDeliveryFailure,
    createRatingFromSection,
    changeRatingLine,
    removeRating,
    reconcileWithField,
    resumeRatingWithLatest,
    rejectSuspendedRating,
    keepSuspendedRating,
    rebuildCompares,
    attemptDelivery,
    retryFailedDeliveries
  }
})
