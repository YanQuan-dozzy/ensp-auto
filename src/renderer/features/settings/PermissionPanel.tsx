import type { ReactNode } from 'react'
import { DANGEROUS_COMMANDS } from '@shared/risk'
import { useApp } from '@/stores/app'
import { Row, Section } from '@/components/settings-kit'
import { Chip, Switch } from '@/components/ui'

/**
 * 设置 → 权限与审批（v1.6）。
 *
 * 这个分区只做一件事：把「代理能干到哪一步」的松紧螺丝交到用户手里，
 * 并且**把后果写在开关旁边**。本项目的安全模型是「只读自由执行 / 变更留痕可回滚 /
 * 破坏性操作人工闸门」，这里的两个开关各自松动其中一环：
 *
 * - 关掉「危险操作确认」= 闸门不再弹出，**命令级危险清单（classifyDanger）同步放行**
 *   （v2.28 修：此前只松了工具级闸门，清单仍硬拦 reboot / reset saved-configuration，
 *   于是「关了开关还拦着」—— 与界面文案再次不一致）。多行命令是唯一例外，
 *   它是判定的前提而不是分类，关开关也拦（见 shared/gate-policy.ts#planCommandGate）；
 * - 打开「外部工具一律确认」= 逐台服务器的「信任」失效，全部回到人工确认。
 *
 * 两者都是即时生效（settings:set 每次落盘），所以不设「保存」按钮 ——
 * 安全开关最忌讳「我明明关了但它还拦着」这种状态不一致。
 */
export function PermissionPanel(): ReactNode {
  const settings = useApp((s) => s.settings)
  const updateSettings = useApp((s) => s.updateSettings)
  const servers = settings.mcp.servers
  const trusted = servers.filter((s) => s.enabled && s.trusted).length

  return (
    <>
      <Section label="设备操作">
        <Row
          title="危险操作需人工确认"
          desc="重启设备、清空配置、恢复出厂、保存当前配置这类不可撤销的操作，执行前弹确认框；同时启用命令级危险清单（reboot / reset saved-configuration / save 等）。关闭后两层一起放行：不再弹确认框，清单也不再拦截。"
          control={
            <Switch
              checked={settings.permission.confirmDanger}
              onChange={(v) =>
                void updateSettings({
                  permission: { ...settings.permission, confirmDanger: v }
                })
              }
            />
          }
        />
        {!settings.permission.confirmDanger ? (
          <div className="banner danger">
            已关闭确认框：代理可以直接执行重启、清空配置、恢复出厂等破坏性操作，命令级危险清单
            同步放行，且没有回滚手段。唯一例外是多行命令（\r / \n 分隔）：
            设备会逐行执行、单条判定管不住第二行，因此该形态始终拦截。
            这一项只建议在做一次性实验、并且设备可以随时重装时打开。
          </div>
        ) : (
          <div className="banner success">
            确认框已开启。只读命令（display / ping / tracert 等）不拦截，不会打断正常排查。
          </div>
        )}
        <Row
          title="被拦截的命令"
          desc="上面的开关打开时（默认），命令级危险清单生效：命中即拦截并写入变更记录，不依赖提示词（提示词能被模型绕过，清单不能）。关闭开关后本清单放行，仅多行命令例外。"
          stacked
          control={
            <details className="cand-details">
              <summary>查看 {DANGEROUS_COMMANDS.length} 条危险命令清单</summary>
              <ul>
                {DANGEROUS_COMMANDS.map((c) => (
                  <li key={c}>
                    <span className="mono">{c}</span>
                  </li>
                ))}
              </ul>
              <div className="hint">
                另有结构规则兜底：undo startup…、clear|reset configuration…、
                delete … /unreserved、stop … 等写法命中同样拦截。
              </div>
            </details>
          }
        />
      </Section>

      <Section label="外部 MCP 工具">
        <Row
          title="外部工具一律人工确认"
          desc={`外部 MCP 服务器的工具行为本应用无法审计，默认按最高风险处理（每次调用都要确认）；对某台服务器勾选「信任」可免确认。打开这个开关后，「信任」不再生效。当前 ${servers.length} 台服务器，其中 ${trusted} 台已信任。`}
          control={
            <Switch
              checked={settings.permission.externalToolConfirm}
              onChange={(v) =>
                void updateSettings({
                  permission: { ...settings.permission, externalToolConfirm: v }
                })
              }
            />
          }
        />
        <Row
          title="当前生效口径"
          desc="这一行是代理此刻实际遵守的规则，用于核对设置是否真的落到了运行时。"
          control={
            <Chip tone={settings.permission.externalToolConfirm ? 'success' : 'plain'}>
              {settings.permission.externalToolConfirm
                ? '全部外部工具需确认'
                : trusted > 0
                  ? `${trusted} 台免确认`
                  : '全部外部工具需确认'}
            </Chip>
          }
        />
      </Section>
    </>
  )
}
