/**
 * 外业业务服务：断面流量计算、测次报出、报出后的改动感知。
 *
 * 规则落点：
 *  - 断面流量由垂线平均流速经部分面积法实时算出；报出时冻结为不可变快照。
 *  - 报出后只要改测次头 / 垂线 / 测点，revision +1 并向整编室发 section-changed，
 *    整编室据此把已落在点据上的那条挂起，不影响其他点据。
 *  - 所有对外送交只写外业自己的 outbox，失败只在本侧重试。
 */
import { fieldDb } from './fieldDb'
import { enqueueMessage } from './transport'
import { calcMeanVelocity, calcSectionDischarge } from './flow'
import type { Section } from '@/types/section'
import type { Vertical } from '@/types/vertical'
import type { Point } from '@/types/point'
import type { Station } from '@/types/station'
import type { DischargeReportPayload, StationSyncPayload } from '@/types/dispatch'

/** 取某测次全部垂线（起点距升序）与测点 */
export async function loadSectionGraph(sectionId: string): Promise<{
  section: Section | undefined
  verticals: Vertical[]
  points: Point[]
}> {
  const section = await fieldDb.sections.get(sectionId)
  const verticals = (await fieldDb.verticals.where('sectionId').equals(sectionId).toArray()).sort(
    (a, b) => a.startDistanceM - b.startDistanceM
  )
  const verticalIds = verticals.map((v) => v.id)
  const points = verticalIds.length
    ? await fieldDb.points.where('verticalId').anyOf(verticalIds).toArray()
    : []
  return { section, verticals, points }
}

/** 实时计算断面流量成果（页面回显与报出共用同一算法） */
export function computeDischarge(verticals: Vertical[], points: Point[]) {
  const slices = verticals.map((vertical) => {
    const own = points.filter((p) => p.verticalId === vertical.id)
    const meanVelocityMs = calcMeanVelocity(
      own.map((p) => ({ velocityMs: p.velocityMs, weight: p.weight }))
    )
    return {
      id: vertical.id,
      no: vertical.no,
      startDistanceM: vertical.startDistanceM,
      depthM: vertical.depthM,
      meanVelocityMs
    }
  })
  return calcSectionDischarge(slices)
}

/**
 * 报出测次：校验已算出断面流量（至少一条垂线且流量 > 0），冻结快照并送交整编室。
 * 同一测次每报一次 revision 作为报出版本（不改动业务 revision，业务 revision 是改动计数）。
 * 返回报出版本号。
 */
export async function reportSection(sectionId: string): Promise<{ revision: number; flowM3s: number }> {
  const { section, verticals, points } = await loadSectionGraph(sectionId)
  if (!section) throw new Error('测次不存在，无法报出')
  if (verticals.length === 0) {
    throw new Error('该测次还没有垂线与测点，尚未算出断面流量，不能报出')
  }
  const result = computeDischarge(verticals, points)
  if (!(result.flowM3s > 0)) {
    throw new Error('断面流量为 0，需先补录垂线测深与流速测点后再报出')
  }

  const reportRevision = section.reportedRevision + 1
  const now = Date.now()
  const iso = new Date(now).toISOString()

  const payload: DischargeReportPayload = {
    stationId: section.stationId,
    sectionId: section.id,
    measureNo: section.measureNo,
    method: section.method,
    stageM: section.stageM,
    measuredAt: section.measuredAt,
    flowM3s: result.flowM3s,
    areaM2: result.areaM2,
    meanVelocityMs: result.meanVelocityMs,
    widthM: result.widthM,
    maxDepthM: result.maxDepthM,
    verticalCount: verticals.length,
    pointCount: points.length,
    slices: result.slices.map((s) => ({
      no: s.no,
      startDistanceM: s.startDistanceM,
      depthM: s.depthM,
      meanVelocityMs: s.meanVelocityMs,
      partialAreaM2: s.partialAreaM2,
      partialFlow: s.partialFlow
    })),
    revision: reportRevision,
    reportedAt: iso
  }

  await fieldDb.transaction('rw', [fieldDb.sections, fieldDb.outbox], async () => {
    await fieldDb.sections.update(sectionId, {
      reported: true,
      reportedRevision: reportRevision,
      reportedAt: iso,
      reportedFlowM3s: result.flowM3s,
      updatedAt: now
    } as never)
    await enqueueMessage('field', 'discharge-report', payload)
  })

  return { revision: reportRevision, flowM3s: result.flowM3s }
}

/**
 * 报出后改动钩子：任何垂线/测点/测次头写操作之后调用。
 * 若该测次已报出且当前数据版本落后，则 bump revision 并发送挂起通知。
 * 可在一次事务内批量改动后只调用一次（传入受影响的 sectionId 集合）。
 */
export async function notifySectionsChanged(
  sectionIds: string[],
  reason: string
): Promise<void> {
  const unique = Array.from(new Set(sectionIds))
  for (const sectionId of unique) {
    const section = await fieldDb.sections.get(sectionId)
    if (!section || !section.reported) continue
    const newRevision = section.revision + 1
    const changedAt = new Date().toISOString()
    await fieldDb.sections.update(sectionId, { revision: newRevision, updatedAt: Date.now() } as never)
    await enqueueMessage('field', 'section-changed', {
      stationId: section.stationId,
      sectionId: section.id,
      measureNo: section.measureNo,
      revision: newRevision,
      changedAt,
      reason
    })
  }
}

/** 测站档案同步：新建/编辑测站后给整编室发最新版本（revision=更新计数） */
export async function syncStation(station: Station): Promise<void> {
  // 用 updatedAt 作为单调版本（毫秒时间戳，编辑总是晚于创建）
  const revision = station.updatedAt
  const payload: StationSyncPayload = {
    station: {
      id: station.id,
      name: station.name,
      river: station.river,
      catchmentKm2: station.catchmentKm2,
      sectionCode: station.sectionCode,
      remark: station.remark
    },
    revision
  }
  await enqueueMessage('field', 'station-sync', payload)
}

/** 创建一条新测次的默认字段（供 store 复用，保证版本/报出字段齐全） */
export function newSectionDefaults(): Pick<
  Section,
  'revision' | 'reported' | 'reportedRevision' | 'reportedAt' | 'reportedFlowM3s'
> {
  return {
    revision: 1,
    reported: false,
    reportedRevision: 0,
    reportedAt: null,
    reportedFlowM3s: null
  }
}

/** 仅供迁移/播种使用：直接生成报出快照（不经过 outbox 校验流程时由 bootstrap 统一组装） */
export function buildReportPayload(
  section: Section,
  verticals: Vertical[],
  points: Point[],
  revision: number,
  reportedAt: string
): DischargeReportPayload {
  const result = computeDischarge(verticals, points)
  return {
    stationId: section.stationId,
    sectionId: section.id,
    measureNo: section.measureNo,
    method: section.method,
    stageM: section.stageM,
    measuredAt: section.measuredAt,
    flowM3s: result.flowM3s,
    areaM2: result.areaM2,
    meanVelocityMs: result.meanVelocityMs,
    widthM: result.widthM,
    maxDepthM: result.maxDepthM,
    verticalCount: verticals.length,
    pointCount: points.length,
    slices: result.slices.map((s) => ({
      no: s.no,
      startDistanceM: s.startDistanceM,
      depthM: s.depthM,
      meanVelocityMs: s.meanVelocityMs,
      partialAreaM2: s.partialAreaM2,
      partialFlow: s.partialFlow
    })),
    revision,
    reportedAt
  }
}
