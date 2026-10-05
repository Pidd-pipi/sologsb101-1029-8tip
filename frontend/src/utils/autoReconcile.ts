/**
 * 托管差异自动失效重算调度：
 * 观察现场记录 / 接戏组 / 要素 / 拍摄日的「时间轴签名」，
 * 一旦现场记录发生变化（新增、修改、删除、挂接改变），
 * 延迟一小段时间后按拍摄日、镜次整体重算组内托管差异。
 * 用签名比对避免重算写库引发的观察者回环。
 */
import { liveQuery } from 'dexie'
import { db } from './db'
import { reconcileManagedConflicts } from './groupReconcile'

interface TimelineSignature {
  /** 现场记录时间轴签名：id|拍摄日|要素|镜次|状态 的拼接，变化即需重算 */
  recordsKey: string
  /** 接戏组挂接签名：只看组成员（基准文本 / 版本号变化不改变时间轴结构，不触发重算） */
  groupsKey: string
}

async function readSignature(): Promise<TimelineSignature> {
  const [records, groups, shootDays] = await Promise.all([
    db.records.toArray(),
    db.continuityGroups.toArray(),
    db.shootDays.toArray()
  ])
  const dateOf = new Map(shootDays.map((day) => [day.id, day.date]))
  const recordsKey = records
    .map(
      (record) =>
        `${record.id}:${dateOf.get(record.shootDayId) ?? ''}:${record.elementId}:${record.takeNo}:${record.currentState}:${record.photoNote}`
    )
    .sort()
    .join('|')
  const groupsKey = groups
    .map((group) => `${group.id}=[${[...group.elementIds].sort().join(',')}]`)
    .sort()
    .join('|')
  return { recordsKey, groupsKey }
}

let timer: ReturnType<typeof setTimeout> | null = null
let lastSignature: TimelineSignature | null = null
let running = false

async function runReconcile(): Promise<void> {
  if (running) return
  running = true
  try {
    await reconcileManagedConflicts()
  } catch (error) {
    // 调度器在后台静默失败，不打断用户操作；下次变化会再次尝试
    console.error('托管差异重算失败', error)
  } finally {
    running = false
  }
}

function schedule(): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    void (async () => {
      const signature = await readSignature().catch(() => null)
      if (!signature) return
      if (
        lastSignature &&
        signature.recordsKey === lastSignature.recordsKey &&
        signature.groupsKey === lastSignature.groupsKey
      ) {
        return
      }
      const previous = lastSignature
      lastSignature = signature
      // 首次同步只建立基线，不重算（打开应用时保留库内既有结果）
      if (!previous) return
      await runReconcile()
    })()
  }, 350)
}

/** 启动全局观察（应用初始化后调用一次即可） */
export function startAutoReconcile(): void {
  void readSignature().then((signature) => {
    lastSignature = signature
  })
  liveQuery(() => readSignature()).subscribe({
    next: () => schedule(),
    error: (error: unknown) => console.error('托管差异观察失败', error)
  })
}
