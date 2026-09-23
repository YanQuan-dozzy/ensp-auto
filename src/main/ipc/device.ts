import { EVENT, INVOKE } from '@shared/channels'
import { getSshCredential, listSshCredentials, newSshCredentialId, removeSshCredential, saveSshCredential } from '../settings/sshSecrets'
import { ipcMain } from 'electron'
import { isValidSshHost } from '@shared/transport'
import type { EmitFn } from './helpers'
import type { ScanProgress, SshConnectInput, SshSaveInput } from '@shared/api'
import { SSH_CREDENTIAL_ID_RE, requireDeviceId, sanitizeSshAuth, toInt, toStr } from './helpers'
import type { Services } from '../services'
import type {} from 'electron'

/**
 * 设备与终端：扫描 / 连接 / 断开 / 改名 / 遗忘、SSH 凭据与连接、终端交互通道。
 *
 * 本模块只做「校验 → 调服务 → 回传」，业务逻辑在 services / core。
 */
export function registerDeviceIpc(services: Services, emit: EmitFn): void {
  // ————————————————— 设备 —————————————————

  ipcMain.handle(INVOKE.deviceScan, async (_e, args: { start?: number; end?: number }) => {
    const start = Math.max(1, Math.min(65535, toInt(args?.start, 2000)))
    const end = Math.max(1, Math.min(65535, toInt(args?.end, 2050)))
    if (end < start) throw new Error('结束端口必须不小于起始端口')
    const devices = await services.sessions.scan(start, end, {
      onProgress: (p: ScanProgress) => emit(EVENT.scanProgress, p)
    })
    return devices
  })

  ipcMain.handle(INVOKE.deviceConnect, async (_e, args: { port?: number; name?: string }) => {
    const port = toInt(args?.port, 0)
    if (port < 1 || port > 65535) throw new Error('端口非法')
    const device = await services.sessions.connect(port, args?.name || undefined)
    // 型号探测异步补，不阻塞连接返回
    void services.sessions.probeDevice(device.id)
    return device
  })

  ipcMain.handle(INVOKE.deviceDisconnect, async (_e, args: { deviceId?: string }) => {
    services.sessions.disconnect(requireDeviceId(args?.deviceId))
  })

  ipcMain.handle(INVOKE.deviceRename, async (_e, args: { deviceId?: string; name?: string }) => {
    const device = services.sessions.rename(requireDeviceId(args?.deviceId), toStr(args?.name))
    if (!device) throw new Error('别名不能为空')
    return device
  })

  ipcMain.handle(INVOKE.deviceForget, async (_e, args: { deviceId?: string }) => {
    services.sessions.forget(requireDeviceId(args?.deviceId))
  })

  ipcMain.handle(INVOKE.deviceList, async () => services.sessions.list())

  // ——————— SSH 连接（v2.0） ———————

  ipcMain.handle(INVOKE.deviceSshList, async () => listSshCredentials())

  ipcMain.handle(INVOKE.deviceSshSave, async (_e, args: SshSaveInput | undefined) => {
    const host = toStr(args?.host)
    if (!isValidSshHost(host)) throw new Error('主机地址非法')
    const port = toInt(args?.port, 0)
    if (port < 1 || port > 65535) throw new Error('端口非法')
    const username = toStr(args?.username)
    if (!username) throw new Error('用户名不能为空')
    const auth = sanitizeSshAuth(args?.auth)
    if (!auth.ok) throw new Error(auth.error)
    return saveSshCredential({
      id: newSshCredentialId(),
      name: toStr(args?.name).trim() || `${host}:${port}`,
      host,
      port,
      username,
      auth: auth.auth
    })
  })

  ipcMain.handle(INVOKE.deviceSshDelete, async (_e, args: { id?: unknown }) => {
    const id = toStr(args?.id)
    if (!SSH_CREDENTIAL_ID_RE.test(id)) throw new Error('凭据 ID 非法')
    removeSshCredential(id)
  })

  ipcMain.handle(INVOKE.deviceSshConnect, async (_e, args: SshConnectInput | undefined) => {
    const credentialId = toStr(args?.credentialId)
    if (credentialId) {
      // 用已存条目：凭据解密只在主进程，密码/私钥不回渲染层
      if (!SSH_CREDENTIAL_ID_RE.test(credentialId)) throw new Error('凭据 ID 非法')
      const cred = getSshCredential(credentialId)
      if (!cred) throw new Error('SSH 凭据不存在或不可用')
      const device = await services.sessions.connectSsh({
        host: cred.host,
        port: cred.port,
        username: cred.username,
        auth: cred.auth,
        name: cred.name,
        credentialId
      })
      void services.sessions.probeDevice(device.id)
      return device
    }
    // 直接模式：必须带完整连接信息；save 时落盘为可复用条目
    const host = toStr(args?.host)
    if (!isValidSshHost(host)) throw new Error('主机地址非法')
    const port = toInt(args?.port, 0)
    if (port < 1 || port > 65535) throw new Error('端口非法')
    const username = toStr(args?.username)
    if (!username) throw new Error('用户名不能为空')
    const auth = sanitizeSshAuth(args?.auth)
    if (!auth.ok) throw new Error(auth.error)
    const givenName = toStr(args?.name).trim()
    let savedId: string | undefined
    if (args?.save) {
      savedId = saveSshCredential({
        id: newSshCredentialId(),
        name: givenName || `${host}:${port}`,
        host,
        port,
        username,
        auth: auth.auth
      }).id
    }
    const device = await services.sessions.connectSsh({
      host,
      port,
      username,
      auth: auth.auth,
      ...(givenName ? { name: givenName } : {}),
      ...(savedId ? { credentialId: savedId } : {})
    })
    void services.sessions.probeDevice(device.id)
    return device
  })

  // ————————————————— 终端 —————————————————

  ipcMain.handle(INVOKE.terminalWrite, async (_e, args: { deviceId?: string; data?: string }) => {
    const session = services.sessions.get(requireDeviceId(args?.deviceId))
    if (!session) return { accepted: false, queued: false }
    return session.writeInteractive(toStr(args?.data))
  })

  ipcMain.handle(
    INVOKE.terminalResize,
    async (_e, args: { deviceId?: string; cols?: number; rows?: number }) => {
      // resize 只影响渲染层排版；设备侧不做窗口尺寸协商（eNSP 场景不需要）
      const cols = toInt(args?.cols, 80)
      const rows = toInt(args?.rows, 24)
      return { cols, rows }
    }
  )

  ipcMain.handle(INVOKE.terminalBuffer, async () => '')
  ipcMain.handle(INVOKE.terminalClear, async () => true)
}

