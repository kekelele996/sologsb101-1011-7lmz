/**
 * 断面 store（外业组）：维护断面测次、垂线集合、测点缓存、录入草稿与断面流量成果。
 *
 * 归属：测次 / 垂线测深 / 流速测点 / 断面流量全部只在外业库；整编室只读流量成果快照。
 * - 垂线或测点一变动，自动重算本测次断面流量；若该成果已报出，成果版本 +1，
 *   整编室对账时会把引用旧版本的点据挂起等人复核（不挡别的点据）。
 * - 「报出」只在本侧成果上打标记并刷新报出时间，整编室在点据录入时读取快照。
 * 垂线排序按起点距升序，页面展示与流量计算共用同一顺序。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { fieldDb, createId, watchTable, recomputeDischarge } from '@/utils/db'
import type { Section } from '@/types/section'
import { createEmptySectionFilter, type SectionFilterState } from '@/types/section'
import type { Vertical } from '@/types/vertical'
import { buildRelativeDepths } from '@/types/vertical'
import type { Point } from '@/types/point'
import type { Discharge } from '@/types/discharge'
import { isDischargeUsable } from '@/types/discharge'

/** 垂线录入草稿（新增/编辑表单共享结构） */
export interface VerticalDraft {
  no: number
  startDistanceM: number
  depthM: number
  bedNote: string
  /** 测点数：录入测深后按相对水深自动生成测点行 */
  pointCount: number
}

/** 测点录入草稿 */
export interface PointDraft {
  relativeDepth: number
  velocityMs: number
  weight: number
  durationS: number
}

export function createEmptyVerticalDraft(nextNo = 1): VerticalDraft {
  return { no: nextNo, startDistanceM: 0, depthM: 1, bedNote: '', pointCount: 2 }
}

export function createEmptyPointDraft(): PointDraft {
  return { relativeDepth: 0.6, velocityMs: 0.5, weight: 1, durationS: 100 }
}

