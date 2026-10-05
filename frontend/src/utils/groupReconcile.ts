/**
 * 接戏组托管差异的失效重算：
 * 现场记录 / 接戏组挂接发生变化后，组内按拍摄日、镜次排出的差异立即失效，
 * 依据最新时间轴重建 managed=true 的差异条目。非托管（手工）差异不动。
 */
import type { ConflictRow, ContinuityGroupRow, ElementRow, RecordRow, ShootDayRow } from './db'
import { db, ROW_REVISION } from './db'
import { buildTimeline, type DiffCandidate } from '../hooks/useContinuityDiff'
import { diffRecords, severityOf, describeDiffs } from './diff'

/** 直接由表数据计算全部接戏组的托管差异候选（与 useContinuityDiff 口径一致） */
export function computeManagedCandidates(
  records: RecordRow[],
  elements: ElementRow[],
  shootDays: ShootDayRow[],
  groups: ContinuityGroupRow[]
): DiffCandidate[] {
  const elementById = new Map(elements.map((element) => [element.id, element]))
  const result: DiffCandidate[] = []
  groups.forEach((group) => {
    const memberIds = new Set(group.elementIds)
    const own = buildTimeline(
      records.filter((record) => memberIds.has(record.elementId)),
      shootDays
    )
    for (let i = 1; i < own.length; i += 1) {
      const a = own[i - 1]
      const b = own[i]
      const diffs = diffRecords(a, b)
      const severity = severityOf(diffs, group.critical)
      if (!severity) continue
      const laterElement = elementById.get(b.elementId)
      result.push({
        groupId: group.id,
        groupName: group.name,
        elementId: b.elementId,
        elementName: laterElement?.name ?? group.name,
        category: group.category,
        owner: group.owner,
        critical: group.critical,
        sceneId: b.sceneId,
        a,
        b,
        diffs,
        severity,
        desc: describeDiffs(diffs)
      })
    }
  })
  return result
}

/**
 * 失效重算：
 * 1) 清除全部 managed 差异（记录变化后旧差异立即失效）；
 * 2) 按最新接戏组时间轴重建差异条目（同一对记录幂等）。
 * 返回新建条目数。
 */
export async function reconcileManagedConflicts(): Promise<number> {
  const [records, elements, shootDays, groups] = await Promise.all([
    db.records.toArray(),
    db.elements.toArray(),
    db.shootDays.toArray(),
    db.continuityGroups.toArray()
  ])
  const candidates = computeManagedCandidates(records, elements, shootDays, groups)
  const now = Date.now()
  return db.transaction('rw', [db.conflicts], async () => {
    // 失效前留档：同一对记录若仍是差异，保留既有解决状态 / 留痕；记录变化导致描述不同则回到待确认
    const previous = await db.conflicts.filter((item) => item.managed).toArray()
    const priorByKey = new Map(previous.map((item) => [`${item.groupId}|${item.recordIdA}|${item.recordIdB}`, item]))

    // 现场记录变化后旧的托管差异立即失效（非托管手工差异保留）
    await db.conflicts.filter((item) => item.managed).delete()

    const nonManaged = await db.conflicts.toArray()
    const pairKeys = new Set(nonManaged.map((item) => `${item.groupId}|${item.recordIdA}|${item.recordIdB}`))
    const rows: ConflictRow[] = []
    let createdCount = 0
    for (const candidate of candidates) {
      const key = `${candidate.groupId}|${candidate.a.id}|${candidate.b.id}`
      if (pairKeys.has(key)) continue
      pairKeys.add(key)
      const prior = priorByKey.get(key)
      const unchanged = prior !== undefined && prior.diffDesc === candidate.desc && prior.severity === candidate.severity
      rows.push({
        id:
          unchanged && prior
            ? prior.id
            : `cfm-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        elementId: candidate.elementId,
        groupId: candidate.groupId,
        managed: true,
        recordIdA: candidate.a.id,
        recordIdB: candidate.b.id,
        diffDesc: candidate.desc,
        severity: candidate.severity,
        state: unchanged && prior ? prior.state : '待确认',
        resolvedNote: unchanged && prior ? prior.resolvedNote : '',
        resolvedAt: unchanged && prior ? prior.resolvedAt : '',
        revision: ROW_REVISION,
        createdAt: unchanged && prior ? prior.createdAt : now,
        updatedAt: now
      })
      if (!prior) createdCount += 1
    }
    if (rows.length > 0) await db.conflicts.bulkPut(rows)
    return createdCount
  })
}
