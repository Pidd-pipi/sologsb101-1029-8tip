/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名 gbcontinuity-db，结构版本 version(2)：
 *   v1 场次/要素/拍摄日/现场记录/差异；v2 新增接戏组、挂接草稿、挂接冲突
 * - 接戏组（continuityGroups）：组内只认一份基准，要素按场次挂接 / 移出
 * - 旧数据升级：每个单场要素自动补成一个独立接戏组（auto=true）
 * - 现场记录变化后，所属接戏组的托管差异立即失效，由差异页按拍摄日 + 镜次重算
 * - 首次打开自动播种演示数据（含跨场次接戏组与挂接冲突），保证每个页面有内容
 */
import Dexie, { type Table } from 'dexie'
import { toRaw } from 'vue'
import type { Scene } from '../types/scene'
import type { Element } from '../types/element'
import type { ShootDay } from '../types/shootDay'
import type { Record as ContinuityRecord } from '../types/record'
import type { Conflict } from '../types/conflict'
import type { ContinuityGroup } from '../types/continuityGroup'
import type { DraftConflict, ElementDraft } from '../types/elementDraft'
import { GROUP_MAX_SCENES } from '../types/continuityGroup'
import { nowIso } from './uuid'
import { seedDatabase } from './seed'

/** 数据库名 */
export const DB_NAME = 'gbcontinuity-db'

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 2

/** 行结构修订号 */
export const ROW_REVISION = 2

/** 带时间戳与修订号的持久化实体 */
export interface Revisioned {
  revision: number
  createdAt: number
  updatedAt: number
}

export type SceneRow = Scene & Revisioned
export type ElementRow = Element & Revisioned
export type ShootDayRow = ShootDay & Revisioned
export type RecordRow = ContinuityRecord & Revisioned
export type ConflictRow = Conflict & Revisioned
export type ContinuityGroupRow = ContinuityGroup & Revisioned
export type ElementDraftRow = ElementDraft & Revisioned
export type DraftConflictRow = DraftConflict & Revisioned

/**
 * 深度剥掉 Vue 响应式代理（Proxy），得到可被 IndexedDB 结构化克隆的普通对象。
 * 页面里 `v-model` 绑定的数组字段（如 `ContinuityGroup.elementIds`）是 Vue 的 Proxy 数组，
 * 直接交给 Dexie 会抛 `DataCloneError: [object Object] could not be cloned`。所有写库入口都必须先过这一层。
 */
export function toPlainRow<T>(value: T): T {
  const raw = toRaw(value) as unknown
  if (Array.isArray(raw)) return raw.map((item) => toPlainRow(item)) as unknown as T
  if (raw !== null && typeof raw === 'object') {
    const proto = Object.getPrototypeOf(raw)
    // 只深拷贝普通对象/数组，Date、Map 等结构化克隆本身支持的对象原样返回
    if (proto === Object.prototype || proto === null) {
      const plain: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(raw)) plain[key] = toPlainRow(item)
      return plain as T
    }
  }
  return raw as T
}

/** 同名要素归一键：去空白并统一小写（同场次同名要素只能属于一个接戏组） */
export function normalizeElementName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '')
}

class GbContinuityDatabase extends Dexie {
  scenes!: Table<SceneRow, string>
  elements!: Table<ElementRow, string>
  shootDays!: Table<ShootDayRow, string>
  records!: Table<RecordRow, string>
  conflicts!: Table<ConflictRow, string>
  continuityGroups!: Table<ContinuityGroupRow, string>
  elementDrafts!: Table<ElementDraftRow, string>
  draftConflicts!: Table<DraftConflictRow, string>

  constructor() {
    super(DB_NAME)

    // v1：历史结构，保留以便老库平滑升级
    this.version(1).stores({
      scenes: 'id, sceneNo, place, timeOfDay, shootOrder, state, updatedAt',
      elements: 'id, sceneId, category, name, owner, critical, updatedAt',
      shootDays: 'id, date, director, scripty, updatedAt',
      records: 'id, shootDayId, elementId, sceneId, takeNo, updatedAt',
      conflicts: 'id, elementId, recordIdA, recordIdB, severity, state, updatedAt'
    })

    // v2：接戏组 + 挂接草稿 / 冲突；差异补 groupId / managed 索引
    this.version(2)
      .stores({
        scenes: 'id, sceneNo, place, timeOfDay, shootOrder, state, updatedAt',
        elements: 'id, sceneId, category, name, owner, critical, updatedAt',
        shootDays: 'id, date, director, scripty, updatedAt',
        records: 'id, shootDayId, elementId, sceneId, takeNo, updatedAt',
        conflicts: 'id, elementId, groupId, managed, recordIdA, recordIdB, severity, state, updatedAt',
        continuityGroups: 'id, name, category, owner, critical, auto, version, updatedAt',
        elementDrafts: 'id, groupId, elementId, kind, baseVersion, updatedAt',
        draftConflicts: 'id, draftId, groupId, elementId, kind, state, latestVersion, updatedAt'
      })
      .upgrade(async (tx) => {
        // 1) 历史行补齐行修订号与时间戳
        const v1Tables = ['scenes', 'elements', 'shootDays', 'records', 'conflicts']
        for (const name of v1Tables) {
          await tx
            .table(name)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              if (typeof row.revision !== 'number') row.revision = 1
              if (typeof row.createdAt !== 'number') row.createdAt = Date.now()
              if (typeof row.updatedAt !== 'number') row.updatedAt = row.createdAt
            })
        }
        // 2) 旧差异补接戏组字段
        await tx
          .table('conflicts')
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (typeof row.groupId !== 'string') row.groupId = ''
            if (typeof row.managed !== 'boolean') row.managed = false
          })
        // 3) 旧数据升级：每个单场要素补成独立接戏组，并回填差异 groupId
        await ensureAutoGroups()
      })
  }
}

