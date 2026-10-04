/**
 * 整编室属主的领域模型：
 * - InReport：外业组报来的断面流量成果（不可变快照，只读）
 * - RatingPoint：水位流量关系点据（由报出成果落点，可挂起/复核）
 * - RatingLine：定线号台账（整编室管定线号）
 * - CompareRun / CompareItem：一次定线后的比测结论（追加留存，旧结论可查）
 *
 * 这些表只存在于整编室库 gbhydrogaug_office，外业库一律没有。
 */
import type { DischargeReportPayload } from './dispatch'

/** 外业报出成果的入账记录：整编室落点据的唯一合法来源 */
export interface InReport {
  /** = 消息幂等键（msg_discharge__sectionId__revision） */
  id: string
  stationId: string
  sectionId: string
  measureNo: string
  method: string
  stageM: number
  measuredAt: string
  flowM3s: number
  areaM2: number
  meanVelocityMs: number
  widthM: number
  maxDepthM: number
  verticalCount: number
  pointCount: number
  slices: DischargeReportPayload['slices']
  revision: number
  reportedAt: string
  receivedAt: number
  /** 该报出版本是否已被同测次更新版本取代（旧报出仍保留可查，但不再能落新点据） */
  superseded: boolean
}

/**
 * 关系点据状态：
 * - active   正常参与定线
 * - held     报出后外业又改了垂线/测点，先挂起等人复核，不参与定线也不挡别的点据
 * - resolved 复核确认后恢复参与定线
 * - rejected 复核判定弃用，永久退出定线（记录保留）
 */
export type RatingPointStatus = 'active' | 'held' | 'resolved' | 'rejected'

/** 挂起/复核原因 */
export type RatingPointHoldReason =
  | 'none' // 未挂起
  | 'source-changed' // 报出后外业改动了来源测次的垂线/测点
  | 'report-superseded' // 来源测次已有更新的报出版本

/** 水位流量关系点据（整编室属主）：由外业报出成果落入某定线号 */
export interface RatingPoint {
  id: string
  stationId: string
  /** 定线号：同一定线号的可用点据参与同一组拟合 */
  lineNo: string
  /** 水位（m），取自报出快照 */
  stageM: number
  /** 流量（m³/s），取自报出快照 */
  flowM3s: number
  /** 来源测次号（冗余便于展示） */
  measureNo: string
  /** 来源测次 id */
  sectionId: string
  /** 落自哪条报出记录（InReport.id） */
  reportId: string
  /** 落点时所依据的报出版本 */
  sourceRevision: number
  /** 点据时间（取自测流时间） */
  measuredAt: string
  status: RatingPointStatus
  holdReason: RatingPointHoldReason
  /** 挂起时间，null 表示当前未挂起 */
  heldAt: number | null
  /** 挂起说明（如改动原因） */
  holdNote: string
  /** 复核人 / 复核时间 / 复核意见 */
  reviewedBy: string
  reviewedAt: number | null
  reviewNote: string
  createdAt: number
  updatedAt: number
}

/** 定线号台账：整编室管理绳套曲线的各条线 */
export interface RatingLine {
  /** 定线号，如 A / B / C（主键即线号） */
  lineNo: string
  /** 所属测站（一条线原则上隶属一个测站） */
  stationId: string
  label: string
  enabled: boolean
  createdAt: number
  updatedAt: number
}

/** 一次比测结论中的逐点条目（随批次不可变留存） */
export interface CompareItem {
  ratingId: string
  measureNo: string
  stationId: string
  stageM: number
  measuredFlow: number
  curveFlow: number
  /** 偏差（%）：(曲线 - 实测) / 实测 × 100 */
  deviationPct: number
  verdict: '合格' | '超限'
  /** 落结论时该点据是否处于挂起（挂起点不参与定线，但结论留痕） */
  pointStatus: RatingPointStatus
}

/**
 * 比测结论批次：整编室每重新定线一次就追加一条，旧批次永不覆盖删除。
 * 送交外业失败时按本侧 outbox 重试，批次本身不动。
 */
export interface CompareRun {
  /** 批次 id（同时作为送交消息业务键，外业据此幂等去重） */
  id: string
  lineNo: string
  stationId: string
  /** 定线参数快照 */
  a: number
  b: number
  h0: number
  valid: boolean
  sampleCount: number
  meanResidualPct: number
  maxResidualPct: number
  r2: number
  items: CompareItem[]
  total: number
  qualified: number
  overLimit: number
  qualifyRatePct: number
  operator: string
  concludedAt: string
  /** 送交外业的状态（由整编室 outbox 派生回填，便于页面展示重试入口） */
  dispatchStatus: 'none' | 'pending' | 'delivered' | 'failed'
  lastDispatchError: string
  createdAt: number
  updatedAt: number
}
