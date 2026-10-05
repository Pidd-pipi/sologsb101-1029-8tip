/**
 * 接戏组：同一件戏服 / 道具在多场次接着用时，把各场的同名连戏要素接成一组。
 * 组内只认一份基准，场次可挂接或移出；同一场次里的同名连戏要素只能属于一个接戏组。
 */
import type { ElementCategory } from './element'

/** 接戏组容量上限：超过 12 个场次拒绝继续挂接 */
export const GROUP_CAPACITY_LIMIT = 12

/** 接戏组：一份基准 + 若干挂接要素（分属不同场次） */
export interface ContinuityGroup {
  id: string
  /** 组名，通常用道具名，如「女主蓝色风衣」 */
  name: string
  /** 类别（服装 / 道具 / 妆发 / 陈设），组内要素须同类 */
  category: ElementCategory
  /** 组内唯一基准状态（全组只认这一份基准） */
  baselineState: string
  /** 基准来源说明（如：由第 3 场记录回写 / 手工指定） */
  baselineNote: string
  /** 挂接的要素 id（每个要素来自一个场次） */
  elementIds: string[]
  /** 挂接的场次 id（由 elementIds 派生，冗余存储便于查询） */
  sceneIds: string[]
  /** 容量上限，默认 12 */
  capacity: number
  /** 差异缓存指纹：基于哪些成员记录的 id + updatedAt 计算，用于失效判断 */
  diffFingerprint: string
  /** 最近一次比对时间（ISO） */
  lastDiffAt: number
}

/** 挂接草稿：版本冲突时保留的未生效挂接操作 */
export interface GroupDraft {
  id: string
  /** 接戏组 */
  groupId: string
  groupName: string
  /** 尝试挂接的要素 */
  elementId: string
  elementName: string
  /** 要素所属场次（用于展示，可空） */
  sceneId: string
  /** 草稿基于的组 revision */
  expectedRevision: number
  /** 保留时间 */
  createdAt: number
}

/** 版本冲突：两个页签同时挂接同一要素，基于旧版本的一方被拒绝 */
export interface VersionConflict {
  id: string
  groupId: string
  groupName: string
  elementId: string
  elementName: string
  /** 草稿基于的版本 */
  expectedRevision: number
  /** 对方已提交的最新版本 */
  latestRevision: number
  /** 冲突说明 */
  message: string
  createdAt: number
}

/**
 * 版本冲突错误：挂接时组的当前 revision 与草稿基于的 revision 不一致。
 * 调用方应保留草稿并列出冲突，而不是静默覆盖。
 */
export class VersionConflictError extends Error {
  constructor(
    public groupId: string,
    public groupName: string,
    public elementId: string,
    public elementName: string,
    public expectedRevision: number,
    public latestRevision: number
  ) {
    super(
      `接戏组「${groupName}」已被其他页签更新（v${expectedRevision} → v${latestRevision}），本次挂接未生效，草稿已保留`
    )
    this.name = 'VersionConflictError'
  }
}

export function createEmptyGroup(): Omit<ContinuityGroup, 'id' | 'diffFingerprint' | 'lastDiffAt'> {
  return {
    name: '',
    category: '服装',
    baselineState: '',
    baselineNote: '',
    elementIds: [],
    sceneIds: [],
    capacity: GROUP_CAPACITY_LIMIT
  }
}