export const db = new GbContinuityDatabase()

/**
 * 为没有任何接戏组的要素补建独立接戏组（auto=true），
 * 并把要素上的历史差异回填到对应组。升级迁移与旧备份导入共用。
 * 必须运行在一个可写事务中（内部只做读改写）。
 */
export async function ensureAutoGroups(): Promise<Map<string, string>> {
  const mapping = new Map<string, string>()
  const [elements, groups] = await Promise.all([db.elements.toArray(), db.continuityGroups.toArray()])
  const groupedElementIds = new Set(groups.flatMap((group) => group.elementIds))
  const now = Date.now()
  const pendingGroups: ContinuityGroupRow[] = []

  for (const element of elements) {
    if (groupedElementIds.has(element.id)) continue
    const groupId = createGroupId()
    mapping.set(element.id, groupId)
    groupedElementIds.add(element.id)
    pendingGroups.push({
      id: groupId,
      name: element.name,
      category: element.category,
      baselineState: element.initialState,
      owner: element.owner,
      critical: element.critical,
      elementIds: [element.id],
      version: 1,
      auto: true,
      revision: ROW_REVISION,
      createdAt: now,
      updatedAt: now
    })
  }
  if (pendingGroups.length > 0) await db.continuityGroups.bulkPut(toPlainRow(pendingGroups))

  if (mapping.size > 0) {
    await db.conflicts.toCollection().modify((conflict) => {
      const groupId = mapping.get(conflict.elementId)
      if (groupId && !conflict.groupId) {
        conflict.groupId = groupId
        conflict.managed = true
        conflict.updatedAt = now
      }
    })
  }
  return mapping
}

/** 打开数据库：首次使用时灌入演示数据（幂等：表非空不播） */
export async function initDatabase(): Promise<void> {
  await db.open()
  if ((await db.scenes.count()) === 0) {
    await seedDatabase()
  } else if ((await db.continuityGroups.count()) === 0) {
    // 兜底：有要素却没有接戏组（异常库 / 旧备份）时补齐独立组
    await db.transaction('rw', [db.elements, db.continuityGroups, db.conflicts], ensureAutoGroups)
  }
}

/* ------------------------------ 场次 ------------------------------ */

export async function listScenes(): Promise<SceneRow[]> {
  const rows = await db.scenes.toArray()
  return rows.sort((a, b) => a.shootOrder - b.shootOrder)
}

export async function putScene(row: SceneRow): Promise<void> {
  await db.scenes.put(toPlainRow(row))
}

export async function updateScene(id: string, patch: Partial<Scene>): Promise<void> {
  await db.scenes.update(id, toPlainRow({ ...patch, updatedAt: Date.now() }) as never)
}

/** 拖拽调序后按新顺序批量写回 shootOrder（从 1 开始自动重编号） */
export async function reorderScenes(orderedIds: string[]): Promise<void> {
  await db.transaction('rw', db.scenes, async () => {
    for (let index = 0; index < orderedIds.length; index += 1) {
      await db.scenes.update(orderedIds[index], { shootOrder: index + 1, updatedAt: Date.now() } as never)
    }
  })
}

/** 下一个可用拍摄顺序号 */
export async function nextShootOrder(): Promise<number> {
  const rows = await db.scenes.toArray()
  return rows.reduce((max, row) => Math.max(max, row.shootOrder), 0) + 1
}

/** 删除场次：级联删除其下要素、现场记录、接戏组挂接与差异 */
export async function removeScene(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.scenes, db.elements, db.shootDays, db.records, db.conflicts, db.continuityGroups, db.elementDrafts, db.draftConflicts],
    async () => {
      const elements = await db.elements.where('sceneId').equals(id).toArray()
      for (const element of elements) {
        await detachAndCleanupElement(element.id)
      }
      await db.shootDays.toCollection().modify((day) => {
        if (day.sceneIds.includes(id)) {
          day.sceneIds = day.sceneIds.filter((sceneId) => sceneId !== id)
          day.updatedAt = Date.now()
        }
      })
      await db.scenes.delete(id)
    }
  )
}

/* ---------------------------- 连戏要素 ---------------------------- */

