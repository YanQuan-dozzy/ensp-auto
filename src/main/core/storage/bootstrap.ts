import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

export interface BootstrapConfig {
  userDataDir?: string
}

export function getDefaultUserDataDir(): string {
  try {
    return path.join(app.getPath('appData'), 'ensp-auto')
  } catch {
    return path.join(process.env['APPDATA'] || process.cwd(), 'ensp-auto')
  }
}

export function getBootstrapFilePath(): string {
  return path.join(getDefaultUserDataDir(), 'storage-bootstrap.json')
}

export function readBootstrapStorage(): BootstrapConfig {
  try {
    const file = getBootstrapFilePath()
    if (!fs.existsSync(file)) return {}
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as BootstrapConfig
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

export function writeBootstrapStorage(config: BootstrapConfig): void {
  const dir = getDefaultUserDataDir()
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  const file = getBootstrapFilePath()
  if (!config.userDataDir) {
    if (fs.existsSync(file)) {
      try {
        fs.unlinkSync(file)
      } catch {
        /* 忽略删除异常 */
      }
    }
  } else {
    fs.writeFileSync(file, JSON.stringify(config, null, 2), 'utf8')
  }
}

export function applyBootstrapStorage(): void {
  const config = readBootstrapStorage()
  if (config.userDataDir && typeof config.userDataDir === 'string') {
    const target = path.resolve(config.userDataDir.trim())
    if (target) {
      try {
        if (!fs.existsSync(target)) {
          fs.mkdirSync(target, { recursive: true })
        }
        app.setPath('userData', target)
      } catch {
        // 出错时回退默认，保障可用
      }
    }
  } else {
    // 无自定义引导配置时也显式固定默认目录：主进程可能调用 app.setName（品牌名），
    // 而 Electron 的默认 userData 依赖 app.name，不固定会迁移到 %APPDATA%\eNSPAuto，
    // 造成既有用户数据"消失"。
    try {
      app.setPath('userData', getDefaultUserDataDir())
    } catch {
      // 忽略
    }
  }
}

// 迁移实现已拆到 ./migrate（纯 Node，便于测试）；此处转出以保持既有导入路径可用
export {
  migrateDirectory,
  EXCLUDED_NAMES,
  type MigrateResult,
  type MigrateProgress
} from './migrate'
