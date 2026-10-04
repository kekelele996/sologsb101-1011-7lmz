/**
 * 外业库备份导入导出：外业属主数据（测站/测次/垂线/测点）+ 外业收发件箱。
 * 备份不含整编室的点据/定线/比测，符合「两边各自持有」。
 */
import { fieldDb, FIELD_DB_NAME, FIELD_DB_VERSION, stampBackupTime } from './fieldDb'
import { clearFieldDatabase } from './bootstrap'

export interface FieldBackupPayload {
  app: 'gbhydrogaug-field'
  dbVersion: number
  exportedAt: string
  stations: unknown[]
  sections: unknown[]
  verticals: unknown[]
  points: unknown[]
  outbox: unknown[]
  inbox: unknown[]
}

export async function buildFieldBackup(): Promise<FieldBackupPayload> {
  const [stations, sections, verticals, points, outbox, inbox] = await Promise.all([
    fieldDb.stations.toArray(),
    fieldDb.sections.toArray(),
    fieldDb.verticals.toArray(),
    fieldDb.points.toArray(),
    fieldDb.outbox.toArray(),
    fieldDb.inbox.toArray()
  ])
  return {
    app: 'gbhydrogaug-field',
    dbVersion: FIELD_DB_VERSION,
    exportedAt: new Date().toISOString(),
    stations,
    sections,
    verticals,
    points,
    outbox,
    inbox
  }
}

export function validateFieldBackup(input: unknown): { ok: boolean; errors: string[]; payload: FieldBackupPayload | null } {
  const errors: string[] = []
  if (typeof input !== 'object' || input === null) {
    return { ok: false, errors: ['文件内容不是合法的 JSON 对象'], payload: null }
  }
  const obj = input as Partial<FieldBackupPayload>
  if (obj.app !== 'gbhydrogaug-field') errors.push('app 字段应为 gbhydrogaug-field，不是外业库备份')
  for (const key of ['stations', 'sections', 'verticals', 'points'] as const) {
    if (!Array.isArray(obj[key])) errors.push(`${key} 字段缺失或不是数组`)
  }
  if (errors.length > 0) return { ok: false, errors, payload: null }
  return {
    ok: true,
    errors: [],
    payload: {
      app: 'gbhydrogaug-field',
      dbVersion: typeof obj.dbVersion === 'number' ? obj.dbVersion : FIELD_DB_VERSION,
      exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : new Date().toISOString(),
      stations: obj.stations ?? [],
      sections: obj.sections ?? [],
      verticals: obj.verticals ?? [],
      points: obj.points ?? [],
      outbox: Array.isArray(obj.outbox) ? obj.outbox : [],
      inbox: Array.isArray(obj.inbox) ? obj.inbox : []
    }
  }
}

export async function exportFieldJson(): Promise<{ fileName: string; total: number }> {
  const payload = await buildFieldBackup()
  const fileName = `${FIELD_DB_NAME}-v${payload.dbVersion}-${payload.exportedAt
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
    payload.stations.length +
    payload.sections.length +
    payload.verticals.length +
    payload.points.length
  return { fileName, total }
}

/** 覆盖导入外业库（整编室那份不动） */
export async function importFieldBackup(payload: FieldBackupPayload, overwrite: boolean): Promise<void> {
  if (overwrite) await clearFieldDatabase()
  await fieldDb.transaction(
    'rw',
    [fieldDb.stations, fieldDb.sections, fieldDb.verticals, fieldDb.points, fieldDb.outbox, fieldDb.inbox],
    async () => {
      await fieldDb.stations.bulkPut(payload.stations as never[])
      await fieldDb.sections.bulkPut(payload.sections as never[])
      await fieldDb.verticals.bulkPut(payload.verticals as never[])
      await fieldDb.points.bulkPut(payload.points as never[])
      if (overwrite) {
        await fieldDb.outbox.bulkPut(payload.outbox as never[])
        await fieldDb.inbox.bulkPut(payload.inbox as never[])
      }
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
