import type { ElementCategory } from './element'

/**
 * 接戏组：同一件戏服 / 道具在多个场次接续出现时，
 * 组内只认一份连戏基准（baselineState），各场次的同名要素挂接到同一组上。
 */
export interface ContinuityGroup {
  id: string
  /** 接戏组名称，如：女主蓝色风衣（12A/15 场接续） */
  name: string
  /** 类别（与组内要素类别一致，便于筛选与展示） */
  category: ElementCategory
  /** 组内唯一连戏基准状态 */
  baselineState: string
  /** 责任人 */
  owner: string
  /** 是否关键接戏（关键组的状态差异判为阻断） */
  critical: boolean
  /** 挂接的连戏要素 id（可跨场次；同场次同名要素必须同组） */
  elementIds: string[]
  /** 基准 / 成员版本号：每次基准或挂接变化 +1，挂接方必须基于最新版本 */
  version: number
  /** 旧数据升级时为单场要素自动补建的独立接戏组；成员清空后自动删除 */
  auto: boolean
}

/** 接戏组最多挂接的场次数（按去重场次计数，超过拒绝挂接） */
export const GROUP_MAX_SCENES = 12

export function createEmptyContinuityGroup(): Omit<ContinuityGroup, 'id' | 'elementIds' | 'version' | 'auto'> {
  return { name: '', category: '服装', baselineState: '', owner: '', critical: false }
}
