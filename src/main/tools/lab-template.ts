import type { Device } from '@shared/types'
import { fail, ok, Type, type ToolSpec } from './registry'
import { batchConfigure } from './tasks'
import { verifyPing } from './verify'
import {
  buildTemplateTaskSteps,
  findLabTemplate,
  LAB_TEMPLATES
} from '../core/lab/templates'

/**
 * 实验模板一键搭建（v2.0）。
 *
 * list_lab_templates：只读列出内置模板（静态路由互通 / RIP 三路由 / NAT Easy IP / 双链路聚合）。
 * run_lab_template：把模板的角色映射到真实设备（deviceMap 或按已连接设备顺序），
 *   走 batch_configure 安全管道下发（快照 → 危险拦截 → 期望校验），收尾按 checks 跑 verify_ping，
 *   返回整体配置结果与连通性验证。全部数据来自 core/lab/templates.ts（纯函数可测）。
 */

export const listLabTemplates: ToolSpec = {
  name: 'list_lab_templates',
  description:
    '列出内置实验模板（只读）：返回模板 id / 名称 / 说明 / 角色与设备建议，供 run_lab_template 选用。',
  risk: 'read',
  scope: 'local',
  schema: Type.Object({}, { additionalProperties: false }),
  summarize: () => `列出 ${LAB_TEMPLATES.length} 个实验模板`,
  handler: async (_args, _ctx) => {
    const t0 = Date.now()
    return ok(
      {
        templates: LAB_TEMPLATES.map((t) => ({
          id: t.id,
          name: t.name,
          description: t.description,
          note: t.note,
          roles: t.roles.map((r) => `${r.role}（${r.hint}）`),
          deviceCount: t.devices.length,
          hasChecks: (t.checks?.length ?? 0) > 0
        }))
      } as never,
      { ms: Date.now() - t0 }
    )
  }
}

export const runLabTemplate: ToolSpec<{
  template: string
  deviceMap?: Record<string, string>
}> = {
  name: 'run_lab_template',
  description:
    '一键跑内置实验模板：选模板 id（list_lab_templates 可查），deviceMap 形如 { r1: "127.0.0.1:2001", sw1: "127.0.0.1:2002" } 把角色映射到设备；' +
    '未提供的角色按已连接设备顺序自动补齐。每台设备走 batch_configure 安全管道（快照 → 危险拦截 → 下发 → 期望校验），' +
    '收尾对模板 checks 逐条 verify_ping。返回角色映射、逐台配置结果与连通性验证。',
  risk: 'write',
  scope: 'device',
  schema: Type.Object(
    {
      template: Type.String({ description: '模板 id，如 static-route-basic / rip-three-routers / nat-easy-ip / eth-trunk-double-link' }),
      deviceMap: Type.Optional(
        Type.Record(Type.String(), Type.String(), { description: '角色 → 设备 ID 映射，如 { r1: "127.0.0.1:2001" }' })
      )
    },
    { additionalProperties: false }
  ),
  summarize: (args, result) => {
    const d = result.data as { template?: string; allConnected?: boolean; config?: { succeeded?: number; total?: number } } | undefined
    if (!result.ok) return `模板 ${args.template} 执行失败`
    return `模板 ${d?.template ?? args.template}：配置 ${d?.config?.succeeded ?? 0}/${d?.config?.total ?? 0} 成功${d?.allConnected ? '，验证全通' : ''}`
  },
  handler: async (args, ctx) => {
    const t0 = Date.now()
    const t = findLabTemplate(args.template)
    if (!t) {
      return fail('BAD_PARAM', `未知模板：${args.template}；可用 list_lab_templates 查看模板清单`, { ms: Date.now() - t0 })
    }

    const connected = ctx.sessions.list().filter((d: Device) => d.connected)
    const deviceIdByRole: Record<string, string> = {}
    const used = new Set<string>()
    for (const roleSpec of t.roles) {
      const wanted = args.deviceMap?.[roleSpec.role]
      if (wanted) {
        if (!ctx.sessions.get(wanted)) {
          return fail('BAD_PARAM', `deviceMap 里角色 ${roleSpec.role} 指向的设备未连接：${wanted}`, { ms: Date.now() - t0 })
        }
        deviceIdByRole[roleSpec.role] = wanted
        used.add(wanted)
        continue
      }
      const next = connected.find((d) => !used.has(d.id))
      if (next) {
        deviceIdByRole[roleSpec.role] = next.id
        used.add(next.id)
      }
    }

    const { steps, checks, missingRoles } = buildTemplateTaskSteps(t, deviceIdByRole)
    if (missingRoles.length) {
      return fail(
        'UNMET',
        `模板角色未映射到设备：${missingRoles.join('、')}。模板需要 ${t.roles.map((r) => `${r.role}（${r.hint}）`).join('；')}；可用 deviceMap 显式指定或连接足够多的设备后重跑`,
        { ms: Date.now() - t0 }
      )
    }

    const cfg = await batchConfigure.handler(
      {
        devices: steps.map((s) => ({
          deviceId: s.deviceId,
          commands: s.commands,
          description: s.description,
          ...(s.expectation ? { expectation: s.expectation } : {})
        }))
      },
      ctx
    )

    const verifies: Array<{ from: string; target: string; verdict: string }> = []
    for (const c of checks) {
      const v = await verifyPing.handler({ from: c.from, target: c.target }, ctx)
      verifies.push({
        from: c.from,
        target: c.target,
        verdict: v.ok ? ((v.data as { verdict?: string } | undefined)?.verdict ?? 'unknown') : 'error'
      })
    }
    const allConnected = verifies.length > 0 && verifies.every((v) => v.verdict === 'reachable')
    const plan = {
      roles: t.roles.map((r) => ({ role: r.role, deviceId: deviceIdByRole[r.role]!, hint: r.hint })),
      ipPlan: t.ipPlan ?? [],
      note: t.note,
      checks: verifies.map((v) => `${v.from} → ${v.target} = ${v.verdict}`)
    }

    if (!cfg?.ok) {
      const errored = cfg?.error
      return {
        ok: false,
        error: { code: errored?.code ?? 'TASK_FAILED', message: `模板「${t.name}」配置下发失败：${errored?.message ?? '未知错误'}` },
        data: { template: t.id, name: t.name, plan, config: cfg?.data ?? null, verifies } as never,
        meta: { ms: Date.now() - t0 }
      }
    }

    return ok(
      {
        template: t.id,
        name: t.name,
        plan,
        config: cfg.data,
        verifies,
        ...(verifies.length ? { allConnected } : {}),
        hint:
          verifies.length && !allConnected
            ? '存在未达通的检查项：先看接口/路由/ARP（verify_route / verify_arp / collect_device_diagnostics），再对照 ensp-troubleshooting 技能排障'
            : undefined
      } as never,
      { ms: Date.now() - t0 }
    )
  }
}