export async function listElements(): Promise<ElementRow[]> {
  const rows = await db.elements.toArray()
  return rows.sort((a, b) => a.category.localeCompare(b.category, 'zh-Hans-CN') || a.name.localeCompare(b.name, 'zh-Hans-CN'))
}

export async function putElement(row: ElementRow): Promise<void> {
  await db.elements.put(toPlainRow(row))
}

export async function updateElement(id: string, patch: Partial<Element>): Promise<void> {
  await db.elements.update(id, toPlainRow({ ...patch, updatedAt: Date.now() }) as never)
}

/**
 * 删除要素：从接戏组移出（独立自动组随之清空删除）、
 * 级联删除现场记录、差异与挂接草稿 / 冲突。
 */
export async function removeElement(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.elements, db.records, db.conflicts, db.continuityGroups, db.elementDrafts, db.draftConflicts],
    async () => {
      await detachAndCleanupElement(id)
      await db.elements.delete(id)
    }
  )
}

/* ------------------------------ 拍摄日 ------------------------------ */

export async function listShootDays(): Promise<ShootDayRow[]> {
  const rows = await db.shootDays.toArray()
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

export async function putShootDay(row: ShootDayRow): Promise<void> {
  await db.shootDays.put(toPlainRow(row))
}

export async function updateShootDay(id: string, patch: Partial<ShootDay>): Promise<void> {
  await db.shootDays.update(id, toPlainRow({ ...patch, updatedAt: Date.now() }) as never)
}

/** 删除拍摄日：当日记录与相关差异一并清除，并失效相关接戏组托管差异 */
export async function removeShootDay(id: string): Promise<void> {
  await db.transaction('rw', [db.shootDays, db.records, db.conflicts, db.continuityGroups], async () => {
    const records = await db.records.where('shootDayId').equals(id).toArray()
    const recordIds = records.map((item) => item.id)
    const elementIds = [...new Set(records.map((item) => item.elementId))]
    const groupIds = await groupIdsOfElements(elementIds)
    if (recordIds.length > 0) {
      await db.conflicts.filter((item) => recordIds.includes(item.recordIdA) || recordIds.includes(item.recordIdB)).delete()
    }
    // 组内其余要素的托管差异也立即失效（时间轴被删动，需整体重算）
    if (groupIds.size > 0) {
      await db.conflicts.filter((item) => item.managed && groupIds.has(item.groupId)).delete()
    }
    await db.records.where('shootDayId').equals(id).delete()
    await db.shootDays.delete(id)
  })
}

/* ---------------------------- 现场记录 ---------------------------- */

export async function listRecords(): Promise<RecordRow[]> {
  const rows = await db.records.toArray()
  return rows.sort((a, b) => a.takeNo.localeCompare(b.takeNo, 'zh-Hans-CN'))
}

/** 写入 / 更新现场记录后，所属接戏组的托管差异立即失效（等待按拍摄日、镜次重算） */
async function invalidateGroupManaged(elementId: string): Promise<void> {
  const groups = await db.continuityGroups.filter((group) => group.elementIds.includes(elementId)).toArray()
  if (groups.length === 0) return
  const groupIds = new Set(groups.map((group) => group.id))
  await db.conflicts.filter((item) => item.managed && groupIds.has(item.groupId)).delete()
}

export async function putRecord(row: RecordRow): Promise<void> {
  await db.transaction('rw', [db.records, db.continuityGroups, db.conflicts], async () => {
    await db.records.put(toPlainRow(row))
    await invalidateGroupManaged(row.elementId)
  })
}

export async function updateRecord(id: string, patch: Partial<ContinuityRecord>): Promise<void> {
  await db.transaction('rw', [db.records, db.continuityGroups, db.conflicts], async () => {
    const previous = await db.records.get(id)
    await db.records.update(id, toPlainRow({ ...patch, updatedAt: Date.now() }) as never)
    const affected = new Set<string>()
    if (previous) affected.add(previous.elementId)
    if (typeof patch.elementId === 'string') affected.add(patch.elementId)
    for (const elementId of affected) {
      const groups = await db.continuityGroups.filter((group) => group.elementIds.includes(elementId)).toArray()
      if (groups.length === 0) continue
      const groupIds = new Set(groups.map((group) => group.id))
      await db.conflicts.filter((item) => item.managed && groupIds.has(item.groupId)).delete()
    }
  })
}

export async function removeRecord(id: string): Promise<void> {
  await db.transaction('rw', [db.records, db.conflicts, db.continuityGroups], async () => {
    const record = await db.records.get(id)
    await db.conflicts.filter((item) => item.recordIdA === id || item.recordIdB === id).delete()
    if (record) {
      const groups = await db.continuityGroups.filter((group) => group.elementIds.includes(record.elementId)).toArray()
      if (groups.length > 0) {
        const groupIds = new Set(groups.map((group) => group.id))
        await db.conflicts.filter((item) => item.managed && groupIds.has(item.groupId)).delete()
      }
    }
    await db.records.delete(id)
  })
}

/* ---------------------------- 连戏差异 ---------------------------- */

export async function listConflicts(): Promise<ConflictRow[]> {
  return db.conflicts.toArray()
}

export async function putConflict(row: ConflictRow): Promise<void> {
  await db.conflicts.put(toPlainRow(row))
}

/** 批量写入比对生成的差异条目（同组同一对记录上的托管条目不重复生成） */
export async function saveConflicts(rows: ConflictRow[]): Promise<number> {
  let created = 0
  await db.transaction('rw', [db.conflicts], async () => {
    for (const row of rows) {
      const exists = await db.conflicts
        .filter(
          (item) =>
            item.groupId === row.groupId &&
            item.recordIdA === row.recordIdA &&
            item.recordIdB === row.recordIdB
        )
        .first()
      if (!exists) {
        await db.conflicts.put(toPlainRow(row))
        created += 1
      }
    }
  })
  return created
}

/**
 * 解决差异：写入解决留痕并回写连戏基准（以最新现场状态为准）。
 * 托管差异优先回写接戏组基准（版本 +1）；无组时回退到要素初始状态。
 */
export async function resolveConflict(id: string, resolvedNote: string): Promise<void> {
  await db.transaction('rw', [db.conflicts, db.records, db.elements, db.continuityGroups], async () => {
    const conflict = await db.conflicts.get(id)
    if (!conflict) throw new Error('差异条目不存在')
    const latest = await db.records.get(conflict.recordIdB)
    await db.conflicts.update(id, {
      state: '已解决',
      resolvedNote,
      resolvedAt: nowIso(),
      updatedAt: Date.now()
    } as never)
    if (latest) {
      if (conflict.groupId) {
        const group = await db.continuityGroups.get(conflict.groupId)
        if (group) {
          await db.continuityGroups.update(group.id, {
            baselineState: latest.currentState,
            version: group.version + 1,
            updatedAt: Date.now()
          } as never)
        }
      }
      await db.elements.update(conflict.elementId, {
        initialState: latest.currentState,
        updatedAt: Date.now()
      } as never)
    }
  })
}

/** 重新打开差异（误判回退） */
export async function reopenConflict(id: string): Promise<void> {
  await db.conflicts.update(id, { state: '待确认', resolvedNote: '', resolvedAt: '', updatedAt: Date.now() } as never)
}

export async function removeConflict(id: string): Promise<void> {
  await db.conflicts.delete(id)
}

/* ---------------------------- 接戏组 ---------------------------- */

export async function listContinuityGroups(): Promise<ContinuityGroupRow[]> {
  const rows = await db.continuityGroups.toArray()
  return rows.sort((a, b) => a.updatedAt - b.updatedAt)
}

export function createGroupId(): string {
  return `cg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export async function putContinuityGroup(row: ContinuityGroupRow): Promise<void> {
  await db.continuityGroups.put(toPlainRow(row))
}

/** 找到要素当前所属接戏组（同场次同名要素只属于一个组） */
export async function findGroupOfElement(elementId: string): Promise<ContinuityGroupRow | undefined> {
  return db.continuityGroups.filter((group) => group.elementIds.includes(elementId)).first()
}

async function groupIdsOfElements(elementIds: string[]): Promise<Set<string>> {
  if (elementIds.length === 0) return new Set()
  const groups = await db.continuityGroups.filter((group) => group.elementIds.some((id) => elementIds.includes(id))).toArray()
  return new Set(groups.map((group) => group.id))
}

/** 组内去重场次数（容量口径：同一部戏的同场只算一次） */
export async function countGroupScenes(group: ContinuityGroupRow): Promise<number> {
  const members = await db.elements.where('id').anyOf(group.elementIds).toArray()
  return new Set(members.map((element) => element.sceneId)).size
}

/**
 * 挂接 / 移出 / 改基准的统一结果：
 * - accepted 落库；
 * - rejected 版本落后，草稿与冲突已留存，由发起页提示用户。
 */
export type GroupMutationOutcome =
  | { accepted: true; version: number }
  | { accepted: false; draftId: string; conflictId: string; reason: string }

/** 同场次同名要素归属校验 + 容量校验，不通过直接抛错（与版本无关的硬性拒绝） */
async function assertAttachable(group: ContinuityGroupRow, element: ElementRow): Promise<void> {
  // 同一场次里的同名连戏要素只能属于一个接戏组：
  // 若同场已存在另一个同名要素（无论它已在本组还是别的组），当前要素都不能再挂入
  if (!group.elementIds.includes(element.id)) {
    const scenePeers = await db.elements.where('sceneId').equals(element.sceneId).toArray()
    const sameNameKey = normalizeElementName(element.name)
    const namedPeer = scenePeers.find(
      (peer) => peer.id !== element.id && normalizeElementName(peer.name) === sameNameKey
    )
    if (namedPeer) {
      const peerGroup = await findGroupOfElement(namedPeer.id)
      if (peerGroup) {
        throw new Error(
          peerGroup.id === group.id
            ? `同场次已存在同名要素「${element.name}」且已在本组中，同一场的同名要素只能有一个接戏归属`
            : `同场次已存在同名要素「${element.name}」，且属于接戏组「${peerGroup.name}」，不能重复挂接`
        )
      }
    }

    const sceneCount = await countGroupScenes(group)
    if (sceneCount >= GROUP_MAX_SCENES) {
      throw new Error(`接戏组最多挂接 ${GROUP_MAX_SCENES} 个场次，当前已满，拒绝继续挂接`)
    }
  }
}

/** 版本落后：保留草稿并登记挂接冲突，返回拒绝结果 */
async function rejectWithDraft(input: {
  group: ContinuityGroupRow
  elementId: string
  kind: ElementDraft['kind']
  baselineState: string
  baseVersion: number
  originTab: string
  note: string
}): Promise<GroupMutationOutcome> {
  const now = Date.now()
  const draft: ElementDraftRow = {
    id: `dft-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    groupId: input.group.id,
    elementId: input.elementId,
    kind: input.kind,
    baselineState: input.baselineState,
    baseVersion: input.baseVersion,
    originTab: input.originTab,
    note: input.note,
    revision: ROW_REVISION,
    createdAt: now,
    updatedAt: now
  }
  const conflict: DraftConflictRow = {
    id: `dc-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    draftId: draft.id,
    groupId: input.group.id,
    elementId: input.elementId,
    kind: input.kind,
    baseVersion: input.baseVersion,
    latestVersion: input.group.version,
    draftBaseline: input.baselineState,
    currentBaseline: input.group.baselineState,
    state: '待处理',
    createdAt: now,
    resolvedNote: '',
    resolvedAt: '',
    revision: ROW_REVISION,
    updatedAt: now
  }
  await db.elementDrafts.put(toPlainRow(draft))
  await db.draftConflicts.put(toPlainRow(conflict))
  return {
    accepted: false,
    draftId: draft.id,
    conflictId: conflict.id,
    reason: `接戏组已被另一个页签更新到 v${input.group.version}，你的修改基于 v${input.baseVersion}，已保留草稿并列出冲突`
  }
}

export interface AttachOptions {
  /** 发起页签基于的组版本；不等于当前版本即视为并发冲突 */
  baseVersion: number
  /** 发起页签名（如「连戏要素页 / 接戏组弹窗」） */
  originTab: string
  /** 挂接同时更新基准（可选） */
  baselineState?: string
  note?: string
}

/**
 * 把场次里的连戏要素挂接到接戏组：
 * 1) 同场次同名只能同组、容量 ≤ 12（硬性拒绝，抛错）
 * 2) 版本必须最新，落后则保留草稿并登记冲突（不抛错，返回 rejected）
 * 3) 接受后从原组移出、挂入本组，基准 / 版本更新
 */
export async function attachElementToGroup(groupId: string, elementId: string, options: AttachOptions): Promise<GroupMutationOutcome> {
  return db.transaction(
    'rw',
    [db.continuityGroups, db.elements, db.conflicts, db.elementDrafts, db.draftConflicts],
    async () => {
      const group = await db.continuityGroups.get(groupId)
      if (!group) throw new Error('接戏组不存在或已被删除')
      const element = await db.elements.get(elementId)
      if (!element) throw new Error('连戏要素不存在或已被删除')
      await assertAttachable(group, element)

      // 已在组内：同名重复挂接幂等处理，但基准修改仍走版本校验
      if (group.elementIds.includes(element.id) && options.baselineState === undefined) {
        return { accepted: true, version: group.version }
      }
      if (options.baseVersion !== group.version) {
        return rejectWithDraft({
          group,
          elementId,
          kind: '挂接',
          baselineState: options.baselineState ?? group.baselineState,
          baseVersion: options.baseVersion,
          originTab: options.originTab,
          note: options.note ?? ''
        })
      }

      // 从原接戏组移出（原自动独立组若清空则删除）
      const previous = await db.continuityGroups.filter((item) => item.elementIds.includes(elementId)).toArray()
      const affectedGroupIds = new Set<string>(previous.map((item) => item.id))
      affectedGroupIds.add(groupId)
      for (const prev of previous) {
        if (prev.id === groupId) continue
        prev.elementIds = prev.elementIds.filter((id) => id !== elementId)
        if (prev.auto && prev.elementIds.length === 0) {
          await db.continuityGroups.delete(prev.id)
        } else {
          prev.version += 1
          prev.updatedAt = Date.now()
          await db.continuityGroups.put(toPlainRow(prev))
        }
      }

      const nextElementIds = group.elementIds.includes(elementId) ? group.elementIds : [...group.elementIds, elementId]
      const patch: Partial<ContinuityGroupRow> = {
        elementIds: nextElementIds,
        auto: false,
        version: group.version + 1,
        updatedAt: Date.now()
      }
      if (typeof options.baselineState === 'string' && options.baselineState.trim()) {
        patch.baselineState = options.baselineState
      }
      await db.continuityGroups.update(groupId, toPlainRow(patch) as never)
      // 挂接关系变化 → 相关组时间轴改变，托管差异立即失效，等待重算
      await db.conflicts.filter((item) => item.managed && affectedGroupIds.has(item.groupId)).delete()
      const updated = await db.continuityGroups.get(groupId)
      return { accepted: true, version: updated?.version ?? group.version + 1 }
    }
  )
}

export interface DetachOptions {
  baseVersion: number
  originTab: string
  note?: string
}

/** 为单个要素补一个独立接戏组（auto=true），维持「每个要素必属于一个组」的不变量 */
async function createStandaloneGroupForElement(elementId: string): Promise<string | null> {
  const element = await db.elements.get(elementId)
  if (!element) return null
  const now = Date.now()
  const groupId = createGroupId()
  await db.continuityGroups.put(
    toPlainRow({
      id: groupId,
      name: element.name,
      category: element.category,
      baselineState: element.initialState,
      owner: element.owner,
      critical: element.critical,
      elementIds: [element.id],
      version: 1,
      auto: true,
      revision: ROW_REVISION,
      createdAt: now,
      updatedAt: now
    })
  )
  return groupId
}

/** 把要素从接戏组移出：普通组版本 +1、托管差异失效，要素退回独立组；版本落后保留草稿 */
export async function detachElementFromGroup(groupId: string, elementId: string, options: DetachOptions): Promise<GroupMutationOutcome> {
  return db.transaction(
    'rw',
    [db.continuityGroups, db.elements, db.conflicts, db.elementDrafts, db.draftConflicts],
    async () => {
      const group = await db.continuityGroups.get(groupId)
      if (!group) throw new Error('接戏组不存在或已被删除')
      if (!group.elementIds.includes(elementId)) return { accepted: true, version: group.version }
      if (options.baseVersion !== group.version) {
        return rejectWithDraft({
          group,
          elementId,
          kind: '移出',
          baselineState: group.baselineState,
          baseVersion: options.baseVersion,
          originTab: options.originTab,
          note: options.note ?? ''
        })
      }
      const nextIds = group.elementIds.filter((id) => id !== elementId)
      if (group.auto && nextIds.length === 0) {
        // 独立组的唯一要素移出：视为要素脱离，独立组直接删除
        await db.continuityGroups.delete(groupId)
        await db.conflicts.filter((item) => item.managed && item.groupId === groupId).delete()
        return { accepted: true, version: group.version }
      }
      await db.continuityGroups.update(groupId, {
        elementIds: nextIds,
        version: group.version + 1,
        updatedAt: Date.now()
      } as never)
      // 移出的要素退回为独立接戏组；相关组托管差异立即失效
      await createStandaloneGroupForElement(elementId)
      await db.conflicts.filter((item) => item.managed && item.groupId === groupId).delete()
      return { accepted: true, version: group.version + 1 }
    }
  )
}

/** 修改组基准（组内只认这一份）：版本落后时保留草稿并登记冲突 */
export async function updateGroupBaseline(
  groupId: string,
  baselineState: string,
  options: { baseVersion: number; originTab: string; note?: string }
): Promise<GroupMutationOutcome> {
  return db.transaction('rw', [db.continuityGroups, db.elementDrafts, db.draftConflicts], async () => {
    const group = await db.continuityGroups.get(groupId)
    if (!group) throw new Error('接戏组不存在或已被删除')
    if (options.baseVersion !== group.version) {
      return rejectWithDraft({
        group,
        elementId: '',
        kind: '基准',
        baselineState,
        baseVersion: options.baseVersion,
        originTab: options.originTab,
        note: options.note ?? ''
      })
    }
    await db.continuityGroups.update(groupId, {
      baselineState,
      version: group.version + 1,
      updatedAt: Date.now()
    } as never)
    return { accepted: true, version: group.version + 1 }
  })
}

/** 更新接戏组名称 / 类别 / 责任人 / 关键标记（不改基准与挂接，版本不变） */
export async function updateGroupMeta(id: string, patch: Partial<Pick<ContinuityGroup, 'name' | 'category' | 'owner' | 'critical'>>): Promise<void> {
  await db.continuityGroups.update(id, toPlainRow({ ...patch, updatedAt: Date.now() }) as never)
}

/** 删除接戏组：成员要素保留（各自退回独立组），托管差异与草稿一并清理 */
export async function removeContinuityGroup(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.continuityGroups, db.conflicts, db.elementDrafts, db.draftConflicts, db.elements],
    async () => {
      const group = await db.continuityGroups.get(id)
      if (group) {
        // 成员退回为独立接戏组，保证「每个要素都属于一个组」的不变量
        const members = await db.elements.where('id').anyOf(group.elementIds).toArray()
        const now = Date.now()
        const replacements: ContinuityGroupRow[] = members.map((element) => ({
          id: createGroupId(),
          name: element.name,
          category: element.category,
          baselineState: element.initialState,
          owner: element.owner,
          critical: element.critical,
          elementIds: [element.id],
          version: 1,
          auto: true,
          revision: ROW_REVISION,
          createdAt: now,
          updatedAt: now
        }))
        if (replacements.length > 0) await db.continuityGroups.bulkPut(toPlainRow(replacements))
      }
      await db.conflicts.where('groupId').equals(id).delete()
      await db.elementDrafts.where('groupId').equals(id).delete()
      await db.draftConflicts.where('groupId').equals(id).delete()
      await db.continuityGroups.delete(id)
    }
  )
}

/** 删除要素的内部级联：从接戏组移出并清理草稿 / 差异（供删场次、删要素复用） */
async function detachAndCleanupElement(elementId: string): Promise<void> {
  const records = await db.records.where('elementId').equals(elementId).toArray()
  const recordIds = records.map((item) => item.id)
  if (recordIds.length > 0) {
    await db.conflicts.filter((item) => recordIds.includes(item.recordIdA) || recordIds.includes(item.recordIdB)).delete()
  }
  await db.conflicts.where('elementId').equals(elementId).delete()
  await db.records.where('elementId').equals(elementId).delete()

  const groups = await db.continuityGroups.filter((group) => group.elementIds.includes(elementId)).toArray()
  for (const group of groups) {
    const nextIds = group.elementIds.filter((id) => id !== elementId)
    if (group.auto && nextIds.length === 0) {
      await db.continuityGroups.delete(group.id)
    } else {
      await db.continuityGroups.update(group.id, {
        elementIds: nextIds,
        version: group.version + 1,
        updatedAt: Date.now()
      } as never)
    }
  }
  const drafts = await db.elementDrafts.where('elementId').equals(elementId).toArray()
  if (drafts.length > 0) {
    await db.draftConflicts.where('draftId').anyOf(drafts.map((item) => item.id)).delete()
    await db.elementDrafts.where('elementId').equals(elementId).delete()
  }
}

/* ------------------------- 挂接草稿 / 冲突 ------------------------- */

export async function listElementDrafts(): Promise<ElementDraftRow[]> {
  return db.elementDrafts.toArray()
}

export async function listDraftConflicts(): Promise<DraftConflictRow[]> {
  const rows = await db.draftConflicts.toArray()
  return rows.sort((a, b) => b.createdAt - a.createdAt)
}

export async function removeDraft(id: string): Promise<void> {
  await db.transaction('rw', [db.elementDrafts, db.draftConflicts], async () => {
    await db.draftConflicts.where('draftId').equals(id).delete()
    await db.elementDrafts.delete(id)
  })
}

/** 采用草稿：按草稿内容重新发起操作（以组当前版本为准），成功后清除冲突与草稿 */
export async function adoptDraftConflict(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.draftConflicts, db.elementDrafts, db.continuityGroups, db.elements, db.conflicts],
    async () => {
      const conflict = await db.draftConflicts.get(id)
      if (!conflict) throw new Error('挂接冲突不存在')
      const draft = await db.elementDrafts.get(conflict.draftId)
      const group = await db.continuityGroups.get(conflict.groupId)
      if (!draft || !group) throw new Error('草稿或接戏组已不存在')
      const now = Date.now()
      if (draft.kind === '挂接' && draft.elementId) {
        // 以当前版本重新挂接（硬性校验不通过时抛错，由页面提示）
        const member = await db.elements.get(draft.elementId)
        if (member) await assertAttachable(group, member)
        const previous = await db.continuityGroups.filter((item) => item.elementIds.includes(draft.elementId)).toArray()
        for (const prev of previous) {
          if (prev.id === group.id) continue
          const nextIds = prev.elementIds.filter((item) => item !== draft.elementId)
          if (prev.auto && nextIds.length === 0) await db.continuityGroups.delete(prev.id)
          else await db.continuityGroups.put(toPlainRow({ ...prev, elementIds: nextIds, version: prev.version + 1, updatedAt: now }))
        }
        await db.continuityGroups.update(group.id, {
          elementIds: group.elementIds.includes(draft.elementId) ? group.elementIds : [...group.elementIds, draft.elementId],
          baselineState: draft.baselineState || group.baselineState,
          auto: false,
          version: group.version + 1,
          updatedAt: now
        } as never)
      } else if (draft.kind === '移出' && draft.elementId) {
        const nextIds = group.elementIds.filter((item) => item !== draft.elementId)
        if (group.auto && nextIds.length === 0) {
          await db.continuityGroups.delete(group.id)
        } else {
          await db.continuityGroups.update(group.id, { elementIds: nextIds, version: group.version + 1, updatedAt: now } as never)
        }
      } else if (draft.kind === '基准') {
        await db.continuityGroups.update(group.id, { baselineState: draft.baselineState, version: group.version + 1, updatedAt: now } as never)
      }
      await db.draftConflicts.update(id, { state: '已采用', resolvedNote: '已按草稿重新应用到最新版本', resolvedAt: nowIso(), updatedAt: now } as never)
      await db.elementDrafts.delete(draft.id)
    }
  )
}

/** 丢弃草稿冲突：仅留痕，不改动接戏组 */
export async function discardDraftConflict(id: string): Promise<void> {
  const conflict = await db.draftConflicts.get(id)
  if (!conflict) return
  const now = Date.now()
  await db.draftConflicts.update(id, { state: '已丢弃', resolvedNote: '人工确认放弃落后草稿', resolvedAt: nowIso(), updatedAt: now } as never)
  await db.elementDrafts.delete(conflict.draftId)
}

/* --------------------------- 整库导入导出 --------------------------- */

export interface DatabaseSnapshot {
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
}

function stripRow<T extends Revisioned>(row: T): Omit<T, keyof Revisioned> {
  const copy = { ...row } as Record<string, unknown>
  delete copy.revision
  delete copy.createdAt
  delete copy.updatedAt
  return copy as Omit<T, keyof Revisioned>
}

export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [scenes, elements, shootDays, records, conflicts, continuityGroups, elementDrafts, draftConflicts] = await Promise.all([
    db.scenes.toArray(),
    db.elements.toArray(),
    db.shootDays.toArray(),
    db.records.toArray(),
    db.conflicts.toArray(),
    db.continuityGroups.toArray(),
    db.elementDrafts.toArray(),
    db.draftConflicts.toArray()
  ])
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    scenes: scenes.map(stripRow),
    elements: elements.map(stripRow),
    shootDays: shootDays.map(stripRow),
    records: records.map(stripRow),
    conflicts: conflicts.map(stripRow),
    continuityGroups: continuityGroups.map(stripRow),
    elementDrafts: elementDrafts.map(stripRow),
    draftConflicts: draftConflicts.map(stripRow)
  }
}

function stamp<T>(row: T): T & Revisioned {
  const now = Date.now()
  return { ...row, revision: ROW_REVISION, createdAt: now, updatedAt: now }
}

/** 规整旧备份里的差异行：缺接戏组字段时补默认值 */
function normalizeConflictRow(row: Conflict & Revisioned): ConflictRow {
  return { ...row, groupId: typeof row.groupId === 'string' ? row.groupId : '', managed: row.managed === true }
}

export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.scenes,
      db.elements,
      db.shootDays,
      db.records,
      db.conflicts,
      db.continuityGroups,
      db.elementDrafts,
      db.draftConflicts
    ],
    async () => {
      await Promise.all([
        db.scenes.clear(),
        db.elements.clear(),
        db.shootDays.clear(),
        db.records.clear(),
        db.conflicts.clear(),
        db.continuityGroups.clear(),
        db.elementDrafts.clear(),
        db.draftConflicts.clear()
      ])
      await db.scenes.bulkPut((snapshot.scenes ?? []).map(stamp))
      await db.elements.bulkPut((snapshot.elements ?? []).map(stamp))
      await db.shootDays.bulkPut((snapshot.shootDays ?? []).map(stamp))
      await db.records.bulkPut((snapshot.records ?? []).map(stamp))
      await db.conflicts.bulkPut((snapshot.conflicts ?? []).map((row) => stamp(normalizeConflictRow(row as Conflict & Revisioned))))
      if (Array.isArray(snapshot.continuityGroups) && snapshot.continuityGroups.length > 0) {
        await db.continuityGroups.bulkPut(snapshot.continuityGroups.map(stamp))
      }
      if (Array.isArray(snapshot.elementDrafts)) await db.elementDrafts.bulkPut(snapshot.elementDrafts.map(stamp))
      if (Array.isArray(snapshot.draftConflicts)) await db.draftConflicts.bulkPut(snapshot.draftConflicts.map(stamp))
      // 旧备份（无接戏组）：每个单场要素补成独立接戏组并回填差异
      if (!Array.isArray(snapshot.continuityGroups) || snapshot.continuityGroups.length === 0) {
        await ensureAutoGroups()
      }
    }
  )
}

/** 清空全部数据并重新灌入演示数据 */
export async function resetDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [db.scenes, db.elements, db.shootDays, db.records, db.conflicts, db.continuityGroups, db.elementDrafts, db.draftConflicts],
    async () => {
      await Promise.all([
        db.scenes.clear(),
        db.elements.clear(),
        db.shootDays.clear(),
        db.records.clear(),
        db.conflicts.clear(),
        db.continuityGroups.clear(),
        db.elementDrafts.clear(),
        db.draftConflicts.clear()
      ])
    }
  )
  await seedDatabase()
}

/** 各表行数统计 */
export async function countAll(): Promise<Record<string, number>> {
  const [scenes, elements, shootDays, records, conflicts, continuityGroups, elementDrafts, draftConflicts] = await Promise.all([
    db.scenes.count(),
    db.elements.count(),
    db.shootDays.count(),
    db.records.count(),
    db.conflicts.count(),
    db.continuityGroups.count(),
    db.elementDrafts.count(),
    db.draftConflicts.count()
  ])
  return { scenes, elements, shootDays, records, conflicts, continuityGroups, elementDrafts, draftConflicts }
}
