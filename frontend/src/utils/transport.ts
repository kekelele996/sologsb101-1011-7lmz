/**
 * 跨属主消息通道：把发送方 outbox 的消息投递到接收方 inbox。
 *
 * 现实中两边是两个岗位/两台机器，这里在同一浏览器内用两个 IndexedDB 模拟
 * 「送交」这一跨边界动作。通道可以被「置障」（模拟送交失败），失败后：
 *  - 消息留在发送方 outbox，状态 failed、attempts+1、记录错误；
 *  - 只有发送方按本侧重试（retrySide），接收方那份 inbox 原样不动；
 *  - 接收按消息幂等键去重，重复送达不会重复入账。
 */
import Dexie from 'dexie'
import { fieldDb } from './fieldDb'
import { officeDb } from './officeDb'
import type {
  CompareConclusionPayload,
  DischargeReportPayload,
  DispatchKind,
  InboxMessage,
  OutboxMessage,
  OwnerSide,
  SectionChangedPayload,
  StationSyncPayload
} from '@/types/dispatch'
import { messageId } from '@/types/dispatch'

/** 两类消息方向的置障开关（localStorage，便于演示与自动化验证） */
const FAIL_KEYS = {
  'field->office': 'gbhydrogaug:fail:field-to-office',
  'office->field': 'gbhydrogaug:fail:office-to-field'
} as const

type FailDirection = keyof typeof FAIL_KEYS

export function isChannelBlocked(from: OwnerSide, to: OwnerSide): boolean {
  const key: FailDirection = `${from}->${to}` as FailDirection
  try {
    return localStorage.getItem(FAIL_KEYS[key]) === '1'
  } catch {
    return false
  }
}

export function setChannelBlocked(from: OwnerSide, to: OwnerSide, blocked: boolean): void {
  const key: FailDirection = `${from}->${to}` as FailDirection
  try {
    if (blocked) localStorage.setItem(FAIL_KEYS[key], '1')
    else localStorage.removeItem(FAIL_KEYS[key])
  } catch {
    // 忽略
  }
}

function dbOf(side: OwnerSide): Dexie {
  return side === 'field' ? fieldDb : officeDb
}

/** 构造一条待发送消息并入发送方 outbox（幂等：已存在则原样返回） */
export async function enqueueMessage(
  from: OwnerSide,
  kind: DispatchKind,
  payload: OutboxMessage['payload']
): Promise<OutboxMessage> {
  const outbox = dbOf(from).table<OutboxMessage>('outbox')
  const id = businessMessageId(from, kind, payload)
  const existing = await outbox.get(id)
  if (existing) return existing
  const now = Date.now()
  const message: OutboxMessage = {
    id,
    kind,
    from,
    to: opposite(from),
    payload,
    status: 'pending',
    attempts: 0,
    lastError: '',
    createdAt: now,
    updatedAt: now,
    deliveredAt: null
  }
  await outbox.put(message)
  // 入队即尝试一次投递（失败不抛出，留给重试）
  await deliverOne(message)
  return message
}

function opposite(side: OwnerSide): OwnerSide {
  return side === 'field' ? 'office' : 'field'
}

/** 由载荷推导幂等键：同一业务对象同版本只发一条，结论按批次只发一条 */
function businessMessageId(from: OwnerSide, kind: DispatchKind, payload: OutboxMessage['payload']): string {
  switch (kind) {
    case 'station-sync':
      return messageId('station', from, (payload as StationSyncPayload).station.id, (payload as StationSyncPayload).revision)
    case 'discharge-report': {
      const p = payload as DischargeReportPayload
      return messageId('discharge', p.sectionId, p.revision)
    }
    case 'section-changed': {
      const p = payload as SectionChangedPayload
      return messageId('changed', p.sectionId, p.revision)
    }
    case 'compare-conclusion': {
      const p = payload as CompareConclusionPayload
      return messageId('conclusion', p.runId)
    }
    default:
      return messageId('unknown', Date.now(), Math.random())
  }
}

/**
 * 投递单条消息：模拟跨库写入。
 * 通道置障时只更新发送方 outbox 为 failed，不写接收方。
 */
async function deliverOne(message: OutboxMessage): Promise<void> {
  const senderBox = dbOf(message.from).table<OutboxMessage>('outbox')
  const receiverBox = dbOf(message.to).table<InboxMessage>('inbox')

  if (message.status === 'delivered') return
  message.attempts += 1
  message.updatedAt = Date.now()

  if (isChannelBlocked(message.from, message.to)) {
    message.status = 'failed'
    message.lastError = '送交失败：通道故障（模拟），等待本侧重试'
    await senderBox.put(message)
    return
  }

  try {
    // 幂等：接收方已有同键消息则只补发送方状态，不重复落 inbox
    const exists = await receiverBox.get(message.id)
    if (!exists) {
      const inboxRow: InboxMessage = {
        id: message.id,
        kind: message.kind,
        from: message.from,
        payload: message.payload,
        applied: 0,
        receivedAt: Date.now()
      }
      await receiverBox.put(inboxRow)
    }
    message.status = 'delivered'
    message.lastError = ''
    message.deliveredAt = Date.now()
    await senderBox.put(message)
  } catch (err) {
    message.status = 'failed'
    message.lastError = err instanceof Error ? err.message : '送交失败：未知错误'
    await senderBox.put(message)
  }
}

/**
 * 发送方按本侧重试：只扫自己库 outbox 里 pending/failed 的消息重投。
 * 绝不读取或修改对方库的业务数据（只在通道畅通时写对方 inbox）。
 */
export async function retrySide(side: OwnerSide): Promise<{ sent: number; stillFailing: number }> {
  const box = dbOf(side).table<OutboxMessage>('outbox')
  const pending = await box.where('status').anyOf('pending', 'failed').toArray()
  let sent = 0
  for (const message of pending) {
    const before = message.status
    await deliverOne(message)
    if (before !== 'delivered' && message.status === 'delivered') sent += 1
  }
  const stillFailing = await box.where('status').equals('failed').count()
  return { sent, stillFailing }
}

/** 自动投递：把某侧所有未送达消息尝试一遍（应用打开/切换岗位时调用） */
export async function flushSide(side: OwnerSide): Promise<void> {
  const box = dbOf(side).table<OutboxMessage>('outbox')
  const pending = await box.where('status').anyOf('pending', 'failed').toArray()
  for (const message of pending) {
    await deliverOne(message)
  }
}

/** 统计某侧发件箱待办（导航徽标用） */
export async function outboxFailCount(side: OwnerSide): Promise<number> {
  return dbOf(side).table<OutboxMessage>('outbox').where('status').equals('failed').count()
}
