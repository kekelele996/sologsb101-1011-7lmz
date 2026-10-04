/**
 * 断面流量成果（外业组持有）
 *
 * 外业组把每次测流的垂线测深、流速测点逐层落档后，由部分面积法算出断面流量。
 * 成果按断面测次落一条（每测次一条，反复重算只覆盖本侧），整编室只读走快照、
 * 永远不回写本侧，因此外业组再改垂线 / 测点不会被整编室的定线冲掉。
 */
import type { DischargeResult } from '@/utils/flow'

export interface Discharge extends Omit<DischargeResult, 'slices'> {
  id: string
  /** 所属断面测次（外业库 sections.id），也是本表的业务唯一键 */
  sectionId: string
  /** 参与计算的垂线条数 */
  verticalCount: number
  /** 逐垂线的部分面积与部分流量（留档复核用） */
  slices: DischargeResult['slices']
  /**
   * 输入指纹：由参与计算的垂线（起点距 / 水深）与测点（相对水深 / 流速 / 权重）
   * 汇总而成。垂线或测点一变指纹就变，整编室据此发现「报出后外业又改了」。
   */
  inputHash: string
  /**
   * 成果版本：未报出前始终为 1；已报出后外业再因垂线 / 测点改动重算则 +1。
   * 整编室送交快照带着当时的 revision，对不上即说明外业已有新版，
   * 落在点据上那条先挂起等人复核。
   */
  revision: number
  /** 是否已报出（送交整编室）：外业只标记，不报出后的数据依旧随时可改 */
  reported: boolean
  /** 最近一次报出时间（ISO），未报出为 null */
  reportedAt: string | null
  /** 最近一次计算时间（ISO） */
  computedAt: string
  createdAt: number
  updatedAt: number
}

/** 断面流量是否算得出：至少有一条垂线、垂线平均流速与水深齐备且流量为正 */
export function isDischargeUsable(discharge: Pick<Discharge, 'flowM3s' | 'verticalCount'>): boolean {
  return discharge.verticalCount > 0 && Number.isFinite(discharge.flowM3s) && discharge.flowM3s > 0
}
