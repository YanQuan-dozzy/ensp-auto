import fs from 'node:fs'
import path from 'node:path'
import { execFile, execFileSync } from 'node:child_process'

/**
 * Wireshark MCP 组件安装器（v1.9）。
 *
 * 与 `provision.ts` 的分工：那边只读探测（可以在任何时候跑，包括启动瞬间），
 * 这边会写磁盘、起子进程、联网 —— 只在用户点了「安装」之后跑一次。
 *
 * 关键口径：
 * - **隔离**：装进 userData/py 下的独立 venv，不碰用户全局 Python 环境，
 *   也不进项目 node_modules（Python 包放那儿既不合规范也容易被清理掉）。
 * - **可取消/可解释**：每一步都通过 onProgress 回调上报，UI 能显示「正在下载 xx」，
 *   而不是转个圈让用户等。
 * - **失败可重试**：venv 创建成功但装包失败时保留 venv（省一次创建），
 *   只有整目录结构坏了才重建。
 */

export interface InstallStep {
  stage: 'detect-python' | 'create-venv' | 'install-package' | 'verify' | 'done'
  /** 面向用户的一句话进度 */
  message: string
  /** 0~100，仅用于进度条；不确定时为 null */
  percent: number | null
}

export type ProgressFn = (step: InstallStep) => void

export interface InstallResult {
  ok: boolean
  /** 失败原因（中文，可直接展示） */
  error?: string
  /** 成功后的入口脚本路径 */
  entry?: string
  /** 安装到的 Python 版本 */
  pythonVersion?: string
}

const PKG_SPEC = 'wireshark-mcp>=3,<4'

/** 国内镜像优先（与项目 .npmrc 的口径一致），失败再退官方源 */
const INDEXES = [
  { url: 'https://pypi.tuna.tsinghua.edu.cn/simple', trusted: 'pypi.tuna.tsinghua.edu.cn' },
  { url: 'https://mirrors.aliyun.com/pypi/simple', trusted: 'mirrors.aliyun.com' },
  { url: 'https://pypi.org/simple', trusted: 'pypi.org' }
]

/** 找可用的系统 Python（3.10+）—— wireshark-mcp 要求 >=3.10 */
function findSystemPython(): string | null {
  const candidates: string[] = []
  if (process.platform === 'win32') {
    candidates.push('py', 'python', 'python3')
  } else {
    candidates.push('python3', 'python')
  }
  for (const cmd of candidates) {
    try {
      const args = cmd === 'py' ? ['-3', '-c', 'import sys;print(sys.executable)'] : ['-c', 'import sys;print(sys.executable)']
      const out = execFileSync(cmd, args, { encoding: 'utf8', timeout: 8000, windowsHide: true })
      const p = out.trim().split(/\r?\n/).pop()?.trim()
      if (p && fs.existsSync(p)) {
        const v = execFileSync(p, ['-c', 'import sys;print("%d.%d"%sys.version_info[:2])'], {
          encoding: 'utf8',
          timeout: 8000,
          windowsHide: true
        }).trim()
        const [maj, min] = v.split('.').map((n) => Number.parseInt(n, 10))
        if ((maj ?? 0) > 3 || ((maj ?? 0) === 3 && (min ?? 0) >= 10)) return p
      }
    } catch {
      // 命令不存在或版本不符，继续试下一个
    }
  }
  return null
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const out = `${stdout ?? ''}${stderr ?? ''}`
        // execFile 在非零退出或超时时给 err，退出码优先看 err.code
        const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0
        resolve({ code, out })
      }
    )
  })
}

export interface InstallOptions {
  /** venv 创建位置（checkWiresharkMcp().paths.python 的上一级目录） */
  venvRoot: string
  onProgress?: ProgressFn
}

/**
 * 安装 wireshark-mcp 到隔离 venv。
 *
 * 幂等：已装好且能跑 --version 时直接返回成功，不重复联网。
 */
