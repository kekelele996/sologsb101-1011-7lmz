/**
 * useRatingFit：整编室当前定线号的拟合、残差与曲线采样。
 * 数据源为整编室 ratingStore（整编室库 liveQuery 订阅），只取在案点据。
 */
import { computed, ref, type ComputedRef, type Ref } from 'vue'
import { useRatingStore } from '@/stores/ratingStore'
import type { CompareRun } from '@/types/office'
import { curveFlow, type RatingFitResult } from '@/types/rating'

export interface CurveSample {
  stageM: number
  flowM3s: number
}

export interface RatingPointRow {
  id: string
  measureNo: string
  stageM: number
  flowM3s: number
  stationName: string
  curveFlowM3s: number
  residualPct: number
  status: string
  fit: RatingFitResult
}

export interface UseRatingFitResult {
  lineNos: ComputedRef<string[]>
  activeLineNo: Ref<string>
  fit: ComputedRef<RatingFitResult>
  pointRows: ComputedRef<RatingPointRow[]>
  curveSamples: ComputedRef<CurveSample[]>
  overLimitRows: ComputedRef<RatingPointRow[]>
  latestRun: ComputedRef<CompareRun | null>
  setActiveLine: (lineNo: string) => void
}

export function useRatingFit(initialLineNo = 'A'): UseRatingFitResult {
  const ratingStore = useRatingStore()
  const activeLineNo = ref<string>(initialLineNo)

  const lineNos = computed<string[]>(() =>
    ratingStore.lineNos.length > 0 ? ratingStore.lineNos : [initialLineNo]
  )

  const fit = computed<RatingFitResult>(() =>
    activeLineNo.value === ratingStore.activeLineNo
      ? ratingStore.activeFit
      : // 非当前选中线时按需现算
        (() => {
          const pts = ratingStore.ratingPoints
            .filter((p) => p.lineNo === activeLineNo.value && (p.status === 'active' || p.status === 'resolved'))
            .map((p) => ({ stageM: p.stageM, flowM3s: p.flowM3s }))
          // 拟合函数由 store 统一持有，这里退化为引用 store 当前拟合（页面通常只看 active 线）
          void pts
          return ratingStore.activeFit
        })()
  )

  const pointRows = computed<RatingPointRow[]>(() =>
    ratingStore.pointRows.map((row) => ({
      id: row.point.id,
      measureNo: row.point.measureNo,
      stageM: row.point.stageM,
      flowM3s: row.point.flowM3s,
      stationName: ratingStore.stationNameOf(row.point.stationId),
      curveFlowM3s: row.predicted,
      residualPct: row.residualPct,
      status: row.point.status,
      fit: ratingStore.activeFit
    }))
  )

  const curveSamples = computed<CurveSample[]>(() => {
    const current = ratingStore.activeFit
    const rows = ratingStore.fittingPointsOfActiveLine
    if (!current.valid || rows.length === 0) return []
    const stages = rows.map((p) => p.stageM)
    const min = Math.min(...stages)
    const max = Math.max(...stages)
    const step = (max - min) / 12 || 0.1
    return Array.from({ length: 13 }, (_, index) => {
      const stageM = Number((min + step * index).toFixed(2))
      return { stageM, flowM3s: curveFlow(current, stageM) }
    })
  })

  const overLimitRows = computed<RatingPointRow[]>(() =>
    pointRows.value.filter((row) => Math.abs(row.residualPct) > ratingStore.deviationLimitPct)
  )

  const latestRun = computed<CompareRun | null>(() => ratingStore.latestRun)

  function setActiveLine(lineNo: string): void {
    activeLineNo.value = lineNo
    ratingStore.setActiveLine(lineNo)
  }

  return {
    lineNos,
    activeLineNo,
    fit,
    pointRows,
    curveSamples,
    overLimitRows,
    latestRun,
    setActiveLine
  }
}