export const useSectionStore = defineStore('section', () => {
  const sections = ref<Section[]>([])
  const verticals = ref<Vertical[]>([])
  const points = ref<Point[]>([])
  const discharges = ref<Discharge[]>([])
  const ready = ref(false)
  const error = ref<string | null>(null)
  const currentSectionId = ref<string | null>(null)
  const currentVerticalId = ref<string | null>(null)
  const filter = ref<SectionFilterState>(createEmptySectionFilter())
  const verticalDraft = ref<VerticalDraft>(createEmptyVerticalDraft())
  const pointDraft = ref<PointDraft>(createEmptyPointDraft())
  /** 批量粘贴文本（跨页面保留录入草稿） */
  const pasteText = ref<string>('')

  let started = false

  function start(): void {
    if (started) return
    started = true
    watchTable<Section>(() => fieldDb.sections).subscribe((rows) => {
      sections.value = rows
      ready.value = true
      error.value = null
    })
    watchTable<Vertical>(() => fieldDb.verticals).subscribe((rows) => {
      verticals.value = rows
    })
    watchTable<Point>(() => fieldDb.points).subscribe((rows) => {
      points.value = rows
    })
    watchTable<Discharge>(() => fieldDb.discharges).subscribe((rows) => {
      discharges.value = rows
    })
  }

  /** 某测站下的断面测次（按测流时间倒序） */
  function sectionsOfStation(stationId: string | null | undefined): Section[] {
    if (!stationId) return []
    return sections.value
      .filter((section) => section.stationId === stationId)
      .sort((a, b) => Date.parse(b.measuredAt) - Date.parse(a.measuredAt))
  }

  /** 按筛选条件过滤某测站的断面 */
  const filteredSections = computed<Section[]>(() =>
    sections.value
      .filter((section) => {
        if (currentSectionId.value && section.id === currentSectionId.value) return true
        const keyword = filter.value.keyword.trim()
        if (keyword.length > 0) {
          const haystack = `${section.measureNo}${section.method}`
          if (!haystack.includes(keyword)) return false
        }
        if (filter.value.methods.length > 0 && !filter.value.methods.includes(section.method)) return false
        if (filter.value.minStageM !== null && section.stageM < filter.value.minStageM) return false
        return true
      })
      .sort((a, b) => Date.parse(b.measuredAt) - Date.parse(a.measuredAt))
  )

  const sectionById = (id: string | null | undefined): Section | null =>
    id ? sections.value.find((section) => section.id === id) ?? null : null

  /** 某测次已落库的断面流量成果（无则 null：尚未算出） */
  const dischargeOfSection = (sectionId: string | null | undefined): Discharge | null =>
    sectionId ? discharges.value.find((discharge) => discharge.sectionId === sectionId) ?? null : null

  /** 某测次成果是否已具备送交整编室的条件（算出且流量为正） */
  function isSectionReadyToReport(sectionId: string): boolean {
    const discharge = dischargeOfSection(sectionId)
    return !!discharge && isDischargeUsable(discharge)
  }

  /** 某断面下的垂线：按起点距升序（起点距排序校验的基础） */
  function verticalsOfSection(sectionId: string | null | undefined): Vertical[] {
    if (!sectionId) return []
    return verticals.value
      .filter((vertical) => vertical.sectionId === sectionId)
      .sort((a, b) => a.startDistanceM - b.startDistanceM)
  }

  const currentVertical = computed<Vertical | null>(() =>
    currentVerticalId.value
      ? verticals.value.find((vertical) => vertical.id === currentVerticalId.value) ?? null
      : null
  )

  /** 某垂线下的测点：按相对水深升序 */
  function pointsOfVertical(verticalId: string | null | undefined): Point[] {
    if (!verticalId) return []
    return points.value
      .filter((point) => point.verticalId === verticalId)
      .sort((a, b) => a.relativeDepth - b.relativeDepth)
  }

  /** 垂线 id → 测点数与最深水深，供断面列表与垂线页回显 */
  const verticalStats = computed<Record<string, { pointCount: number; depthM: number }>>(() => {
    const stats: Record<string, { pointCount: number; depthM: number }> = {}
    verticals.value.forEach((vertical) => {
      stats[vertical.id] = { pointCount: vertical.pointCount, depthM: vertical.depthM }
    })
    return stats
  })

  /** 断面 id → 垂线条数汇总 */
  const sectionVerticalCounts = computed<Record<string, number>>(() => {
    const counts: Record<string, number> = {}
    verticals.value.forEach((vertical) => {
      counts[vertical.sectionId] = (counts[vertical.sectionId] ?? 0) + 1
    })
    return counts
  })

  /** 起点距排序校验：返回重复起点距的垂线号清单 */
  function findDistanceConflicts(sectionId: string): number[] {
    const seen = new Map<number, number>()
    const conflicts: number[] = []
    verticalsOfSection(sectionId).forEach((vertical) => {
      const key = Number(vertical.startDistanceM.toFixed(3))
      if (seen.has(key)) {
        conflicts.push(vertical.no)
      } else {
        seen.set(key, vertical.no)
      }
    })
    return conflicts
  }

  function patchFilter(patch: Partial<SectionFilterState>): void {
    filter.value = { ...filter.value, ...patch }
  }

  function resetFilter(): void {
    filter.value = createEmptySectionFilter()
  }

  function selectSection(id: string | null): void {
    currentSectionId.value = id
  }

  function selectVertical(id: string | null): void {
    currentVerticalId.value = id
  }

  function resetVerticalDraft(nextNo = 1): void {
    verticalDraft.value = createEmptyVerticalDraft(nextNo)
  }

  function resetPointDraft(): void {
    pointDraft.value = createEmptyPointDraft()
  }

  /* ------------------------------ 断面测次 ------------------------------ */

  async function createSection(
    payload: Omit<Section, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<Section> {
    const now = Date.now()
    const row: Section = { ...payload, id: createId('sec'), createdAt: now, updatedAt: now }
    await fieldDb.sections.put(row)
    return row
  }

  async function updateSection(id: string, patch: Partial<Section>): Promise<void> {
    await fieldDb.sections.update(id, { ...patch, updatedAt: Date.now() } as never)
  }

  async function removeSection(id: string): Promise<void> {
    await fieldDb.transaction(
      'rw',
      [fieldDb.sections, fieldDb.verticals, fieldDb.points, fieldDb.discharges],
      async () => {
        const verticalIds = (await fieldDb.verticals.where('sectionId').equals(id).toArray()).map((row) => row.id)
        if (verticalIds.length > 0) {
          await fieldDb.points.where('verticalId').anyOf(verticalIds).delete()
          await fieldDb.verticals.bulkDelete(verticalIds)
        }
        await fieldDb.discharges.where('sectionId').equals(id).delete()
        await fieldDb.sections.delete(id)
      }
    )
  }

  /**
   * 报出断面流量成果给整编室：只在本侧成果上打报出标记（整编室那份由其自行送交）。
   * 必须先算出断面流量；报出后再改垂线 / 测点会让新版本对账时挂起引用点据。
   */
  async function reportDischarge(sectionId: string): Promise<Discharge | null> {
    const discharge = await recomputeDischarge(sectionId)
    if (!discharge || !isDischargeUsable(discharge)) return null
    const now = Date.now()
    const reported: Discharge = {
      ...discharge,
      reported: true,
      reportedAt: new Date(now).toISOString(),
      updatedAt: now
    }
    await fieldDb.discharges.put(reported)
    return reported
  }

  /* ------------------------------- 垂线 ------------------------------- */

  async function createVertical(
    sectionId: string,
    payload: Omit<Vertical, 'id' | 'createdAt' | 'updatedAt' | 'sectionId'>
  ): Promise<Vertical> {
    const now = Date.now()
    const row: Vertical = { ...payload, sectionId, id: createId('vrt'), createdAt: now, updatedAt: now }
    await fieldDb.verticals.put(row)
    // 录入测深后按相对水深自动生成测点行
    const depths = buildRelativeDepths(payload.pointCount)
    const pointRows: Point[] = depths.map((relativeDepth, index) => ({
      id: createId('pnt'),
      verticalId: row.id,
      relativeDepth,
      velocityMs: 0.5,
      weight: Number((1 / depths.length).toFixed(4)),
      durationS: 100,
      createdAt: now + index,
      updatedAt: now + index
    }))
    if (pointRows.length > 0) await fieldDb.points.bulkPut(pointRows)
    await recomputeDischarge(sectionId)
    return row
  }

  async function updateVertical(id: string, patch: Partial<Vertical>): Promise<void> {
    await fieldDb.verticals.update(id, { ...patch, updatedAt: Date.now() } as never)
    const vertical = verticals.value.find((item) => item.id === id)
    if (vertical) await recomputeDischarge(vertical.sectionId)
  }

  async function removeVertical(id: string): Promise<void> {
    const vertical = verticals.value.find((item) => item.id === id)
    await fieldDb.transaction('rw', [fieldDb.verticals, fieldDb.points], async () => {
      await fieldDb.points.where('verticalId').equals(id).delete()
      await fieldDb.verticals.delete(id)
    })
    if (vertical) await recomputeDischarge(vertical.sectionId)
  }

  /** 按测点数重排该垂线的测点行（保持已有流速值，缺失的补默认） */
  async function regeneratePoints(verticalId: string, pointCount: number): Promise<number> {
    const existing = pointsOfVertical(verticalId)
    const depths = buildRelativeDepths(pointCount)
    const now = Date.now()
    const rows: Point[] = depths.map((relativeDepth, index) => {
      const match = existing.find((point) => Math.abs(point.relativeDepth - relativeDepth) < 0.001)
      return {
        id: match?.id ?? createId('pnt'),
        verticalId,
        relativeDepth,
        velocityMs: match?.velocityMs ?? 0.5,
        weight: Number((1 / depths.length).toFixed(4)),
        durationS: match?.durationS ?? 100,
        createdAt: match?.createdAt ?? now + index,
        updatedAt: now + index
      }
    })
    const vertical = verticals.value.find((item) => item.id === verticalId)
    await fieldDb.transaction('rw', [fieldDb.verticals, fieldDb.points], async () => {
      await fieldDb.points.where('verticalId').equals(verticalId).delete()
      if (rows.length > 0) await fieldDb.points.bulkPut(rows)
      await fieldDb.verticals.update(verticalId, { pointCount: rows.length, updatedAt: now } as never)
    })
    if (vertical) await recomputeDischarge(vertical.sectionId)
    return rows.length
  }

  /* ------------------------------- 测点 ------------------------------- */

  async function createPoint(
    verticalId: string,
    payload: Omit<Point, 'id' | 'createdAt' | 'updatedAt' | 'verticalId'>
  ): Promise<Point> {
    const now = Date.now()
    const row: Point = { ...payload, verticalId, id: createId('pnt'), createdAt: now, updatedAt: now }
    await fieldDb.points.put(row)
    await syncVerticalPointCount(verticalId)
    return row
  }

  async function updatePoint(id: string, patch: Partial<Point>): Promise<void> {
    const point = points.value.find((item) => item.id === id)
    await fieldDb.points.update(id, { ...patch, updatedAt: Date.now() } as never)
    if (point) await recomputeDischarge(verticalSectionId(point.verticalId))
  }

  async function removePoint(id: string): Promise<void> {
    const point = points.value.find((item) => item.id === id)
    await fieldDb.points.delete(id)
    if (point) {
      await syncVerticalPointCount(point.verticalId)
      await recomputeDischarge(verticalSectionId(point.verticalId))
    }
  }

  /** 批量改写某垂线全部测点流速（批量录入） */
  async function bulkSetVelocity(verticalId: string, velocityMs: number): Promise<number> {
    const now = Date.now()
    await fieldDb.points
      .where('verticalId')
      .equals(verticalId)
      .modify((point) => {
        point.velocityMs = velocityMs
        point.updatedAt = now
      })
    await recomputeDischarge(verticalSectionId(verticalId))
    return pointsOfVertical(verticalId).length
  }

  /** 批量导入解析后的测点草稿（先清空该垂线旧测点行） */
  async function importPointDrafts(
    verticalId: string,
    rows: Array<{ relativeDepth: number; velocityMs: number; durationS: number }>
  ): Promise<number> {
    const now = Date.now()
    const records: Point[] = rows.map((row, index) => ({
      id: createId('pnt'),
      verticalId,
      relativeDepth: row.relativeDepth,
      velocityMs: row.velocityMs,
      weight: Number((1 / rows.length).toFixed(4)),
      durationS: row.durationS,
      createdAt: now + index,
      updatedAt: now + index
    }))
    await fieldDb.transaction('rw', [fieldDb.verticals, fieldDb.points], async () => {
      await fieldDb.points.where('verticalId').equals(verticalId).delete()
      await fieldDb.points.bulkPut(records)
      await fieldDb.verticals.update(verticalId, { pointCount: records.length, updatedAt: now } as never)
    })
    await recomputeDischarge(verticalSectionId(verticalId))
    return records.length
  }

  async function syncVerticalPointCount(verticalId: string): Promise<void> {
    const count = await fieldDb.points.where('verticalId').equals(verticalId).count()
    await fieldDb.verticals.update(verticalId, { pointCount: count, updatedAt: Date.now() } as never)
  }

  /** 权重归一化：按测点数平均分配计算权重 */
  async function normalizeWeights(verticalId: string): Promise<number> {
    const rows = pointsOfVertical(verticalId)
    if (rows.length === 0) return 0
    const weight = Number((1 / rows.length).toFixed(4))
    await fieldDb.points.bulkPut(rows.map((row) => ({ ...row, weight, updatedAt: Date.now() })))
    await recomputeDischarge(verticalSectionId(verticalId))
    return rows.length
  }

  /** 由垂线 id 反查所属测次（测点变动后联动重算断面流量） */
  function verticalSectionId(verticalId: string): string {
    return verticals.value.find((vertical) => vertical.id === verticalId)?.sectionId ?? ''
  }

  return {
    sections,
    verticals,
    points,
    discharges,
    ready,
    error,
    currentSectionId,
    currentVerticalId,
    currentVertical,
    filter,
    filteredSections,
    verticalDraft,
    pointDraft,
    pasteText,
    start,
    sectionsOfStation,
    sectionById,
    dischargeOfSection,
    isSectionReadyToReport,
    verticalsOfSection,
    pointsOfVertical,
    verticalStats,
    sectionVerticalCounts,
    findDistanceConflicts,
    patchFilter,
    resetFilter,
    selectSection,
    selectVertical,
    resetVerticalDraft,
    resetPointDraft,
    createSection,
    updateSection,
    removeSection,
    reportDischarge,
    createVertical,
    updateVertical,
    removeVertical,
    regeneratePoints,
    createPoint,
    updatePoint,
    removePoint,
    bulkSetVelocity,
    importPointDrafts,
    syncVerticalPointCount,
    normalizeWeights
  }
})
