/**
 * 比测结论（整编室持有）
 *
 * 整编室重新定线后，比测结论跟着重算：每个点据的「当前结论」原地刷新，
 * 同时每出一版结论留一条历史（conclusionRev），旧结论照旧可查。
 * 送交失败只影响整编室一侧，重试也只动本侧数据，外业那份成果不做任何改动。
 */
import type { Rating } from './rating'

/** 比测判定结论 */
export type CompareVerdict = '合格' | '超限'

/** 比测偏差允许限值（%）：超过则判定超限并挂红 */
export const DEVIATION_LIMIT_PCT = 8

/** 比测记录：实测流量与曲线流量的偏差分析（每点据一条，定线后原地刷新为当前版） */
export interface Compare {
  id: string
  /** 被比测的关系点据 */
  ratingId: string
  /** 实测流量（m³/s，取点据快照） */
  measuredFlow: number
  /** 曲线流量（m³/s） */
  curveFlow: number
  /** 偏差（%）：(曲线 - 实测) / 实测 × 100 */
  deviationPct: number
  /** 合格 / 超限 */
  verdict: CompareVerdict
  /** 比测人 */
  operator: string
  /** 比测日期 */
  comparedAt: string
  /** 本结论对应的定线版本（CompareConclusion.conclusionRev），重新定线后 +1 */
  conclusionRev: number
  createdAt: number
  updatedAt: number
}

/**
 * 比测结论版本快照（追加留档，永不覆盖）：
 * 每次重新定线写一版，页面默认看当前版，旧版可在结论历史中查阅。
 */
export interface CompareConclusion {
  id: string
  /** 定线号 */
  lineNo: string
  /** 结论版本：该定线号每重算一次 +1 */
  conclusionRev: number
  /** 定线参数：Q = a × (H - h0)^b */
  a: number
  b: number
  h0: number
  /** 参与本版比测的正常点据数 */
  sampleCount: number
  /** 本版平均残差（%） */
  meanResidualPct: number
  /** 本版最大残差（%） */
  maxResidualPct: number
  /** 本版合格率（%） */
  qualifyRatePct: number
  /** 超限点据数 */
  overLimitCount: number
  /** 送交状态：整编室 → 外业 / 台账的送交通道；失败只在整编室侧重试 */
  delivery: CompareDelivery
  /** 定线 / 比测人 */
  operator: string
  /** 本版生成时间（ISO） */
  concludedAt: string
  createdAt: number
  updatedAt: number
}

/** 结论送交状态机：待送交 → 送交成功 / 送交失败（可按本侧重试） */
export interface CompareDelivery {
  status: '待送交' | '送交失败' | '送交成功'
  /** 最近一次尝试送交的时间（ISO），未尝试为 null */
  lastAttemptAt: string | null
  /** 最近一次失败原因，成功后清空 */
  lastError: string
  /** 已尝试次数（重试累加，外业侧不感知） */
  attempts: number
}

/** 按偏差计算判定结论 */
export function judgeDeviation(deviationPct: number, limit = DEVIATION_LIMIT_PCT): CompareVerdict {
  return Math.abs(deviationPct) > limit ? '超限' : '合格'
}

/** 计算偏差百分比 */
export function calcDeviationPct(measuredFlow: number, curveFlowValue: number): number {
  if (!Number.isFinite(measuredFlow) || measuredFlow === 0) return 0
  return Number((((curveFlowValue - measuredFlow) / measuredFlow) * 100).toFixed(2))
}

/** 初始送交状态（结论刚生成，尚未送交） */
export function createPendingDelivery(): CompareDelivery {
  return { status: '待送交', lastAttemptAt: null, lastError: '', attempts: 0 }
}

/** 比测行：当前比测记录 + 所属点据，供导出页与分析清单展示 */
export interface CompareRow {
  compare: Compare
  rating: Rating | null
  stationName: string
  lineNo: string
}
