/**
 * 连戏核对报告 JSON 序列化与校验
 * 报告按「接戏组」汇总：组内只认一份基准，列出挂接场次、现场状态偏离与差异。
 * 报告页用于导出整份核对报告，也是「导入导出备份」的数据校验入口。
 */
import type { Scene } from '../types/scene'
import type { Element } from '../types/element'
import type { ShootDay } from '../types/shootDay'
import type { Record as ContinuityRecord } from '../types/record'
import type { Conflict } from '../types/conflict'
import type { ContinuityGroup } from '../types/continuityGroup'
import type { ElementDraft, DraftConflict } from '../types/elementDraft'
import { SEVERITY_WEIGHT, normalizeStateText } from './diff'
import {
  DB_NAME,
  DB_SCHEMA_VERSION,
  listConflicts,
  listElements,
  listRecords,
  listScenes,
  listShootDays,
  listContinuityGroups,
  listElementDrafts,
  listDraftConflicts
} from './db'
import { buildTimeline } from '../hooks/useContinuityDiff'
import { nowIso } from './uuid'

/** 单个场次的核对小结（报告仍保留场次视角） */
export interface SceneReportRow {
  sceneId: string
  sceneNo: string
  place: string
  timeOfDay: string
  location: string
  state: string
  elementCount: number
  criticalElementCount: number
  openConflictCount: number
  resolvedConflictCount: number
  shootDayCount: number
}

/** 按接戏组汇总的报告行 */
export interface GroupReportRow {
  groupId: string
  groupName: string
  category: string
  owner: string
  critical: boolean
  auto: boolean
  version: number
  baselineState: string
  /** 挂接场次数 */
  sceneCount: number
  /** 挂接要素数 */
  elementCount: number
  /** 组内现场记录条数 */
  recordCount: number
  openConflictCount: number
  resolvedConflictCount: number
  blockingConflictCount: number
  /** 最新现场状态偏离组基准的要素数 */
  baselineDriftCount: number
  /** 挂接场次（场号 + 地点） */
  scenes: Array<{ sceneId: string; sceneNo: string; location: string }>
}

/** 连戏核对报告 */
export interface ContinuityReport {
  name: string
  schemaVersion: number
  exportedAt: string
  scenes: Scene[]
  elements: Element[]
  shootDays: ShootDay[]
  records: ContinuityRecord[]
  conflicts: Conflict[]
  continuityGroups: ContinuityGroup[]
  elementDrafts: ElementDraft[]
  draftConflicts: DraftConflict[]
  summary: {
    sceneCount: number
    elementCount: number
    groupCount: number
    crossSceneGroupCount: number
    recordCount: number
    openConflictCount: number
    blockedConflictCount: number
    resolvedConflictCount: number
    pendingDraftConflictCount: number
    /** 未解决冲突最多的场次 */
    riskiestSceneNo: string
    rows: SceneReportRow[]
    groupRows: GroupReportRow[]
  }
}

type WithRevision = { revision?: number; createdAt?: number; updatedAt?: number }

function stripRevision<T extends WithRevision>(row: T): T {
  const copy = { ...row } as Record<string, unknown>
  delete copy.revision
  delete copy.createdAt
  delete copy.updatedAt
  return copy as T
}

