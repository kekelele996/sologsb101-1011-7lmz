/**
 * 测站 store：维护共享测站台账。
 *
 * 归属：测站台账主本在外业库（外业组建档），整编室库只留只读副本供点据引用站名。
 * 台账的新建 / 编辑 / 删除都从外业库发出，同时把副本同步到整编库；
 * 整编室的定线、比测永远不会回写外业主本。
 * 数据经 utils/db.ts 的 Dexie 表订阅实时刷新，页面只读消费。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  fieldDb,
  officeDb,
  createId,
  readLastStationId,
  watchTable,
  writeLastStationId
} from '@/utils/db'
import type { Station } from '@/types/station'
import type { Section } from '@/types/section'
import { createEmptyStationFilter, type StationFilterState } from '@/types/station'

export const useStationStore = defineStore('station', () => {
  const stations = ref<Station[]>([])
  const sections = ref<Section[]>([])
  const ready = ref(false)
  const error = ref<string | null>(null)
  const currentStationId = ref<string | null>(readLastStationId())
  const filter = ref<StationFilterState>(createEmptyStationFilter())

  let started = false

  /** 启动 IndexedDB 实时订阅（幂等）：台账读外业主本，测次读外业库 */
  function start(): void {
    if (started) return
    started = true
    watchTable<Station>(() => fieldDb.stations).subscribe((rows) => {
      stations.value = rows
      ready.value = true
      error.value = null
      if (currentStationId.value === null && rows.length > 0) {
        selectStation(rows[0].id)
      }
    })
    watchTable<Section>(() => fieldDb.sections).subscribe((rows) => {
      sections.value = rows
    })
  }

  const currentStation = computed<Station | null>(
    () => stations.value.find((station) => station.id === currentStationId.value) ?? null
  )

  /** 全部可选河名（筛选下拉与表单联想共用） */
  const riverOptions = computed<string[]>(() =>
    Array.from(new Set(stations.value.map((station) => station.river))).sort((a, b) => a.localeCompare(b))
  )

  /** 测站 id → 测次数量、最新水位与最新测次时间 */
  const sectionStats = computed<
    Record<string, { count: number; latestStageM: number | null; latestMeasuredAt: string | null }>
  >(() => {
    const stats: Record<string, { count: number; latestStageM: number | null; latestMeasuredAt: string | null }> = {}
    sections.value.forEach((section) => {
      const bucket = stats[section.stationId] ?? { count: 0, latestStageM: null, latestMeasuredAt: null }
      bucket.count += 1
      const time = Date.parse(section.measuredAt)
      const lastTime = bucket.latestMeasuredAt ? Date.parse(bucket.latestMeasuredAt) : -Infinity
      if (bucket.latestMeasuredAt === null || time >= lastTime) {
        bucket.latestStageM = section.stageM
        bucket.latestMeasuredAt = section.measuredAt
      }
      stats[section.stationId] = bucket
    })
    return stats
  })

  /** 按筛选条件过滤后的测站 */
  const filteredStations = computed<Station[]>(() =>
    stations.value.filter((station) => {
      const keyword = filter.value.keyword.trim()
      if (keyword.length > 0) {
        const haystack = `${station.name}${station.river}${station.sectionCode}${station.remark}`
        if (!haystack.includes(keyword)) return false
      }
      if (filter.value.rivers.length > 0 && !filter.value.rivers.includes(station.river)) return false
      if (filter.value.minCatchmentKm2 !== null && station.catchmentKm2 < filter.value.minCatchmentKm2) return false
      if (filter.value.maxCatchmentKm2 !== null && station.catchmentKm2 > filter.value.maxCatchmentKm2) return false
      return true
    })
  )

  const hasFilter = computed<boolean>(
    () =>
      filter.value.keyword.trim().length > 0 ||
      filter.value.rivers.length > 0 ||
      filter.value.minCatchmentKm2 !== null ||
      filter.value.maxCatchmentKm2 !== null
  )

  /** 合计集水面积（km²） */
  const totalCatchmentKm2 = computed<number>(() =>
    Number(filteredStations.value.reduce((sum, station) => sum + station.catchmentKm2, 0).toFixed(1))
  )

  function patchFilter(patch: Partial<StationFilterState>): void {
    filter.value = { ...filter.value, ...patch }
  }

  function resetFilter(): void {
    filter.value = createEmptyStationFilter()
  }

  function selectStation(id: string | null): void {
    currentStationId.value = id
    writeLastStationId(id)
  }

  function stationById(id: string | null | undefined): Station | null {
    if (!id) return null
    return stations.value.find((station) => station.id === id) ?? null
  }

  /** 台账主本写入外业库后，把同一行副本推到整编库（整编只读引用） */
  async function syncStationCopyToOffice(station: Station): Promise<void> {
    await officeDb.stations.put({ ...station })
  }

  async function createStation(payload: Omit<Station, 'id' | 'createdAt' | 'updatedAt'>): Promise<Station> {
    const now = Date.now()
    const row: Station = { ...payload, id: createId('stn'), createdAt: now, updatedAt: now }
    await fieldDb.stations.put(row)
    await syncStationCopyToOffice(row)
    return row
  }

  async function updateStation(id: string, patch: Partial<Station>): Promise<void> {
    const now = Date.now()
    await fieldDb.stations.update(id, { ...patch, updatedAt: now } as never)
    const updated = await fieldDb.stations.get(id)
    if (updated) await syncStationCopyToOffice(updated)
  }

  /**
   * 删除测站：外业库级联删除测次、垂线、测点与断面成果；
   * 整编室一侧只删台账副本与该站点据 / 比测 / 结论（整编自管数据），
   * 两侧删除都由台账主本发起，整编室不会反向删除外业资料。
   */
  async function removeStation(id: string): Promise<void> {
    await fieldDb.transaction(
      'rw',
      [fieldDb.stations, fieldDb.sections, fieldDb.verticals, fieldDb.points, fieldDb.discharges],
      async () => {
        const sectionIds = (await fieldDb.sections.where('stationId').equals(id).toArray()).map((row) => row.id)
        const verticalIds =
          sectionIds.length > 0
            ? (await fieldDb.verticals.where('sectionId').anyOf(sectionIds).toArray()).map((row) => row.id)
            : []
        if (verticalIds.length > 0) {
          await fieldDb.points.where('verticalId').anyOf(verticalIds).delete()
        }
        if (sectionIds.length > 0) {
          await fieldDb.discharges.where('sectionId').anyOf(sectionIds).delete()
          await fieldDb.verticals.where('sectionId').anyOf(sectionIds).delete()
          await fieldDb.sections.where('stationId').equals(id).delete()
        }
        await fieldDb.stations.delete(id)
      }
    )
    await officeDb.transaction(
      'rw',
      [officeDb.stations, officeDb.ratings, officeDb.compares, officeDb.conclusions],
      async () => {
        const ratingIds = (await officeDb.ratings.where('stationId').equals(id).toArray()).map((row) => row.id)
        if (ratingIds.length > 0) {
          await officeDb.compares.where('ratingId').anyOf(ratingIds).delete()
        }
        // 点据、比测、该站定线的旧结论一并清除（整编自管数据）；旧结论已随级联删除
        await officeDb.ratings.where('stationId').equals(id).delete()
        await officeDb.stations.delete(id)
      }
    )
    if (currentStationId.value === id) selectStation(null)
  }

  return {
    stations,
    sections,
    ready,
    error,
    currentStationId,
    currentStation,
    filter,
    riverOptions,
    sectionStats,
    filteredStations,
    hasFilter,
    totalCatchmentKm2,
    start,
    patchFilter,
    resetFilter,
    selectStation,
    stationById,
    createStation,
    updateStation,
    removeStation
  }
})
