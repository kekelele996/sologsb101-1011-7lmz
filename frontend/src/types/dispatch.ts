/**
 * 两边「送交」的统一消息契约：外业组报出断面流量、整编室送交比测结论，
 * 以及外业组改了垂线/测点后通知整编室挂起点据，都走同一套信封。
 *
 * 发送方只写自己库的 outbox（发件箱），再由本机消息通道 attemptDispatch
 * 投递到接收方库的 inbox（收件箱）。投递失败只在发送方侧重试，绝不触碰
 * 对方库之外的任何业务表。
 */

/** 发送方身份：外业组 / 整编室 */
export type OwnerSide = 'field' | 'office'

/** 消息类型 */
export type DispatchKind =
  /** 测站档案同步（外业 → 整编，整编室据此维护只读测站名册） */
  | 'station-sync'
  /** 断面流量成果报出（外业 → 整编，整编室落点据只认这种消息） */
  | 'discharge-report'
  /** 报出后外业又改了垂线/测点，通知整编把相关点据先挂起（外业 → 整编） */
  | 'section-changed'
  /** 整编室定线/比测完成后送交的比测结论（整编 → 外业，旧结论留存可查） */
  | 'compare-conclusion'

/** 发件箱/收件箱消息的投递状态 */
export type DispatchStatus =
  | 'pending' // 待发送
  | 'delivered' // 已送达（outbox 侧保留为发送台账，inbox 侧即已入账）
  | 'failed' // 投递失败，等待发送方重试

/** 测站档案同步载荷（外业是测站档案的唯一属主） */
export interface StationSyncPayload {
  station: {
    id: string
    name: string
    river: string
    catchmentKm2: number
    sectionCode: string
    remark: string
  }
  /** 档案版本：随每次外业修改递增，整编室只接受更新版本 */
  revision: number
}

/** 部分面积法单垂线成果（报出快照的一部分） */
export interface VerticalSnapshot {
  no: number
  startDistanceM: number
  depthM: number
  meanVelocityMs: number
  partialAreaM2: number
  partialFlow: number
}

/**
 * 断面流量成果报出载荷：不可变快照。
 * 整编室落点据只引用这份快照，外业随后怎么改都不会改写它。
 */
export interface DischargeReportPayload {
  stationId: string
  sectionId: string
  measureNo: string
  method: string
  stageM: number
  measuredAt: string
  /** 报出时算出的断面流量（m³/s）——整编室只认已算出成果的测次 */
  flowM3s: number
  areaM2: number
  meanVelocityMs: number
  widthM: number
  maxDepthM: number
  verticalCount: number
  pointCount: number
  slices: VerticalSnapshot[]
  /** 报出版本：同一测次每报出一次 +1，整编室据此把旧版标为 superseded */
  revision: number
  reportedAt: string
}

/** 报出后测次被改动的通知载荷（只携带定位信息，不带新成果） */
export interface SectionChangedPayload {
  stationId: string
  sectionId: string
  measureNo: string
  /** 触发通知时该测次的当前版本（>已报出版本即代表成果已过时） */
  revision: number
  changedAt: string
  reason: string
}

/** 一次定线/比测结论送交载荷（整编 → 外业） */
export interface CompareConclusionPayload {
  /** 结论批次 id（整编室 compare-runs 的主键），外业按它幂等去重 */
  runId: string
  lineNo: string
  stationId: string
  stationName: string
  /** 本次定线参数快照 */
  fit: {
    a: number
    b: number
    h0: number
    valid: boolean
    sampleCount: number
    meanResidualPct: number
    maxResidualPct: number
    r2: number
  }
  /** 该定线号下逐点比测结论 */
  items: Array<{
    ratingId: string
    measureNo: string
    stageM: number
    measuredFlow: number
    curveFlow: number
    deviationPct: number
    verdict: '合格' | '超限'
  }>
  /** 汇总 */
  summary: {
    total: number
    qualified: number
    overLimit: number
    qualifyRatePct: number
  }
  operator: string
  concludedAt: string
}

/** 全部消息载荷的联合类型 */
export type DispatchPayload =
  | StationSyncPayload
  | DischargeReportPayload
  | SectionChangedPayload
  | CompareConclusionPayload

/** 带类型判别字段的消息内容 */
export type DispatchMessageBody =
  | { kind: 'station-sync'; payload: StationSyncPayload }
  | { kind: 'discharge-report'; payload: DischargeReportPayload }
  | { kind: 'section-changed'; payload: SectionChangedPayload }
  | { kind: 'compare-conclusion'; payload: CompareConclusionPayload }

/**
 * 发件箱记录：发送方库持有，是本侧重试的唯一依据。
 * 重试只改这张表的状态，对方库那份（inbox）不动。
 */
export interface OutboxMessage {
  /** 消息幂等键：业务键 + 版本，发送方生成、接收方据此去重 */
  id: string
  kind: DispatchKind
  from: OwnerSide
  to: OwnerSide
  payload: DispatchPayload
  status: DispatchStatus
  attempts: number
  lastError: string
  createdAt: number
  updatedAt: number
  deliveredAt: number | null
}

/**
 * 收件箱记录：接收方库持有，按业务键幂等入账。
 * 已入账消息重复送达时直接忽略，不重复处理。
 */
export interface InboxMessage {
  /** 与 OutboxMessage.id 相同（幂等键） */
  id: string
  kind: DispatchKind
  from: OwnerSide
  payload: DispatchPayload
  /** 是否已被各自的入账逻辑消费（0 未处理 / 1 已处理；IndexedDB 不能用布尔做索引） */
  applied: 0 | 1
  receivedAt: number
}

/** 业务键 → 消息幂等键的生成规则（两边一致，保证去重对齐） */
export function messageId(...parts: Array<string | number>): string {
  return `msg_${parts.map((part) => String(part)).join('__')}`
}