/** 汇总整份连戏核对报告（按接戏组汇总，场次视角并行保留） */
export async function buildReport(): Promise<ContinuityReport> {
  const [scenes, elements, shootDays, records, conflicts, groups, drafts, draftConflicts] = await Promise.all([
    listScenes(),
    listElements(),
    listShootDays(),
    listRecords(),
    listConflicts(),
    listContinuityGroups(),
    listElementDrafts(),
    listDraftConflicts()
  ])

  const sceneById = new Map(scenes.map((scene) => [scene.id, scene]))
  const elementById = new Map(elements.map((element) => [element.id, element]))

  const rows: SceneReportRow[] = scenes.map((scene) => {
    const sceneElements = elements.filter((item) => item.sceneId === scene.id)
    const elementIds = new Set(sceneElements.map((item) => item.id))
    const sceneConflicts = conflicts.filter((item) => elementIds.has(item.elementId))
    return {
      sceneId: scene.id,
      sceneNo: scene.sceneNo,
      place: scene.place,
      timeOfDay: scene.timeOfDay,
      location: scene.location,
      state: scene.state,
      elementCount: sceneElements.length,
      criticalElementCount: sceneElements.filter((item) => item.critical).length,
      openConflictCount: sceneConflicts.filter((item) => item.state === '待确认').length,
      resolvedConflictCount: sceneConflicts.filter((item) => item.state === '已解决').length,
      shootDayCount: shootDays.filter((day) => day.sceneIds.includes(scene.id)).length
    }
  })

  const groupRows: GroupReportRow[] = groups.map((group) => {
    const memberIds = new Set(group.elementIds)
    const members = group.elementIds
      .map((id) => elementById.get(id))
      .filter((item): item is (typeof elements)[number] => item !== undefined)
    const memberSceneIds = [...new Set(members.map((item) => item.sceneId))]
    const groupRecords = records.filter((record) => memberIds.has(record.elementId))
    const groupConflicts = conflicts.filter((item) => item.groupId === group.id)
    const expected = normalizeStateText(group.baselineState)
    // 每个成员取时间轴上最新一条，判断是否偏离组内唯一基准
    const baselineDriftCount = members.reduce((sum, member) => {
      const latest = buildTimeline(
        records.filter((record) => record.elementId === member.id),
        shootDays
      ).pop()
      if (latest && latest.currentState.trim() && normalizeStateText(latest.currentState) !== expected) return sum + 1
      return sum
    }, 0)

    return {
      groupId: group.id,
      groupName: group.name,
      category: group.category,
      owner: group.owner,
      critical: group.critical,
      auto: group.auto,
      version: group.version,
      baselineState: group.baselineState,
      sceneCount: memberSceneIds.length,
      elementCount: members.length,
      recordCount: groupRecords.length,
      openConflictCount: groupConflicts.filter((item) => item.state === '待确认').length,
      resolvedConflictCount: groupConflicts.filter((item) => item.state === '已解决').length,
      blockingConflictCount: groupConflicts.filter((item) => item.state === '待确认' && item.severity === '阻断').length,
      baselineDriftCount,
      scenes: memberSceneIds.map((sceneId) => {
        const scene = sceneById.get(sceneId)
        return { sceneId, sceneNo: scene?.sceneNo ?? '已删除', location: scene?.location ?? '—' }
      })
    }
  })

  const riskiest = [...rows].sort(
    (a, b) => b.openConflictCount - a.openConflictCount || b.criticalElementCount - a.criticalElementCount
  )[0]

  const openConflicts = conflicts.filter((item) => item.state === '待确认')

  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    scenes: scenes.map(stripRevision),
    elements: elements.map(stripRevision),
    shootDays: shootDays.map(stripRevision),
    records: records.map(stripRevision),
    conflicts: conflicts.map(stripRevision),
    continuityGroups: groups.map(stripRevision),
    elementDrafts: drafts.map(stripRevision),
    draftConflicts: draftConflicts.map(stripRevision),
    summary: {
      sceneCount: scenes.length,
      elementCount: elements.length,
      groupCount: groups.length,
      crossSceneGroupCount: groupRows.filter((row) => row.sceneCount > 1).length,
      recordCount: records.length,
      openConflictCount: openConflicts.length,
      blockedConflictCount: openConflicts.filter((item) => item.severity === '阻断').length,
      resolvedConflictCount: conflicts.filter((item) => item.state === '已解决').length,
      pendingDraftConflictCount: draftConflicts.filter((item) => item.state === '待处理').length,
      riskiestSceneNo: riskiest ? riskiest.sceneNo : '—',
      rows,
      groupRows
    }
  }
}

/** 严重程度加权后的风险分：用于报告页排序 */
export function riskScore(conflicts: Conflict[]): number {
  return conflicts.reduce((sum, item) => sum + SEVERITY_WEIGHT[item.severity], 0)
}

export function serializeReport(report: ContinuityReport): string {
  return JSON.stringify(report, null, 2)
}

/** 校验并解析报告 / 备份 JSON，失败时抛出可读错误 */
export function parseReport(text: string): ContinuityReport {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('不是合法的 JSON 文本')
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('报告根节点必须是对象')
  }
  const candidate = parsed as Partial<ContinuityReport>
  if (typeof candidate.name !== 'string') throw new Error('缺少 name 字段')
  if (typeof candidate.schemaVersion !== 'number') throw new Error('缺少 schemaVersion 字段')
  if (!Array.isArray(candidate.scenes)) throw new Error('scenes 必须是数组')
  if (!Array.isArray(candidate.conflicts)) throw new Error('conflicts 必须是数组')
  return candidate as ContinuityReport
}

/** 触发浏览器下载（纯前端，无需后端） */
export function downloadJson(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}
