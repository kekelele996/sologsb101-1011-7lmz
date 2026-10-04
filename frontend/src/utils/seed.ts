/**
 * 双库演示数据装配。
 *
 * 同一份逻辑既服务「全新空库播种」，也服务「旧单库迁移」：输入一批规范化的
 * 领域数据（测站/测次/垂线/测点/历史点据），输出到外业库与整编室库两边，
 * 并补全：
 *  - 外业测次的版本/报出字段；
 *  - 有垂线测点的测次视为「已算出断面流量并已报出」，两边直接各持一份
 *    （外业 outbox=delivered，整编 inbox 已入账并生成 inReports）；
 *  - 能对应到报出成果的点据正常在案，对应不上的历史点据标 rejected 留档但不定线；
 *  - 整编室按各线点据生成一轮比测结论批次（delivered 台账）。
 */
import { fieldDb } from './fieldDb'
import { officeDb } from './officeDb'
import { buildReportPayload } from './fieldService'
import { calcDeviationPct, judgeDeviation } from '@/types/compare'
import { curveFlow, fitPowerCurve } from '@/types/rating'
import { messageId } from '@/types/dispatch'
import type { Station } from '@/types/station'
import type { Section } from '@/types/section'
import type { Vertical } from '@/types/vertical'
import type { Point } from '@/types/point'
import type {
  InboxMessage,
  OutboxMessage
} from '@/types/dispatch'
import type { CompareItem, CompareRun, InReport, RatingLine, RatingPoint } from '@/types/office'

/** 规范化输入：一条历史点据（measureNo+stage 用于与报出成果匹配） */
export interface LoadRatingInput {
  stationId: string
  stageM: number
  flowM3s: number
  lineNo: string
  measureNo: string
  measuredAt: string
  /** 迁移旧比测记录时的判定（无则由首轮定线重算） */
  legacyVerdict?: '合格' | '超限'
}

export interface LoadDataset {
  stations: Station[]
  sections: Section[]
  verticals: Vertical[]
  points: Point[]
  ratings: LoadRatingInput[]
  /** 时间基准（旧库迁移时用旧时间戳，播种时用当前时间） */
  baseTime?: number
}

interface PopulatedReport {
  report: InReport
  sectionId: string
}