export async function installWiresharkMcp(opts: InstallOptions): Promise<InstallResult> {
  const report = opts.onProgress ?? ((): void => undefined)
  const { venvRoot } = opts
  const isWin = process.platform === 'win32'
  const pythonBin = isWin ? path.join(venvRoot, 'Scripts', 'python.exe') : path.join(venvRoot, 'bin', 'python')
  const entryBin = isWin ? path.join(venvRoot, 'Scripts', 'wireshark-mcp.exe') : path.join(venvRoot, 'bin', 'wireshark-mcp')

  // —— 已经装过？跑个 --version 确认能启动，避免「文件在但坏了」的假成功 ——
  if (fs.existsSync(entryBin) && fs.existsSync(pythonBin)) {
    report({ stage: 'verify', message: '检测到已安装的组件，正在校验', percent: 90 })
    const chk = await run(entryBin, ['--version'], 15000)
    if (chk.code === 0) {
      report({ stage: 'done', message: '组件已就绪', percent: 100 })
      return { ok: true, entry: entryBin }
    }
    // 校验失败：不删目录，交给下面的重装流程自愈（pip 会覆盖）
  }

  report({ stage: 'detect-python', message: '正在查找系统 Python（需 3.10 及以上）', percent: 5 })
  const sysPython = findSystemPython()
  if (!sysPython) {
    return {
      ok: false,
      error:
        '未找到可用的 Python（需要 3.10 或更高版本）。请先安装 Python 并勾选「Add Python to PATH」，然后重试。'
    }
  }

  // —— 建 venv（已存在且解释器可用则跳过） ——
  if (!fs.existsSync(pythonBin)) {
    report({ stage: 'create-venv', message: '正在创建隔离的 Python 环境', percent: 20 })
    fs.mkdirSync(path.dirname(venvRoot), { recursive: true })
    const mk = await run(sysPython, ['-m', 'venv', venvRoot], 180000)
    if (mk.code !== 0 || !fs.existsSync(pythonBin)) {
      return {
        ok: false,
        error: `创建 Python 虚拟环境失败。${mk.out.trim().slice(-400) || '请确认 Python 安装完整（含 venv 模块）。'}`
      }
    }
  } else {
    report({ stage: 'create-venv', message: '复用已有的 Python 环境', percent: 20 })
  }

  // —— 装包：先升级 pip（老 pip 装不了新版元数据），再装本体；镜像逐个回退 ——
  report({ stage: 'install-package', message: '正在升级安装工具', percent: 30 })
  await run(pythonBin, ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', '--upgrade', 'pip'], 240000)

  let lastErr = ''
  for (let i = 0; i < INDEXES.length; i++) {
    const idx = INDEXES[i]!
    report({
      stage: 'install-package',
      message: `正在下载分析组件（源 ${i + 1}/${INDEXES.length}）`,
      percent: 40 + i * 10
    })
    const args = [
      '-m',
      'pip',
      'install',
      '--disable-pip-version-check',
      '--no-cache-dir',
      '-i',
      idx.url,
      '--trusted-host',
      idx.trusted,
      PKG_SPEC
    ]
    const res = await run(pythonBin, args, 600000)
    if (res.code === 0 && fs.existsSync(entryBin)) {
      report({ stage: 'verify', message: '正在校验安装结果', percent: 90 })
      const chk = await run(entryBin, ['--version'], 20000)
      if (chk.code === 0) {
        report({ stage: 'done', message: '组件安装完成', percent: 100 })
        return { ok: true, entry: entryBin }
      }
      lastErr = chk.out.trim().slice(-400)
      continue
    }
    lastErr = res.out.trim().slice(-400) || `pip 退出码 ${res.code}`
  }

  return {
    ok: false,
    error: `安装 wireshark-mcp 失败。最后一处错误：${lastErr || '未知'}。可检查网络或在命令行手动执行 pip install ${PKG_SPEC}。`
  }
}
