/**
 * 外业收件入账：消费 fieldDb.inbox 中整编室送交的比测结论。
 * 结论按 runId 幂等（消息 id 即 msg_conclusion__runId），重复送交不重复留档；
 * 外业只保存这份只读结论，任何重定都不会改写外业自己的测次/垂线/测点。
 */
import { fieldDb } from './fieldDb'
import type { CompareConclusionPayload, InboxMessage } from '@/types/dispatch'

/** 已签收的结论批次在 localStorage 留一个轻量台账（页面列表直接读 inbox 即可，这里仅做去重标记） */
export async function applyFieldInbox(): Promise<{ conclusions: number }> {
  let conclusions = 0
  const messages = await fieldDb.inbox.where('applied').equals(0).toArray()
  for (const message of messages) {
    if (message.kind === 'compare-conclusion') {
      // 载荷本身不可变，inbox 即结论台账；只需标记已签收
      void (message.payload as CompareConclusionPayload)
      conclusions += 1
    }
    await fieldDb.inbox.update(message.id, { applied: 1 })
  }
  return { conclusions }
}

/** 按时间倒序读取已收到的比测结论批次 */
export async function listConclusions(): Promise<Array<InboxMessage & { payload: CompareConclusionPayload }>> {
  const rows = await fieldDb.inbox.where('kind').equals('compare-conclusion').toArray()
  return rows
    .filter((row): row is InboxMessage & { payload: CompareConclusionPayload } => true)
    .sort((a, b) => b.receivedAt - a.receivedAt)
}
