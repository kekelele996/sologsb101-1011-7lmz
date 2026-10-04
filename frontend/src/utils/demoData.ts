/**
 * 全新环境的演示数据集（双库装配输入）。
 * 3 个测站、5 个测次（其中 4 个带垂线测点=已算出成果可报出），
 * 另含若干整编室历史点据用于演示正常定线与「无报出来源留档」。
 */
import type { Station } from '@/types/station'
import type { Section } from '@/types/section'
import type { Vertical } from '@/types/vertical'
import type { Point } from '@/types/point'
import type { LoadDataset } from './seed'

const now = Date.now()

const stations: Station[] = [
  {
    id: 'stn_lh01',
    name: '龙门水文站',
    river: '澜沧江',
    catchmentKm2: 45200,
    sectionCode: 'CS-LM-01',
    remark: '基本水文站，缆道测流，断面稳定',
    createdAt: now,
    updatedAt: now
  },
  {
    id: 'stn_qj02',
    name: '青矶水位站',
    river: '沅江',
    catchmentKm2: 1860,
    sectionCode: 'CS-QJ-02',
    remark: '小河站，浮标法为主，洪水期加测',
    createdAt: now,
    updatedAt: now
  },
  {
    id: 'stn_bs03',
    name: '白沙滩巡测站',
    river: '澜沧江',
    catchmentKm2: 51200,
    sectionCode: 'CS-BS-03',
    remark: '巡测断面，与龙门站比测',
    createdAt: now,
    updatedAt: now
  }
]

function section(
  id: string,
  stationId: string,
  measureNo: string,
  stageM: number,
  method: Section['method'],
  measuredAt: string,
  startDistanceM = 12.5,
  hasVerticals = true
): Section {
  return {
    id,
    stationId,
    measureNo,
    startDistanceM,
    stageM,
    method,
    measuredAt,
    revision: 1,
    reported: !hasVerticals ? false : false, // 报出字段由装配器按有无垂线回填
    reportedRevision: 0,
    reportedAt: null,
    reportedFlowM3s: null,
    createdAt: now,
    updatedAt: now
  }
}

const sections: Section[] = [
  section('sec_lh_2406', 'stn_lh01', '2024-06-001', 5.42, '流速仪', '2024-06-12T08:30:00.000Z'),
  section('sec_lh_2407', 'stn_lh01', '2024-07-002', 6.15, 'ADCP', '2024-07-18T09:10:00.000Z'),
  section('sec_qj_2405', 'stn_qj02', '2024-05-003', 3.18, '浮标', '2024-05-22T07:50:00.000Z', 4.2),
  section('sec_qj_2408', 'stn_qj02', '2024-08-004', 4.36, '流速仪', '2024-08-09T06:40:00.000Z', 4.2),
  section('sec_bs_2406', 'stn_bs03', '2024-06-005', 5.36, 'ADCP', '2024-06-20T10:05:00.000Z', 18),
  // 一个尚未报出的新测次（无垂线，外业可继续补录）
  section('sec_lh_2409', 'stn_lh01', '2024-09-006', 6.88, '流速仪', '2024-09-15T08:00:00.000Z', 12.5, false)
]

