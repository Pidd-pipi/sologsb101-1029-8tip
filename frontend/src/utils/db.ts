/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名 gbcontinuity-db，数据结构版本号 version(2) 与 upgrade() 迁移逻辑
 * - 场次 / 连戏要素 / 接戏组 / 拍摄日 / 现场记录 / 连戏差异 六张表分表存储
 * - 首次打开自动播种互相引用的演示数据（含未解决冲突），保证每个页面打开都有内容
 */
import Dexie, { type Table, type Transaction } from 'dexie'
import { toRaw } from 'vue'
import type { Scene } from '../types/scene'
import type { Element } from '../types/element'
import type { ShootDay } from '../types/shootDay'
import type { Record as ContinuityRecord } from '../types/record'
import type { Conflict } from '../types/conflict'
import type { ContinuityGroup } from '../types/group'
import { GROUP_CAPACITY_LIMIT, VersionConflictError } from '../types/group'
import { nowIso } from './uuid'
import { seedDatabase } from './seed'

/** 数据库名 */
export const DB_NAME = 'gbcontinuity-db'

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 2

/** 行结构修订号 */
export const ROW_REVISION = 1

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
export type GroupRow = ContinuityGroup & Revisioned

/**
 * 深度剥掉 Vue 响应式代理（Proxy），得到可被 IndexedDB 结构化克隆的普通对象。
 * 页面里 `v-model` 绑定的数组字段（如 `ShootDay.sceneIds`）是 Vue 的 Proxy 数组，
 * 直接交给 Dexie 会抛 `DataCloneError: [object Object] could not be cloned`，
 * 表现为“保存按钮点了没反应、列表不增加、刷新后丢失”。所有写库入口都必须先过这一层。
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

class GbContinuityDatabase extends Dexie {
  scenes!: Table<SceneRow, string>
  elements!: Table<ElementRow, string>
  groups!: Table<GroupRow, string>
  shootDays!: Table<ShootDayRow, string>
  records!: Table<RecordRow, string>
  conflicts!: Table<ConflictRow, string>

  constructor() {
    super(DB_NAME)

    this.version(1)
      .stores({
        scenes: 'id, sceneNo, place, timeOfDay, shootOrder, state, updatedAt',
        elements: 'id, sceneId, category, name, owner, critical, updatedAt',
        shootDays: 'id, date, director, scripty, updatedAt',
        records: 'id, shootDayId, elementId, sceneId, takeNo, updatedAt',
        conflicts: 'id, elementId, recordIdA, recordIdB, severity, state, updatedAt'
      })
      .upgrade(async (tx) => {
        // 结构迁移：为历史行补齐行修订号与时间戳；新建库时各表为空，迁移天然幂等
        const tableNames = ['scenes', 'elements', 'shootDays', 'records', 'conflicts']
        for (const name of tableNames) {
          await tx
            .table(name)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              row.revision = ROW_REVISION
              if (typeof row.createdAt !== 'number') row.createdAt = Date.now()
              if (typeof row.updatedAt !== 'number') row.updatedAt = row.createdAt
            })
        }
      })

    this.version(2)
      .stores({
        scenes: 'id, sceneNo, place, timeOfDay, shootOrder, state, updatedAt',
        elements: 'id, sceneId, category, name, owner, critical, updatedAt',
        groups: 'id, name, category, updatedAt',
        shootDays: 'id, date, director, scripty, updatedAt',
        records: 'id, shootDayId, elementId, sceneId, takeNo, updatedAt',
        conflicts: 'id, elementId, recordIdA, recordIdB, severity, state, updatedAt'
      })
      .upgrade(async (tx) => {
        // v1 → v2：旧数据升级时，每个单场要素补成独立接戏组（只含它自己所在的场次）
        await migrateElementsToGroups(tx)
      })
  }
}

/**
 * v2 迁移：把每个历史连戏要素补成一个独立接戏组。
 * 组名取要素名、类别取要素类别、基准取要素初始状态，成员只含该要素自己。
 * 幂等：已存在同 id（group-{elementId}）的组不重复写入。
 */
async function migrateElementsToGroups(tx: Transaction): Promise<void> {
  const elements = (await tx.table('elements').toArray()) as ElementRow[]
  const now = Date.now()
  for (const el of elements) {
    const groupId = `group-${el.id}`
    const existing = await tx.table('groups').get(groupId)
    if (existing) continue
    const group: GroupRow = {
      id: groupId,
      name: el.name,
      category: el.category,
      baselineState: el.initialState,
      baselineNote: '旧版单场要素升级为独立接戏组',
      elementIds: [el.id],
      sceneIds: [el.sceneId],
      capacity: GROUP_CAPACITY_LIMIT,
      diffFingerprint: '',
      lastDiffAt: 0,
      revision: ROW_REVISION,
      createdAt: now,
      updatedAt: now
    }
    await tx.table('groups').put(group)
  }
}

