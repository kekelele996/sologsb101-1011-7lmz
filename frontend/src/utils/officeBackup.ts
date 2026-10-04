/**
 * 整编室库备份导入导出：点据/定线/比测结论/报出收件 + 收发件箱。
 * 备份不含外业的测次/垂线/测点，符合「两边各自持有」。
 */
import { officeDb, OFFICE_DB_NAME, OFFICE_DB_VERSION, stampBackupTime } from './officeDb'

export interface OfficeBackupPayload {
  app: 'gbhydrogaug-office'
  dbVersion: number
  exportedAt: string
  stations: unknown[]
  stationRevs: unknown[]
  inReports: unknown[]
  ratingPoints: unknown[]
  ratingLines: unknown[]
  compareRuns: unknown[]
  outbox: unknown[]
  inbox: unknown[]
}

export async function buildOfficeBackup(): Promise<OfficeBackupPayload> {
  const [stations, stationRevs, inReports, ratingPoints, ratingLines, compareRuns, outbox, inbox] =
    await Promise.all([
      officeDb.stations.toArray(),
      officeDb.stationRevs.toArray(),
      officeDb.inReports.toArray(),
      officeDb.ratingPoints.toArray(),
      officeDb.ratingLines.toArray(),
      officeDb.compareRuns.toArray(),
      officeDb.outbox.toArray(),
      officeDb.inbox.toArray()
    ])
  return {
    app: 'gbhydrogaug-office',
    dbVersion: OFFICE_DB_VERSION,
    exportedAt: new Date().toISOString(),
    stations,
    stationRevs,
    inReports,
    ratingPoints,
    ratingLines,
    compareRuns,
    outbox,
    inbox
  }
}

export function validateOfficeBackup(
  input: unknown
): { ok: boolean; errors: string[]; payload: OfficeBackupPayload | null } {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, errors: ['文件内容不是合法的 JSON 对象'], payload: null }
  }
  const obj = input as Partial<OfficeBackupPayload>
  const errors: string[] = []
  if (obj.app !== 'gbhydrogaug-office') errors.push('app 字段应为 gbhydrogaug-office，不是整编室库备份')
  for (const key of ['inReports', 'ratingPoints', 'ratingLines', 'compareRuns'] as const) {
    if (!Array.isArray(obj[key])) errors.push(`${key} 字段缺失或不是数组`)
  }
  if (errors.length > 0) return { ok: false, errors, payload: null }
  return {
    ok: true,
    errors: [],
    payload: {
      app: 'gbhydrogaug-office',
      dbVersion: typeof obj.dbVersion === 'number' ? obj.dbVersion : OFFICE_DB_VERSION,
      exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : new Date().toISOString(),
      stations: Array.isArray(obj.stations) ? obj.stations : [],
      stationRevs: Array.isArray(obj.stationRevs) ? obj.stationRevs : [],
      inReports: obj.inReports ?? [],
      ratingPoints: obj.ratingPoints ?? [],
      ratingLines: obj.ratingLines ?? [],
      compareRuns: obj.compareRuns ?? [],
      outbox: Array.isArray(obj.outbox) ? obj.outbox : [],
      inbox: Array.isArray(obj.inbox) ? obj.inbox : []
    }
  }
}

export async function exportOfficeJson(): Promise<{ fileName: string; total: number }> {
  const payload = await buildOfficeBackup()
  const fileName = `${OFFICE_DB_NAME}-v${payload.dbVersion}-${payload.exportedAt
    .slice(0, 19)
    .replace(/[:T]/g, '')}.json`
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
  stampBackupTime(payload.exportedAt)
  const total =
    payload.ratingPoints.length + payload.ratingLines.length + payload.compareRuns.length + payload.inReports.length
  return { fileName, total }
}

/** 覆盖导入整编室库（外业那份不动） */export async function importOfficeBackup(payload: OfficeBackupPayload, overwrite: boolean): Promise<void> {
  if (overwrite) {
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
        await Promise.all([
          officeDb.stations.clear(),
          officeDb.stationRevs.clear(),
          officeDb.inReports.clear(),
          officeDb.ratingPoints.clear(),
          officeDb.ratingLines.clear(),
          officeDb.compareRuns.clear(),
          officeDb.outbox.clear(),
          officeDb.inbox.clear()
        ])
      }
    )
  }
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
      if (overwrite) {
        await officeDb.stations.bulkPut(payload.stations as never[])
        await officeDb.stationRevs.bulkPut(payload.stationRevs as never[])
        await officeDb.inReports.bulkPut(payload.inReports as never[])
        await officeDb.outbox.bulkPut(payload.outbox as never[])
        await officeDb.inbox.bulkPut(payload.inbox as never[])
      }
      await officeDb.ratingPoints.bulkPut(payload.ratingPoints as never[])
      await officeDb.ratingLines.bulkPut(payload.ratingLines as never[])
      await officeDb.compareRuns.bulkPut(payload.compareRuns as never[])
    }
  )
}

export function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('文件读取失败'))
    reader.readAsText(file, 'utf-8')
  })
}