const verticals: Vertical[] = [
  { id: 'vrt_lh_1', sectionId: 'sec_lh_2406', no: 1, startDistanceM: 6.5, depthM: 1.4, pointCount: 2, bedNote: '左岸浅滩，砾石河床', createdAt: now, updatedAt: now },
  { id: 'vrt_lh_2', sectionId: 'sec_lh_2406', no: 2, startDistanceM: 14.0, depthM: 3.2, pointCount: 3, bedNote: '主流，砂卵石', createdAt: now, updatedAt: now },
  { id: 'vrt_lh_3', sectionId: 'sec_lh_2406', no: 3, startDistanceM: 22.0, depthM: 2.1, pointCount: 2, bedNote: '右岸缓流，细砂', createdAt: now, updatedAt: now },
  { id: 'vrt_lh_4', sectionId: 'sec_lh_2407', no: 1, startDistanceM: 8.0, depthM: 3.8, pointCount: 3, bedNote: 'ADCP 走航断面，主槽', createdAt: now, updatedAt: now },
  { id: 'vrt_qj_1', sectionId: 'sec_qj_2405', no: 1, startDistanceM: 2.4, depthM: 1.1, pointCount: 2, bedNote: '浮标上断面', createdAt: now, updatedAt: now },
  { id: 'vrt_qj_2', sectionId: 'sec_qj_2405', no: 2, startDistanceM: 6.8, depthM: 1.9, pointCount: 2, bedNote: '浮标中泓', createdAt: now, updatedAt: now },
  { id: 'vrt_qj_3', sectionId: 'sec_qj_2408', no: 1, startDistanceM: 3.1, depthM: 1.6, pointCount: 3, bedNote: '涨水期，流速仪三点法', createdAt: now, updatedAt: now },
  { id: 'vrt_qj_4', sectionId: 'sec_qj_2408', no: 2, startDistanceM: 7.6, depthM: 2.4, pointCount: 3, bedNote: '主槽，卵石夹砂', createdAt: now, updatedAt: now },
  { id: 'vrt_bs_1', sectionId: 'sec_bs_2406', no: 1, startDistanceM: 10.0, depthM: 2.6, pointCount: 3, bedNote: 'ADCP 左半断面', createdAt: now, updatedAt: now },
  { id: 'vrt_bs_2', sectionId: 'sec_bs_2406', no: 2, startDistanceM: 24.0, depthM: 3.4, pointCount: 3, bedNote: 'ADCP 右半断面', createdAt: now, updatedAt: now }
]

function p(id: string, verticalId: string, relativeDepth: number, velocityMs: number, weight: number, durationS = 100): Point {
  return { id, verticalId, relativeDepth, velocityMs, weight, durationS, createdAt: now, updatedAt: now }
}

const points: Point[] = [
  p('pnt_lh_11', 'vrt_lh_1', 0.2, 0.62, 0.5),
  p('pnt_lh_12', 'vrt_lh_1', 0.8, 0.48, 0.5),
  p('pnt_lh_21', 'vrt_lh_2', 0.2, 1.42, 1 / 3),
  p('pnt_lh_22', 'vrt_lh_2', 0.6, 1.18, 1 / 3),
  p('pnt_lh_23', 'vrt_lh_2', 0.8, 0.96, 1 / 3),
  p('pnt_lh_31', 'vrt_lh_3', 0.2, 0.82, 0.5),
  p('pnt_lh_32', 'vrt_lh_3', 0.8, 0.64, 0.5),
  p('pnt_lh_41', 'vrt_lh_4', 0.2, 1.86, 1 / 3, 120),
  p('pnt_lh_42', 'vrt_lh_4', 0.6, 1.64, 1 / 3, 120),
  p('pnt_lh_43', 'vrt_lh_4', 0.8, 1.32, 1 / 3, 120),
  p('pnt_qj_11', 'vrt_qj_1', 0.2, 0.54, 0.5),
  p('pnt_qj_12', 'vrt_qj_1', 0.8, 0.42, 0.5),
  p('pnt_qj_21', 'vrt_qj_2', 0.2, 0.88, 0.5),
  p('pnt_qj_22', 'vrt_qj_2', 0.8, 0.7, 0.5),
  p('pnt_qj_31', 'vrt_qj_3', 0.2, 1.06, 1 / 3),
  p('pnt_qj_32', 'vrt_qj_3', 0.6, 0.92, 1 / 3),
  p('pnt_qj_33', 'vrt_qj_3', 0.8, 0.78, 1 / 3),
  p('pnt_qj_41', 'vrt_qj_4', 0.2, 1.34, 1 / 3),
  p('pnt_qj_42', 'vrt_qj_4', 0.6, 1.2, 1 / 3),
  p('pnt_qj_43', 'vrt_qj_4', 0.8, 1.04, 1 / 3),
  p('pnt_bs_11', 'vrt_bs_1', 0.2, 1.22, 1 / 3, 120),
  p('pnt_bs_12', 'vrt_bs_1', 0.6, 1.08, 1 / 3, 120),
  p('pnt_bs_13', 'vrt_bs_1', 0.8, 0.9, 1 / 3, 120),
  p('pnt_bs_21', 'vrt_bs_2', 0.2, 1.46, 1 / 3, 120),
  p('pnt_bs_22', 'vrt_bs_2', 0.6, 1.3, 1 / 3, 120),
  p('pnt_bs_23', 'vrt_bs_2', 0.8, 1.1, 1 / 3, 120)
]

