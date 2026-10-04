/**
 * 外业 · 测站 store：维护外业库测站列表、当前选中测站与筛选条件。
 * 测站是外业属主；新建/编辑后向整编室发 station-sync 档案同步。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { fieldDb, createId, watchTable, readLastStationId, writeLastStationId } from '@/utils/fieldDb'
import { syncStation } from '@/utils/fieldService'
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

  const riverOptions = computed<string[]>(() =>
    Array.from(new Set(stations.value.map((station) => station.river))).sort((a, b) => a.localeCompare(b))
  )

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

  async function createStation(payload: Omit<Station, 'id' | 'createdAt' | 'updatedAt'>): Promise<Station> {
    const now = Date.now()
    const row: Station = { ...payload, id: createId('stn'), createdAt: now, updatedAt: now }
    await fieldDb.stations.put(row)
    await syncStation(row)
    return row
  }

  async function updateStation(id: string, patch: Partial<Station>): Promise<void> {
    const now = Date.now()
    await fieldDb.stations.update(id, { ...patch, updatedAt: now } as never)
    const row = await fieldDb.stations.get(id)
    if (row) await syncStation(row)
  }

  /** 删除测站：仅级联删除外业库的测次/垂线/测点（整编室点据归整编室，不在此删） */
  async function removeStation(id: string): Promise<void> {
    await fieldDb.transaction(
      'rw',
      [fieldDb.stations, fieldDb.sections, fieldDb.verticals, fieldDb.points],
      async () => {
        const sectionIds = (await fieldDb.sections.where('stationId').equals(id).toArray()).map((row) => row.id)
        if (sectionIds.length > 0) {
          const verticalIds = (await fieldDb.verticals.where('sectionId').anyOf(sectionIds).toArray()).map(
            (row) => row.id
          )
          if (verticalIds.length > 0) {
            await fieldDb.points.where('verticalId').anyOf(verticalIds).delete()
          }
          await fieldDb.verticals.where('sectionId').anyOf(sectionIds).delete()
          await fieldDb.sections.where('stationId').equals(id).delete()
        }
        await fieldDb.stations.delete(id)
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
