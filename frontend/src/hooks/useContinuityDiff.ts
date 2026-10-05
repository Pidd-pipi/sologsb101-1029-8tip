/**
 * 接戏组级连戏比对：
 * 把一个接戏组内全部成员（可跨场次）的现场记录排到同一条时间轴上
 * （先按拍摄日日期、再按镜次），逐条排出相邻记录之间的字段级差异。
 * 现场记录一旦变化，托管差异立即失效并由 reconcileManagedConflicts 重算。
 * 被差异比对页、现场记录页、接戏组页与报告页共同消费。
 */
import { computed, type ComputedRef, type Ref } from 'vue'
import type { ConflictSeverity } from '@/types/conflict'
import type { ElementCategory } from '@/types/element'
import type { ContinuityGroupRow, ShootDayRow, ElementRow, RecordRow } from '@/utils/db'
import { describeDiffs, diffRecords, severityOf, sortBySeverity, normalizeStateText, type FieldDiff } from '@/utils/diff'

/** 一条候选差异：接戏组时间轴上相邻两次记录之间的比对结果 */
export interface DiffCandidate {
  /** 所属接戏组 */
  groupId: string
  /** 接戏组名称 */
  groupName: string
  /** 差异归属要素（取较晚记录所属要素） */
  elementId: string
  elementName: string
  category: ElementCategory
  owner: string
  critical: boolean
  sceneId: string
  /** 较早的一次记录 */
  a: RecordRow
  /** 较晚的一次记录 */
  b: RecordRow
  diffs: FieldDiff[]
  severity: ConflictSeverity
  desc: string
}

/** 成员最新记录与组基准不一致（组内只认一份基准） */
export interface BaselineDrift {
  groupId: string
  groupName: string
  elementId: string
  elementName: string
  sceneId: string
  recordId: string
  expected: string
  actual: string
  critical: boolean
}

export interface ContinuityDiffResult {
  /** 全部存在差异的候选条目（按严重程度倒序） */
  candidates: ComputedRef<DiffCandidate[]>
  /** 指定接戏组的差异候选 */
  candidatesByGroup: (groupId: string) => DiffCandidate[]
  /** 差异条目数 */
  diffCount: ComputedRef<number>
  /** 阻断级差异数 */
  blockingCount: ComputedRef<number>
  /** 指定要素是否存在差异 */
  hasDiff: (elementId: string) => boolean
  /** 指定场次的差异条数 */
  countByScene: (sceneId: string) => number
  /** 各成员最新现场状态偏离组基准的清单 */
  baselineDrifts: ComputedRef<BaselineDrift[]>
}

/** 记录时间轴：先按拍摄日日期，再按镜次排序 */
export function buildTimeline(records: RecordRow[], shootDays: ShootDayRow[]): RecordRow[] {
  const dateOf = (record: RecordRow): string =>
    shootDays.find((day) => day.id === record.shootDayId)?.date ?? ''
  return [...records].sort(
    (a, b) =>
      dateOf(a).localeCompare(dateOf(b)) ||
      a.takeNo.localeCompare(b.takeNo, 'zh-Hans-CN')
  )
}

/**
 * @param records    全部现场记录
 * @param elements   全部连戏要素
 * @param shootDays  全部拍摄日（用于把记录排到时间轴上）
 * @param groups     全部接戏组（比对以组为单位，组内只认一份基准）
 */
export function useContinuityDiff(
  records: Ref<RecordRow[]>,
  elements: Ref<ElementRow[]>,
  shootDays: Ref<ShootDayRow[]>,
  groups: Ref<ContinuityGroupRow[]>
): ContinuityDiffResult {
  const elementById = computed(() => new Map(elements.value.map((element) => [element.id, element])))

  /** 每个接戏组的时间轴相邻差异候选 */
  const candidates = computed<DiffCandidate[]>(() => {
    const result: DiffCandidate[] = []
    groups.value.forEach((group) => {
      const memberIds = new Set(group.elementIds)
      const own = buildTimeline(
        records.value.filter((record) => memberIds.has(record.elementId)),
        shootDays.value
      )
      for (let i = 1; i < own.length; i += 1) {
        const a = own[i - 1]
        const b = own[i]
        const diffs = diffRecords(a, b)
        const severity = severityOf(diffs, group.critical)
        if (!severity) continue
        const laterElement = elementById.value.get(b.elementId)
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
    return sortBySeverity(result)
  })

  /** 成员要素最新一条记录的实际状态与组基准归一化后仍不一致 */
  const baselineDrifts = computed<BaselineDrift[]>(() => {
    const drifts: BaselineDrift[] = []
    groups.value.forEach((group) => {
      const expected = normalizeStateText(group.baselineState)
      group.elementIds.forEach((elementId) => {
        const element = elementById.value.get(elementId)
        const own = buildTimeline(
          records.value.filter((record) => record.elementId === elementId),
          shootDays.value
        )
        const latest = own[own.length - 1]
        if (!element || !latest || !latest.currentState.trim()) return
        if (normalizeStateText(latest.currentState) !== expected) {
          drifts.push({
            groupId: group.id,
            groupName: group.name,
            elementId,
            elementName: element.name,
            sceneId: element.sceneId,
            recordId: latest.id,
            expected: group.baselineState,
            actual: latest.currentState,
            critical: group.critical
          })
        }
      })
    })
    return drifts
  })

  return {
    candidates,
    candidatesByGroup: (groupId: string) => candidates.value.filter((item) => item.groupId === groupId),
    diffCount: computed(() => candidates.value.length),
    blockingCount: computed(() => candidates.value.filter((item) => item.severity === '阻断').length),
    hasDiff: (elementId: string) => candidates.value.some((item) => item.elementId === elementId || item.a.elementId === elementId),
    countByScene: (sceneId: string) => candidates.value.filter((item) => item.sceneId === sceneId || item.a.sceneId === sceneId).length,
    baselineDrifts
  }
}