export const db = new GbContinuityDatabase()

/** 打开数据库：首次使用时灌入演示数据（幂等：表非空不播） */
export async function initDatabase(): Promise<void> {
  await db.open()
  if ((await db.scenes.count()) === 0) {
    await seedDatabase()
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

/** 删除场次：级联删除其下要素、现场记录、差异，并把要素从接戏组移出 */
export async function removeScene(id: string): Promise<void> {
  await db.transaction('rw', [db.scenes, db.elements, db.records, db.conflicts, db.groups], async () => {
    const elements = await db.elements.where('sceneId').equals(id).toArray()
    const elementIds = elements.map((item) => item.id)
    const records = await db.records.where('sceneId').equals(id).toArray()
    const recordIds = records.map((item) => item.id)
    if (elementIds.length > 0) {
      await db.conflicts.where('elementId').anyOf(elementIds).delete()
    }
    if (recordIds.length > 0) {
      await db.conflicts.filter((item) => recordIds.includes(item.recordIdA) || recordIds.includes(item.recordIdB)).delete()
    }
    // 把该场要素从接戏组移出（组仍保留，仅移除成员）
    if (elementIds.length > 0) {
      const groups = await db.groups.toArray()
      for (const group of groups) {
        const nextElementIds = group.elementIds.filter((eid) => !elementIds.includes(eid))
        if (nextElementIds.length !== group.elementIds.length) {
          const memberElements = await db.elements.where('id').anyOf(nextElementIds).toArray()
          group.elementIds = nextElementIds
          group.sceneIds = [...new Set(memberElements.map((item) => item.sceneId))]
          group.updatedAt = Date.now()
          await db.groups.put(toPlainRow(group))
        }
      }
    }
    await db.records.where('sceneId').equals(id).delete()
    await db.elements.where('sceneId').equals(id).delete()
    await db.shootDays.toCollection().modify((day) => {
      if (day.sceneIds.includes(id)) {
        day.sceneIds = day.sceneIds.filter((sceneId) => sceneId !== id)
        day.updatedAt = Date.now()
      }
    })
    await db.scenes.delete(id)
  })
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

export async function removeElement(id: string): Promise<void> {
  await db.transaction('rw', [db.elements, db.records, db.conflicts, db.groups], async () => {
    await db.conflicts.where('elementId').equals(id).delete()
    await db.records.where('elementId').equals(id).delete()
    // 把要素从接戏组移出
    const groups = await db.groups.toArray()
    for (const group of groups) {
      if (group.elementIds.includes(id)) {
        const nextElementIds = group.elementIds.filter((eid) => eid !== id)
        const memberElements = await db.elements.where('id').anyOf(nextElementIds).toArray()
        group.elementIds = nextElementIds
        group.sceneIds = [...new Set(memberElements.map((item) => item.sceneId))]
        group.updatedAt = Date.now()
        await db.groups.put(toPlainRow(group))
      }
    }
    await db.elements.delete(id)
  })
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

export async function removeShootDay(id: string): Promise<void> {
  await db.transaction('rw', [db.shootDays, db.records, db.conflicts], async () => {
    const records = await db.records.where('shootDayId').equals(id).toArray()
    const recordIds = records.map((item) => item.id)
    if (recordIds.length > 0) {
      await db.conflicts.filter((item) => recordIds.includes(item.recordIdA) || recordIds.includes(item.recordIdB)).delete()
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

export async function putRecord(row: RecordRow): Promise<void> {
  await db.records.put(toPlainRow(row))
}

export async function updateRecord(id: string, patch: Partial<ContinuityRecord>): Promise<void> {
  await db.records.update(id, toPlainRow({ ...patch, updatedAt: Date.now() }) as never)
}

export async function removeRecord(id: string): Promise<void> {
  await db.transaction('rw', [db.records, db.conflicts], async () => {
    await db.conflicts.filter((item) => item.recordIdA === id || item.recordIdB === id).delete()
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

/** 批量写入比对生成的差异条目（覆盖同一对记录上的旧条目） */
export async function saveConflicts(rows: ConflictRow[]): Promise<number> {
  let created = 0
  await db.transaction('rw', [db.conflicts], async () => {
    for (const row of rows) {
      const exists = await db.conflicts
        .filter(
          (item) =>
            item.elementId === row.elementId &&
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

/** 解决差异：写入解决留痕并回写要素初始状态；若要素属于接戏组，同步回写组基准（组内只认一份基准） */
export async function resolveConflict(id: string, resolvedNote: string): Promise<void> {
  await db.transaction('rw', [db.conflicts, db.records, db.elements, db.groups], async () => {
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
      await db.elements.update(conflict.elementId, {
        initialState: latest.currentState,
        updatedAt: Date.now()
      } as never)
      // 要素属于接戏组时，组基准同步回写为最新现场状态（全组只认这一份基准）
      const group = await db.groups.filter((item) => item.elementIds.includes(conflict.elementId)).first()
      if (group) {
        await db.groups.update(group.id, {
          baselineState: latest.currentState,
          baselineNote: `冲突消解回写：${resolvedNote}`,
          updatedAt: Date.now()
        } as never)
      }
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

export async function listGroups(): Promise<GroupRow[]> {
  const rows = await db.groups.toArray()
  return rows.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function putGroup(row: GroupRow): Promise<void> {
  await db.groups.put(toPlainRow(row))
}

export async function updateGroup(id: string, patch: Partial<ContinuityGroup>): Promise<void> {
  await db.groups.update(id, toPlainRow({ ...patch, updatedAt: Date.now() }) as never)
}

export async function removeGroup(id: string): Promise<void> {
  await db.groups.delete(id)
}

/** 查找包含「同场次同名要素」的其他接戏组（唯一性校验用） */
async function findGroupByElement(
  sceneId: string,
  name: string,
  excludeGroupId: string
): Promise<GroupRow | null> {
  const [groups, elements] = await Promise.all([db.groups.toArray(), db.elements.toArray()])
  const elementMap = new Map(elements.map((item) => [item.id, item]))
  for (const group of groups) {
    if (group.id === excludeGroupId) continue
    for (const elementId of group.elementIds) {
      const element = elementMap.get(elementId)
      if (element && element.sceneId === sceneId && element.name === name) return group
    }
  }
  return null
}

/**
 * 挂接要素到接戏组（场次可挂接）。
 * - 类别一致：要素类别须与组类别相同
 * - 不重复挂接：要素已在本组则拒绝
 * - 容量检查：场次达到上限（12）拒绝继续挂接
 * - 唯一性检查：同一场次的同名要素只能属于一个接戏组
 * - 乐观并发：expectedRevision 与组当前 revision 不一致时抛 VersionConflictError
 */
export async function attachElementToGroup(
  groupId: string,
  elementId: string,
  expectedRevision: number
): Promise<GroupRow> {
  return db.transaction('rw', [db.groups, db.elements], async () => {
    const group = await db.groups.get(groupId)
    if (!group) throw new Error('接戏组不存在')
    if (group.revision !== expectedRevision) {
      const element = await db.elements.get(elementId)
      throw new VersionConflictError(
        group.id,
        group.name,
        elementId,
        element?.name ?? '',
        expectedRevision,
        group.revision
      )
    }
    const element = await db.elements.get(elementId)
    if (!element) throw new Error('连戏要素不存在')
    if (element.category !== group.category) {
      throw new Error(`要素类别「${element.category}」与接戏组类别「${group.category}」不一致，不能挂接`)
    }
    if (group.elementIds.includes(elementId)) {
      throw new Error('该要素已挂接在本组')
    }
    if (group.sceneIds.length >= group.capacity) {
      throw new Error(`接戏组容量已达上限（${group.capacity} 个场次），无法继续挂接`)
    }
    const duplicate = await findGroupByElement(element.sceneId, element.name, groupId)
    if (duplicate) {
      throw new Error(`同一场次的同名要素已属于接戏组「${duplicate.name}」，不能重复挂接`)
    }
    group.elementIds.push(elementId)
    if (!group.sceneIds.includes(element.sceneId)) group.sceneIds.push(element.sceneId)
    group.revision += 1
    group.updatedAt = Date.now()
    await db.groups.put(toPlainRow(group))
    return group
  })
}

/** 从接戏组移出要素（场次可移出） */
export async function detachElementFromGroup(groupId: string, elementId: string): Promise<GroupRow> {
  return db.transaction('rw', [db.groups, db.elements], async () => {
    const group = await db.groups.get(groupId)
    if (!group) throw new Error('接戏组不存在')
    const nextElementIds = group.elementIds.filter((id) => id !== elementId)
    const memberElements = await db.elements.where('id').anyOf(nextElementIds).toArray()
    group.elementIds = nextElementIds
    group.sceneIds = [...new Set(memberElements.map((item) => item.sceneId))]
    group.revision += 1
    group.updatedAt = Date.now()
    await db.groups.put(toPlainRow(group))
    return group
  })
}

/** 更新接戏组基准（组内只认一份基准） */
export async function updateGroupBaseline(
  groupId: string,
  baselineState: string,
  baselineNote: string
): Promise<GroupRow> {
  return db.transaction('rw', [db.groups], async () => {
    const group = await db.groups.get(groupId)
    if (!group) throw new Error('接戏组不存在')
    group.baselineState = baselineState
    group.baselineNote = baselineNote
    group.revision += 1
    group.updatedAt = Date.now()
    await db.groups.put(toPlainRow(group))
    return group
  })
}

/** 记录差异比对指纹（现场记录变化后指纹失效，触发重算） */
export async function touchGroupDiff(groupId: string, fingerprint: string): Promise<void> {
  await db.groups.update(groupId, {
    diffFingerprint: fingerprint,
    lastDiffAt: Date.now(),
    updatedAt: Date.now()
  } as never)
}

/** 递增组 revision（模拟其他页签已提交更新，用于演示乐观并发冲突） */
export async function bumpGroupRevision(groupId: string): Promise<number> {
  return db.transaction('rw', [db.groups], async () => {
    const group = await db.groups.get(groupId)
    if (!group) throw new Error('接戏组不存在')
    group.revision += 1
    group.updatedAt = Date.now()
    await db.groups.put(toPlainRow(group))
    return group.revision
  })
}

/* --------------------------- 整库导入导出 --------------------------- */

export interface DatabaseSnapshot {
  name: string
  schemaVersion: number
  exportedAt: string
  scenes: Scene[]
  elements: Element[]
  groups: ContinuityGroup[]
  shootDays: ShootDay[]
  records: ContinuityRecord[]
  conflicts: Conflict[]
}

function stripRow<T extends Revisioned>(row: T): Omit<T, keyof Revisioned> {
  const copy = { ...row } as Record<string, unknown>
  delete copy.revision
  delete copy.createdAt
  delete copy.updatedAt
  return copy as Omit<T, keyof Revisioned>
}

export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [scenes, elements, groups, shootDays, records, conflicts] = await Promise.all([
    db.scenes.toArray(),
    db.elements.toArray(),
    db.groups.toArray(),
    db.shootDays.toArray(),
    db.records.toArray(),
    db.conflicts.toArray()
  ])
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    scenes: scenes.map(stripRow),
    elements: elements.map(stripRow),
    groups: groups.map(stripRow),
    shootDays: shootDays.map(stripRow),
    records: records.map(stripRow),
    conflicts: conflicts.map(stripRow)
  }
}

function stamp<T>(row: T): T & Revisioned {
  const now = Date.now()
  return { ...row, revision: ROW_REVISION, createdAt: now, updatedAt: now }
}

export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction('rw', [db.scenes, db.elements, db.groups, db.shootDays, db.records, db.conflicts], async () => {
    await Promise.all([
      db.scenes.clear(),
      db.elements.clear(),
      db.groups.clear(),
      db.shootDays.clear(),
      db.records.clear(),
      db.conflicts.clear()
    ])
    await db.scenes.bulkPut(snapshot.scenes.map(stamp))
    await db.elements.bulkPut(snapshot.elements.map(stamp))
    await db.groups.bulkPut((snapshot.groups ?? []).map(stamp))
    await db.shootDays.bulkPut(snapshot.shootDays.map(stamp))
    await db.records.bulkPut(snapshot.records.map(stamp))
    await db.conflicts.bulkPut(snapshot.conflicts.map(stamp))
  })
}

/** 清空全部数据并重新灌入演示数据 */
export async function resetDatabase(): Promise<void> {
  await db.transaction('rw', [db.scenes, db.elements, db.groups, db.shootDays, db.records, db.conflicts], async () => {
    await Promise.all([
      db.scenes.clear(),
      db.elements.clear(),
      db.groups.clear(),
      db.shootDays.clear(),
      db.records.clear(),
      db.conflicts.clear()
    ])
  })
  await seedDatabase()
}

/** 各表行数统计 */
export async function countAll(): Promise<Record<string, number>> {
  const [scenes, elements, groups, shootDays, records, conflicts] = await Promise.all([
    db.scenes.count(),
    db.elements.count(),
    db.groups.count(),
    db.shootDays.count(),
    db.records.count(),
    db.conflicts.count()
  ])
  return { scenes, elements, groups, shootDays, records, conflicts }
}
