/** 流量测验方法 */
export type MeasureMethod = '流速仪' | '浮标' | 'ADCP'

export const MEASURE_METHODS: MeasureMethod[] = ['流速仪', '浮标', 'ADCP']

/** 断面测次：一次完整的流量测验（外业组属主） */
export interface Section {
  id: string
  /** 所属测站 */
  stationId: string
  /** 测次号，如 2024-06-001 */
  measureNo: string
  /** 起点距（m）：断面起点到测流断面的距离 */
  startDistanceM: number
  /** 水位（m） */
  stageM: number
  /** 流速仪 / 浮标 / ADCP */
  method: MeasureMethod
  /** 测流时间 */
  measuredAt: string
  /**
   * 测次数据版本：垂线/测点/测次头每发生一次外业改动 +1。
   * 报出后若 revision > reportedRevision，说明成果已过时、整编室点据应挂起。
   */
  revision: number
  /** 是否已报出断面流量成果（整编室只认已报出测次） */
  reported: boolean
  /** 最近一次报出时的版本；未报出为 0 */
  reportedRevision: number
  /** 最近一次报出时间（ISO），未报出为 null */
  reportedAt: string | null
  /** 最近一次报出的断面流量（m³/s），未报出为 null */
  reportedFlowM3s: number | null
  createdAt: number
  updatedAt: number
}

/** 断面列表页的筛选条件（存于 sectionStore） */
export interface SectionFilterState {
  keyword: string
  methods: MeasureMethod[]
  /** 水位下限（m） */
  minStageM: number | null
}

export function createEmptySectionFilter(): SectionFilterState {
  return {
    keyword: '',
    methods: [],
    minStageM: null
  }
}
