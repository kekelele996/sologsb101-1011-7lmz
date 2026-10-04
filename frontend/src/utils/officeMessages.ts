/**
 * 整编室收件入账：消费 officeDb.inbox 中未处理的消息。
 * 这是唯一会写整编室业务表的「外部入口」，只接受外业发来的三类消息：
 *  - station-sync       → 维护只读测站名册（高版本覆盖低版本）
 *  - discharge-report   → 记为 inReports，并把同测次旧报出标 superseded
 *  - section-changed    → 把来源测次的在案点据挂起（held），只挂该条、不挡别的
 */
import { officeDb } from './officeDb'
import type { InboxMessage } from '@/types/dispatch'
import type {
  DischargeReportPayload,
  SectionChangedPayload,
  StationSyncPayload
} from '@/types/dispatch'
import type { InReport, RatingPoint } from '@/types/office'

/** 拉取并处理所有未入账消息（幂等，可反复调用） */
export async function applyOfficeInbox(): Promise<{ stations: number; reports: number; held: number }> {
  let stations = 0
  let reports = 0
  let held = 0
  const messages = await officeDb.inbox.where('applied').equals(0).toArray()
  for (const message of messages) {
    if (message.kind === 'station-sync') {
      const changed = await applyStationSync(message)
      if (changed) stations += 1
    } else if (message.kind === 'discharge-report') {
      const changed = await applyDischargeReport(message)
      if (changed) reports += 1
    } else if (message.kind === 'section-changed') {
      held += await applySectionChanged(message)
    }
    await officeDb.inbox.update(message.id, { applied: 1 })
  }
  return { stations, reports, held }
}

function applyStationSync(message: InboxMessage): Promise<boolean> {
  const { station, revision } = message.payload as StationSyncPayload
  return officeDb.transaction('rw', [officeDb.stations, officeDb.stationRevs], async () => {
    const revRow = await officeDb.stationRevs.get(station.id)
    // 名册只接受更新版本；无版本记录视为 0
    if (revRow && revRow.revision > revision) return false
    const existing = await officeDb.stations.get(station.id)
    const now = Date.now()
    await officeDb.stations.put({
      ...station,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    })
    await officeDb.stationRevs.put({ stationId: station.id, revision })
    return true
  })
}

async function applyDischargeReport(message: InboxMessage): Promise<boolean> {
  const p = message.payload as DischargeReportPayload
  return officeDb.transaction(
    'rw',
    officeDb.inReports,
    officeDb.ratingPoints,
    async () => {
      if (await officeDb.inReports.get(message.id)) return false

      // 同测次旧版本报出标记为已取代（保留可查，不再能落新点据）
      const older = await officeDb.inReports.where('sectionId').equals(p.sectionId).toArray()
      for (const old of older) {
        if (old.revision < p.revision && !old.superseded) {
          await officeDb.inReports.update(old.id, { superseded: true })
        }
      }

      const now = Date.now()
      const report: InReport = {
        id: message.id,
        stationId: p.stationId,
        sectionId: p.sectionId,
        measureNo: p.measureNo,
        method: p.method,
        stageM: p.stageM,
        measuredAt: p.measuredAt,
        flowM3s: p.flowM3s,
        areaM2: p.areaM2,
        meanVelocityMs: p.meanVelocityMs,
        widthM: p.widthM,
        maxDepthM: p.maxDepthM,
        verticalCount: p.verticalCount,
        pointCount: p.pointCount,
        slices: p.slices,
        revision: p.revision,
        reportedAt: p.reportedAt,
        receivedAt: now,
        superseded: false
      }
      await officeDb.inReports.put(report)

      // 旧报出若已被取代，已落的在案点据挂起等待复核（不挡其他点据）
      const stalePoints = await officeDb.ratingPoints
        .where('sectionId')
        .equals(p.sectionId)
        .toArray()
      for (const point of stalePoints) {
        if (point.sourceRevision < p.revision && point.status !== 'rejected') {
          await holdPoint(point, 'report-superseded', `来源测次已报出更新版本（v${p.revision}），旧点据待复核`)
        }
      }
      return true
    }
  )
}

async function applySectionChanged(message: InboxMessage): Promise<number> {
  const p = message.payload as SectionChangedPayload
  return officeDb.transaction('rw', officeDb.ratingPoints, async () => {
    const points = await officeDb.ratingPoints.where('sectionId').equals(p.sectionId).toArray()
    let heldCount = 0
    for (const point of points) {
      // 只挂依据版本落后于当前版本、且未弃用的点据；已挂起的不重复挂
      if (point.sourceRevision < p.revision && (point.status === 'active' || point.status === 'resolved')) {
        await holdPoint(point, 'source-changed', p.reason || `外业报出后改动了测次（当前 v${p.revision}），点据待复核`)
        heldCount += 1
      }
    }
    return heldCount
  })
}

/** 挂起一条点据：集中处理状态与留痕字段 */
async function holdPoint(
  point: RatingPoint,
  reason: RatingPoint['holdReason'],
  note: string
): Promise<void> {
  await officeDb.ratingPoints.update(point.id, {
    status: 'held',
    holdReason: reason,
    heldAt: Date.now(),
    holdNote: note,
    updatedAt: Date.now()
  } as never)
}
