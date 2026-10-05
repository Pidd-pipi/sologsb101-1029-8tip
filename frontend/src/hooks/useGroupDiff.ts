/**
 * 接戏组差异：把组内各成员的现场记录按拍摄日、镜次排成时间轴，做跨场次接续比对。
 * 组内只认一份基准；现场记录变化后，成员记录指纹（id + updatedAt）随之改变，
 * 与组上缓存的 diffFingerprint 不一致即判定差异已失效，触发立即重算。
 */
import { computed, type ComputedRef, type Ref } from 'vue'
import type { ConflictSeverity } from '@/types/conflict'
import type { ElementCategory } from '@/types/element'
import type { ShootDayRow, ElementRow, RecordRow, GroupRow } from '@/utils/db'
import { describeDiffs, diffRecords, severityOf, sortBySeverity, type FieldDiff } from '@/utils/diff'

/** 一条组内差异候选：时间轴上相邻两次记录（跨场次）的比对结果 */
export interface GroupDiffCandidate {
  groupId: string
  /** 较晚记录所属要素 */
  elementId: string
  elementName: string
  category: ElementCategory
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

export interface GroupDiffResult {
  /** 组内全部差异候选（按严重程度倒序） */
  candidates: ComputedRef<GroupDiffCandidate[]>
  /** 差异条目数 */
  diffCount: ComputedRef<number>
  /** 当前成员记录指纹（用于失效判断） */
  fingerprint: ComputedRef<string>
  /** 组的差异是否已失效（缓存指纹与当前指纹不一致） */
  isStale: (group: GroupRow) => boolean
}

/** 记录时间轴：先按拍摄日日期，再按镜次排序 */
function buildTimeline(records: RecordRow[], shootDays: ShootDayRow[]): RecordRow[] {
  const dateOf = (record: RecordRow): string =>
    shootDays.find((day) => day.id === record.shootDayId)?.date ?? ''
  return [...records].sort(
    (a, b) => dateOf(a).localeCompare(dateOf(b)) || a.takeNo.localeCompare(b.takeNo, 'zh-Hans-CN')
  )
}

/** 组内成员记录指纹：基于成员记录的 id + updatedAt，任一记录变化指纹即变 */
export function groupFingerprint(elementIds: string[], records: RecordRow[]): string {
  return records
    .filter((record) => elementIds.includes(record.elementId))
    .map((record) => `${record.id}:${record.updatedAt}`)
    .sort()
    .join('|')
}

/**
 * @param group      当前接戏组
 * @param records    全部现场记录
 * @param elements   全部连戏要素
 * @param shootDays  全部拍摄日（用于把记录排到时间轴上）
 */
export function useGroupDiff(
  group: Ref<GroupRow | null>,
  records: Ref<RecordRow[]>,
  elements: Ref<ElementRow[]>,
  shootDays: Ref<ShootDayRow[]>
): GroupDiffResult {
  const fingerprint = computed(() => {
    if (!group.value) return ''
    return groupFingerprint(group.value.elementIds, records.value)
  })

  const candidates = computed<GroupDiffCandidate[]>(() => {
    if (!group.value) return []
    const result: GroupDiffCandidate[] = []
    const memberElementIds = group.value.elementIds
    const memberRecords = records.value.filter((record) => memberElementIds.includes(record.elementId))
    const timeline = buildTimeline(memberRecords, shootDays.value)

    // 相邻记录比对：跨场次接续（同一件道具在不同场次的状态变化）
    for (let i = 1; i < timeline.length; i += 1) {
      const a = timeline[i - 1]
      const b = timeline[i]
      const element = elements.value.find((item) => item.id === b.elementId)
      if (!element) continue
      const diffs = diffRecords(a, b)
      const severity = severityOf(diffs, element.critical)
      if (!severity) continue
      result.push({
        groupId: group.value.id,
        elementId: b.elementId,
        elementName: element.name,
        category: element.category,
        critical: element.critical,
        sceneId: element.sceneId,
        a,
        b,
        diffs,
        severity,
        desc: describeDiffs(diffs)
      })
    }

    // 首条记录与组基准比对：第一场就偏离基准则提示
    if (timeline.length > 0 && group.value.baselineState) {
      const first = timeline[0]
      const element = elements.value.find((item) => item.id === first.elementId)
      if (element) {
        const baselineRecord: RecordRow = {
          id: '__baseline__',
          shootDayId: '',
          elementId: element.id,
          sceneId: element.sceneId,
          takeNo: '基准',
          currentState: group.value.baselineState,
          photoNote: '',
          recordedBy: '',
          revision: 0,
          createdAt: 0,
          updatedAt: 0
        }
        const diffs = diffRecords(baselineRecord, first)
        const severity = severityOf(diffs, element.critical)
        if (severity) {
          result.push({
            groupId: group.value.id,
            elementId: first.elementId,
            elementName: element.name,
            category: element.category,
            critical: element.critical,
            sceneId: element.sceneId,
            a: baselineRecord,
            b: first,
            diffs,
            severity,
            desc: describeDiffs(diffs)
          })
        }
      }
    }

    return sortBySeverity(result)
  })

  const isStale = (g: GroupRow): boolean => g.diffFingerprint !== fingerprint.value

  return {
    candidates,
    diffCount: computed(() => candidates.value.length),
    fingerprint,
    isStale
  }
}