/** 把一批数据装配进两个库（幂等性由调用方在清空库后保证） */
export async function populateBothDatabases(dataset: LoadDataset): Promise<void> {
  const base = dataset.baseTime ?? Date.now()

  // ---- 外业库：测站 / 测次 / 垂线 / 测点 ----
  await fieldDb.transaction(
    'rw',
    [fieldDb.stations, fieldDb.sections, fieldDb.verticals, fieldDb.points, fieldDb.outbox, fieldDb.inbox],
    async () => {
      await fieldDb.stations.bulkPut(dataset.stations)
      await fieldDb.sections.bulkPut(dataset.sections)
      await fieldDb.verticals.bulkPut(dataset.verticals)
      await fieldDb.points.bulkPut(dataset.points)

      // 测站档案同步消息（已送达台账）
      const stationOut: OutboxMessage[] = dataset.stations.map((station, index) => {
        const revision = station.updatedAt || base + index
        const id = messageId('station', 'field', station.id, revision)
        return {
          id,
          kind: 'station-sync',
          from: 'field',
          to: 'office',
          payload: {
            station: {
              id: station.id,
              name: station.name,
              river: station.river,
              catchmentKm2: station.catchmentKm2,
              sectionCode: station.sectionCode,
              remark: station.remark
            },
            revision
          },
          status: 'delivered',
          attempts: 1,
          lastError: '',
          createdAt: base + index,
          updatedAt: base + index,
          deliveredAt: base + index
        }
      })
      await fieldDb.outbox.bulkPut(stationOut)
    }
  )

  // ---- 计算并装配「已报出」测次（有垂线即视为已算出成果） ----
  const reports: PopulatedReport[] = []
  for (const section of dataset.sections) {
    const verticals = dataset.verticals
      .filter((v) => v.sectionId === section.id)
      .sort((a, b) => a.startDistanceM - b.startDistanceM)
    if (verticals.length === 0) continue
    const verticalIds = verticals.map((v) => v.id)
    const pts = dataset.points.filter((p) => verticalIds.includes(p.verticalId))
    if (pts.length === 0) continue

    const revision = 1
    const reportedAt = section.reportedAt ?? new Date(section.updatedAt || base).toISOString()
    const payload = buildReportPayload(section, verticals, pts, revision, reportedAt)
    if (!(payload.flowM3s > 0)) continue

    // 回填外业测次的报出字段
    await fieldDb.sections.update(section.id, {
      reported: true,
      reportedRevision: revision,
      reportedAt,
      reportedFlowM3s: payload.flowM3s
    } as never)

    const msgId = messageId('discharge', section.id, revision)
    const out: OutboxMessage = {
      id: msgId,
      kind: 'discharge-report',
      from: 'field',
      to: 'office',
      payload,
      status: 'delivered',
      attempts: 1,
      lastError: '',
      createdAt: section.updatedAt || base,
      updatedAt: section.updatedAt || base,
      deliveredAt: section.updatedAt || base
    }
    await fieldDb.outbox.put(out)

    const inbox: InboxMessage = {
      id: msgId,
      kind: 'discharge-report',
      from: 'field',
      payload,
      applied: 1,
      receivedAt: section.updatedAt || base
    }
    const report: InReport = {
      id: msgId,
      stationId: payload.stationId,
      sectionId: payload.sectionId,
      measureNo: payload.measureNo,
      method: payload.method,
      stageM: payload.stageM,
      measuredAt: payload.measuredAt,
      flowM3s: payload.flowM3s,
      areaM2: payload.areaM2,
      meanVelocityMs: payload.meanVelocityMs,
      widthM: payload.widthM,
      maxDepthM: payload.maxDepthM,
      verticalCount: payload.verticalCount,
      pointCount: payload.pointCount,
      slices: payload.slices,
      revision,
      reportedAt,
      receivedAt: section.updatedAt || base,
      superseded: false
    }
    reports.push({ report, sectionId: section.id })

    // 整编室收件箱也留一条已入账记录
    await officeDb.inbox.put(inbox)
  }

  // ---- 整编室库：名册 / 版本 / 报出 / 点据 ----
  await officeDb.transaction(
    'rw',
    [
      officeDb.stations,
      officeDb.stationRevs,
      officeDb.inReports,
      officeDb.ratingPoints,
      officeDb.ratingLines,
      officeDb.compareRuns,
      officeDb.outbox,
      officeDb.inbox
    ],
    async () => {
      await officeDb.stations.bulkPut(dataset.stations)
      await officeDb.stationRevs.bulkPut(
        dataset.stations.map((station, index) => ({
          stationId: station.id,
          revision: station.updatedAt || base + index
        }))
      )
      await officeDb.inReports.bulkPut(reports.map((r) => r.report))

      // 点据：能对应到报出成果的正常在案；对应不上的历史点据 rejected 留档、不参与定线
      const points: RatingPoint[] = []
      const lineSet = new Map<string, string>()
      for (const rating of dataset.ratings) {
        // 匹配规则：同测站 + 同测次号 + 水位一致的已报出成果
        const realMatch = reports.find((rep) => {
          const sec = dataset.sections.find((s) => s.id === rep.sectionId)
          return (
            sec &&
            sec.stationId === rating.stationId &&
            sec.measureNo === rating.measureNo &&
            Math.abs(rep.report.stageM - rating.stageM) < 0.001
          )
        })
        const now = Date.parse(rating.measuredAt) || base
        lineSet.set(rating.lineNo, rating.stationId)
        if (realMatch) {
          points.push({
            id: `rat_${rating.lineNo}_${rating.measureNo}`.replace(/[^a-zA-Z0-9_]/g, '_'),
            stationId: rating.stationId,
            lineNo: rating.lineNo,
            stageM: rating.stageM,
            flowM3s: rating.flowM3s,
            measureNo: rating.measureNo,
            sectionId: realMatch.sectionId,
            reportId: realMatch.report.id,
            sourceRevision: 1,
            measuredAt: rating.measuredAt,
            status: 'active',
            holdReason: 'none',
            heldAt: null,
            holdNote: '',
            reviewedBy: '',
            reviewedAt: null,
            reviewNote: '',
            createdAt: now,
            updatedAt: now
          })
        } else {
          // 历史点据无报出来源：留档但退出定线
          points.push({
            id: `rat_hist_${rating.lineNo}_${rating.measureNo}_${rating.stageM}`.replace(/[^a-zA-Z0-9_]/g, '_'),
            stationId: rating.stationId,
            lineNo: rating.lineNo,
            stageM: rating.stageM,
            flowM3s: rating.flowM3s,
            measureNo: rating.measureNo,
            sectionId: '',
            reportId: '',
            sourceRevision: 0,
            measuredAt: rating.measuredAt,
            status: 'rejected',
            holdReason: 'none',
            heldAt: null,
            holdNote: '旧库迁移：无对应报出成果，留档但不参与定线',
            reviewedBy: '系统迁移',
            reviewedAt: base,
            reviewNote: '历史点据',
            createdAt: now,
            updatedAt: now
          })
        }
      }
      await officeDb.ratingPoints.bulkPut(points)

      const lines: RatingLine[] = Array.from(lineSet.entries()).map(([lineNo, stationId]) => ({
        lineNo,
        stationId,
        label: `${lineNo} 线`,
        enabled: true,
        createdAt: base,
        updatedAt: base
      }))
      await officeDb.ratingLines.bulkPut(lines)

      // 首轮比测结论：逐线拟合，追加一批 delivered 的结论（同时写两边收发台账）
      const seedRunList: CompareRun[] = []
      for (const lineNo of Array.from(lineSet.keys())) {
        const usable = points.filter((p) => p.lineNo === lineNo && (p.status === 'active' || p.status === 'resolved'))
        const fit = fitPowerCurve(
          usable.map((p) => ({ stageM: p.stageM, flowM3s: p.flowM3s })),
          lineNo
        )
        const items: CompareItem[] = usable.map((p) => {
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
            verdict: judgeDeviation(deviationPct),
            pointStatus: p.status
          }
        })
        const over = items.filter((i) => i.verdict === '超限').length
        const runId = `run_seed_${lineNo}`
        const run: CompareRun = {
          id: runId,
          lineNo,
          stationId: usable[0]?.stationId ?? lineSet.get(lineNo) ?? '',
          a: fit.a,
          b: fit.b,
          h0: fit.h0,
          valid: fit.valid,
          sampleCount: fit.sampleCount,
          meanResidualPct: fit.meanResidualPct,
          maxResidualPct: fit.maxResidualPct,
          r2: fit.r2,
          items,
          total: items.length,
          qualified: items.length - over,
          overLimit: over,
          qualifyRatePct: items.length ? Number((((items.length - over) / items.length) * 100).toFixed(1)) : 0,
          operator: '系统',
          concludedAt: new Date(base).toISOString(),
          dispatchStatus: 'delivered',
          lastDispatchError: '',
          createdAt: base,
          updatedAt: base
        }
        seedRunList.push(run)
        await officeDb.compareRuns.put(run)
      }

      // 首轮结论的发件箱（整编侧 delivered 台账）
      await officeDb.outbox.bulkPut(
        seedRunList.map((run) => ({
          id: messageId('conclusion', run.id),
          kind: 'compare-conclusion' as const,
          from: 'office' as const,
          to: 'field' as const,
          payload: {
            runId: run.id,
            lineNo: run.lineNo,
            stationId: run.stationId,
            stationName: dataset.stations.find((s) => s.id === run.stationId)?.name ?? '未知测站',
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
            summary: { total: run.total, qualified: run.qualified, overLimit: run.overLimit, qualifyRatePct: run.qualifyRatePct },
            operator: run.operator,
            concludedAt: run.concludedAt
          },
          status: 'delivered' as const,
          attempts: 1,
          lastError: '',
          createdAt: base,
          updatedAt: base,
          deliveredAt: base
        }))
      )
    }
  )

  // 首轮结论送抵外业收件箱（跨库，放到整编事务之后）
  const seededRunsAll = await officeDb.compareRuns.toArray()
  await fieldDb.inbox.bulkPut(
    seededRunsAll.map((run) => ({
      id: messageId('conclusion', run.id),
      kind: 'compare-conclusion' as const,
      from: 'office' as const,
      payload: {
        runId: run.id,
        lineNo: run.lineNo,
        stationId: run.stationId,
        stationName: dataset.stations.find((s) => s.id === run.stationId)?.name ?? '未知测站',
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
        summary: { total: run.total, qualified: run.qualified, overLimit: run.overLimit, qualifyRatePct: run.qualifyRatePct },
        operator: run.operator,
        concludedAt: run.concludedAt
      },
      applied: 1 as const,
      receivedAt: base
    }))
  )
}

/** 构造测次的默认版本/报出字段（迁移旧 Section 时补齐） */
export function sectionVersionDefaults(): Pick<
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
