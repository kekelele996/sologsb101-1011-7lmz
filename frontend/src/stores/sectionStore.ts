/**
 * 外业 · 断面 store：测次、垂线、测点（均在外业库），断面流量实时计算与报出。
 *
 * 分权规则：
 *  - 报出后任何测次头/垂线/测点改动都经 notifySectionsChanged 提版本并通知整编挂起；
 *  - 报出动作只写外业自己的 outbox，整编室是否在案不影响外业继续作业。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { fieldDb, createId, watchTable } from '@/utils/fieldDb'
import { computeDischarge, newSectionDefaults, notifySectionsChanged, reportSection } from '@/utils/fieldService'
import type { Section } from '@/types/section'
import { createEmptySectionFilter, type SectionFilterState } from '@/types/section'
import type { Vertical } from '@/types/vertical'
import { buildRelativeDepths } from '@/types/vertical'
import type { Point } from '@/types/point'
import type { DischargeResult } from '@/utils/flow'

export interface VerticalDraft {
  no: number
  startDistanceM: number
  depthM: number
  bedNote: string
  pointCount: number
}

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
  const ready = ref(false)
  const error = ref<string | null>(null)
  const currentSectionId = ref<string | null>(null)
  const currentVerticalId = ref<string | null>(null)
  const filter = ref<SectionFilterState>(createEmptySectionFilter())
  const verticalDraft = ref<VerticalDraft>(createEmptyVerticalDraft())
  const pointDraft = ref<PointDraft>(createEmptyPointDraft())
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
  }

  function sectionsOfStation(stationId: string | null | undefined): Section[] {
    if (!stationId) return []
    return sections.value
      .filter((section) => section.stationId === stationId)
      .sort((a, b) => Date.parse(b.measuredAt) - Date.parse(a.measuredAt))
  }

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

  function pointsOfVertical(verticalId: string | null | undefined): Point[] {
    if (!verticalId) return []
    return points.value
      .filter((point) => point.verticalId === verticalId)
      .sort((a, b) => a.relativeDepth - b.relativeDepth)
  }

  const sectionVerticalCounts = computed<Record<string, number>>(() => {
    const counts: Record<string, number> = {}
    verticals.value.forEach((vertical) => {
      counts[vertical.sectionId] = (counts[vertical.sectionId] ?? 0) + 1
    })
    return counts
  })

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

  /** 实时断面流量成果（部分面积法，供垂线页/测点页回显） */
  function dischargeOfSection(sectionId: string): DischargeResult {
    const verticalRows = verticalsOfSection(sectionId)
    return computeDischarge(
      verticalRows,
      verticalRows.flatMap((v) => pointsOfVertical(v.id))
    )
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
    payload: Omit<Section, 'id' | 'createdAt' | 'updatedAt' | keyof ReturnType<typeof newSectionDefaults>>
  ): Promise<Section> {
    const now = Date.now()
    const row: Section = { ...payload, ...newSectionDefaults(), id: createId('sec'), createdAt: now, updatedAt: now }
    await fieldDb.sections.put(row)
    return row
  }

  /** 编辑测次头：若已报出则提版本并通知整编挂起相关点据 */
  async function updateSection(id: string, patch: Partial<Section>): Promise<void> {
    const before = await fieldDb.sections.get(id)
    await fieldDb.sections.update(id, { ...patch, updatedAt: Date.now() } as never)
    if (before?.reported) {
      const affectsReport =
        patch.stageM !== undefined || patch.measuredAt !== undefined || patch.method !== undefined
      if (affectsReport) {
        await notifySectionsChanged([id], '外业修改了已报出测次的水位/测法/测流时间')
      }
    }
  }

  async function removeSection(id: string): Promise<void> {
    await fieldDb.transaction('rw', [fieldDb.sections, fieldDb.verticals, fieldDb.points], async () => {
      const verticalIds = (await fieldDb.verticals.where('sectionId').equals(id).toArray()).map((row) => row.id)
      if (verticalIds.length > 0) {
        await fieldDb.points.where('verticalId').anyOf(verticalIds).delete()
        await fieldDb.verticals.bulkDelete(verticalIds)
      }
      await fieldDb.sections.delete(id)
    })
  }

  /** 报出测次断面流量（校验已算出成果）；失败由外业本侧重试 */
  async function report(id: string): Promise<{ revision: number; flowM3s: number }> {
    return reportSection(id)
  }

  /* ------------------------------- 垂线 ------------------------------- */

  async function createVertical(
    sectionId: string,
    payload: Omit<Vertical, 'id' | 'createdAt' | 'updatedAt' | 'sectionId'>
  ): Promise<Vertical> {
    const now = Date.now()
    const row: Vertical = { ...payload, sectionId, id: createId('vrt'), createdAt: now, updatedAt: now }
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
    await fieldDb.transaction('rw', [fieldDb.verticals, fieldDb.points], async () => {
      await fieldDb.verticals.put(row)
      if (pointRows.length > 0) await fieldDb.points.bulkPut(pointRows)
    })
    const section = await fieldDb.sections.get(sectionId)
    if (section?.reported) {
      await notifySectionsChanged([sectionId], '外业补录/新增了垂线')
    }
    return row
  }

  async function updateVertical(id: string, patch: Partial<Vertical>): Promise<void> {
    const vertical = await fieldDb.verticals.get(id)
    await fieldDb.verticals.update(id, { ...patch, updatedAt: Date.now() } as never)
    if (vertical) {
      const section = await fieldDb.sections.get(vertical.sectionId)
      if (section?.reported) {
        await notifySectionsChanged([vertical.sectionId], '外业修改了垂线测深')
      }
    }
  }

  async function removeVertical(id: string): Promise<void> {
    const vertical = await fieldDb.verticals.get(id)
    await fieldDb.transaction('rw', [fieldDb.verticals, fieldDb.points], async () => {
      await fieldDb.points.where('verticalId').equals(id).delete()
      await fieldDb.verticals.delete(id)
    })
    if (vertical) {
      const section = await fieldDb.sections.get(vertical.sectionId)
      if (section?.reported) {
        await notifySectionsChanged([vertical.sectionId], '外业删除了垂线')
      }
    }
  }

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
    const vertical = await fieldDb.verticals.get(verticalId)
    await fieldDb.transaction('rw', [fieldDb.verticals, fieldDb.points], async () => {
      await fieldDb.points.where('verticalId').equals(verticalId).delete()
      if (rows.length > 0) await fieldDb.points.bulkPut(rows)
      await fieldDb.verticals.update(verticalId, { pointCount: rows.length, updatedAt: now } as never)
    })
    if (vertical) {
      const section = await fieldDb.sections.get(vertical.sectionId)
      if (section?.reported) {
        await notifySectionsChanged([vertical.sectionId], '外业重排了垂线测点')
      }
    }
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
    await afterPointChanged(verticalId, '外业补录了流速测点')
    return row
  }

  async function updatePoint(id: string, patch: Partial<Point>): Promise<void> {
    const point = await fieldDb.points.get(id)
    await fieldDb.points.update(id, { ...patch, updatedAt: Date.now() } as never)
    if (point) await afterPointChanged(point.verticalId, '外业修改了流速测点')
  }

  async function removePoint(id: string): Promise<void> {
    const point = points.value.find((item) => item.id === id) ?? (await fieldDb.points.get(id))
    await fieldDb.points.delete(id)
    if (point) {
      await syncVerticalPointCount(point.verticalId)
      await afterPointChanged(point.verticalId, '外业删除了流速测点')
    }
  }

  /** 报出后测点改动：提版本并通知整编挂起（只挂相关测次那条点据） */
  async function afterPointChanged(verticalId: string, reason: string): Promise<void> {
    const vertical = await fieldDb.verticals.get(verticalId)
    if (!vertical) return
    const section = await fieldDb.sections.get(vertical.sectionId)
    if (section?.reported) {
      await notifySectionsChanged([vertical.sectionId], reason)
    }
  }

  async function bulkSetVelocity(verticalId: string, velocityMs: number): Promise<number> {
    const now = Date.now()
    await fieldDb.points
      .where('verticalId')
      .equals(verticalId)
      .modify((point) => {
        point.velocityMs = velocityMs
        point.updatedAt = now
      })
    await afterPointChanged(verticalId, '外业批量改写了测点流速')
    return pointsOfVertical(verticalId).length
  }

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
    await afterPointChanged(verticalId, '外业批量导入了测点')
    return records.length
  }

  async function syncVerticalPointCount(verticalId: string): Promise<void> {
    const count = await fieldDb.points.where('verticalId').equals(verticalId).count()
    await fieldDb.verticals.update(verticalId, { pointCount: count, updatedAt: Date.now() } as never)
  }

  async function normalizeWeights(verticalId: string): Promise<number> {
    const rows = pointsOfVertical(verticalId)
    if (rows.length === 0) return 0
    const weight = Number((1 / rows.length).toFixed(4))
    await fieldDb.points.bulkPut(rows.map((row) => ({ ...row, weight, updatedAt: Date.now() })))
    await afterPointChanged(verticalId, '外业归一了测点权重')
    return rows.length
  }

  return {
    sections,
    verticals,
    points,
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
    verticalsOfSection,
    pointsOfVertical,
    sectionVerticalCounts,
    findDistanceConflicts,
    dischargeOfSection,
    patchFilter,
    resetFilter,
    selectSection,
    selectVertical,
    resetVerticalDraft,
    resetPointDraft,
    createSection,
    updateSection,
    removeSection,
    report,
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