/**
 * 整编室历史点据。能与上面报出测次（测站+测次号+水位）对上的会正常在案；
 * 对不上的（如 2024-04-001、2024-08-006、2023-05-001 等）留档但不参与定线，
 * 用于演示「落点据只认已报出成果」。
 */
const ratings: LoadDataset['ratings'] = [
  // A 线：两个对得上报出（06-001、07-002），两个历史点据留档
  { stationId: 'stn_lh01', stageM: 4.01, flowM3s: 97.5, lineNo: 'A', measureNo: '2024-04-001', measuredAt: '2024-04-08T08:00:00.000Z' },
  { stationId: 'stn_lh01', stageM: 4.52, flowM3s: 138.7, lineNo: 'A', measureNo: '2024-05-002', measuredAt: '2024-05-16T08:00:00.000Z' },
  { stationId: 'stn_lh01', stageM: 5.42, flowM3s: 217.2, lineNo: 'A', measureNo: '2024-06-001', measuredAt: '2024-06-12T08:30:00.000Z' },
  { stationId: 'stn_lh01', stageM: 6.15, flowM3s: 298.5, lineNo: 'A', measureNo: '2024-07-002', measuredAt: '2024-07-18T09:10:00.000Z' },
  { stationId: 'stn_lh01', stageM: 7.03, flowM3s: 428.1, lineNo: 'A', measureNo: '2024-08-006', measuredAt: '2024-08-21T08:20:00.000Z' },
  // B 线：两个对得上（05-003、08-004），两个历史留档
  { stationId: 'stn_qj02', stageM: 2.84, flowM3s: 42.3, lineNo: 'B', measureNo: '2023-05-001', measuredAt: '2023-05-11T07:30:00.000Z' },
  { stationId: 'stn_qj02', stageM: 3.18, flowM3s: 56.1, lineNo: 'B', measureNo: '2024-05-003', measuredAt: '2024-05-22T07:50:00.000Z' },
  { stationId: 'stn_qj02', stageM: 3.72, flowM3s: 78.4, lineNo: 'B', measureNo: '2024-07-001', measuredAt: '2024-07-02T08:10:00.000Z' },
  { stationId: 'stn_qj02', stageM: 4.36, flowM3s: 115.6, lineNo: 'B', measureNo: '2024-08-004', measuredAt: '2024-08-09T06:40:00.000Z' },
  // C 线：一个对得上（06-005），其余历史留档
  { stationId: 'stn_bs03', stageM: 4.9, flowM3s: 168.0, lineNo: 'C', measureNo: '2024-05-004', measuredAt: '2024-05-28T09:00:00.000Z' },
  { stationId: 'stn_bs03', stageM: 5.36, flowM3s: 203.5, lineNo: 'C', measureNo: '2024-06-005', measuredAt: '2024-06-20T10:05:00.000Z' },
  { stationId: 'stn_bs03', stageM: 5.88, flowM3s: 325.0, lineNo: 'C', measureNo: '2024-07-007', measuredAt: '2024-07-25T09:30:00.000Z' },
  { stationId: 'stn_bs03', stageM: 6.44, flowM3s: 288.0, lineNo: 'C', measureNo: '2024-08-008', measuredAt: '2024-08-15T09:40:00.000Z' }
]

export const demoDataset: LoadDataset = {
  stations,
  sections,
  verticals,
  points,
  ratings,
  baseTime: now
}
