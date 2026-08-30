import { useEffect, useMemo, useState } from 'react'
import qrcode from 'qrcode-generator'

type Section = 'general' | 'terminal' | 'presets' | 'identities' | 'hooks' | 'remote' | 'peers' | 'update'

/**
 * 配对二维码。手机扫一下就带着 token 进去了 —— 32 位十六进制 token 手打一次
 * 就足以让人放弃这个功能。
 *
 * 自己画 SVG 而不是用库的 createSvgTag()：那个返回 HTML 字符串，
 * 要 dangerouslySetInnerHTML 才能塞进 React，为了一张二维码不值当开那个口子。
 */
function PairQR({ url }: { url: string }): React.JSX.Element | null {
  const path = useMemo(() => {
    if (!url) return null
    // 纠错级 M：链接不长，M 足够；再高只会让码变密、更难扫
    const qr = qrcode(0, 'M')
    qr.addData(url)
    qr.make()
    const n = qr.getModuleCount()
    let d = ''
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (qr.isDark(r, c)) d += `M${c},${r}h1v1h-1z`
      }
    }
    return { d, n }
  }, [url])
  if (!path) return null
  // 留 2 格静区，不然某些扫码器识别不了
  const q = 2
  return (
    <svg
      className="settings-qr"
      viewBox={`${-q} ${-q} ${path.n + q * 2} ${path.n + q * 2}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label="配对二维码"
    >
      <rect x={-q} y={-q} width={path.n + q * 2} height={path.n + q * 2} fill="#fff" />
      <path d={path.d} fill="#000" />
    </svg>
  )
}

const SECTIONS: { key: Section; label: string }[] = [
  { key: 'general', label: '通用' },
  { key: 'terminal', label: '终端' },
  { key: 'presets', label: 'Agent 预设' },
  { key: 'identities', label: '凭证' },
  { key: 'hooks', label: 'Hooks 与状态' },
  { key: 'remote', label: '远程访问' },
  { key: 'peers', label: '跨机协作' },
  { key: 'update', label: '更新' }
]

export function SettingsPanel({
  initial,
  onClose,
  renderPresets,
  renderIdentities,
  onExportLayout,
  onImportLayout,
  getWorkspace
}: {
  initial: Section
  onClose: () => void
  renderPresets: () => React.JSX.Element
  renderIdentities: () => React.JSX.Element
  /** 导出/导入任务布局（可分享的骨架，见 main/layout-template.ts） */
  onExportLayout: () => Promise<void>
  onImportLayout: () => Promise<void>
  /** 取内存里的实时画布用于导出 */
  getWorkspace: () => unknown
}): React.JSX.Element {
  const [section, setSection] = useState<Section>(initial)
  const [s, setS] = useState<AppSettings | null>(null)
  const [hooks, setHooks] = useState<{
    installed: boolean
    settingsPath: string
    consent: 'ask' | 'on' | 'off'
  } | null>(null)
  const [skills, setSkills] = useState<{ name: string; description: string }[]>([])
  const [doctor, setDoctor] = useState<
    { key: string; label: string; ok: boolean; detail: string; hint: string }[]
  >([])
  /** 设置落盘失败的原因。静默失败 = 用户以为改好了，其实没有 */
  const [saveErr, setSaveErr] = useState('')
  const [tokens, setTokens] = useState<RemoteTokenMeta[]>([])
  const [shareLabel, setShareLabel] = useState('')
  /** 刚签发的完整链接。**只在内存里活一次** —— 主进程之后只回前 6 位 */
  const [shareUrl, setShareUrl] = useState('')
  const [remote, setRemote] = useState<Awaited<
    ReturnType<typeof window.termspace.remoteStatus>
  > | null>(null)
  const [info, setInfo] = useState<Awaited<ReturnType<typeof window.termspace.appInfo>>>(null)
  const [upd, setUpd] = useState<UpdateState | null>(null)
  /** 更新源输入框的草稿。null = 没在编辑，显示已保存的值。见那个 input 上的注释 */
  const [feedDraft, setFeedDraft] = useState<string | null>(null)
  /** 备份区的即时反馈。导出成功却一声不吭，用户不知道文件去哪了 */
  const [backupMsg, setBackupMsg] = useState('')
  /** 白名单里的编辑器（主进程给，渲染层不自己维护一份 —— 两份必然漂） */
  const [editors, setEditors] = useState<string[]>([])
  const [brokerName, setBrokerName] = useState('')
  const [brokerKind, setBrokerKind] = useState<'ssh' | 'postgres'>('postgres')
  const [brokerRO, setBrokerRO] = useState(true)
  /** 连接串草稿。**只在内存里活一次** —— 保存后主进程不会再回传它 */
  const [brokerTarget, setBrokerTarget] = useState('')
  const [brokerSaving, setBrokerSaving] = useState(false)
  /** 通知地址草稿。理由同 feedDraft：边打字边落盘会把半截 URL 存进去 */
  const [notifyDraft, setNotifyDraft] = useState<string | null>(null)
  /** 「发测试通知」的结果。这条链路失败全是静默的，必须当场说话 */
  const [notifyMsg, setNotifyMsg] = useState('')

  useEffect(() => {
    void window.termspace.getSettings().then(setS)
    void window.termspace.hooksStatus().then(setHooks)
    void window.termspace.listSkills().then(setSkills)
    void window.termspace.doctor().then(setDoctor)
    void window.termspace.remoteStatus().then(setRemote)
    void window.termspace.remoteTokens().then(setTokens)
    void window.termspace.appInfo().then(setInfo)
    void window.termspace.listEditors().then(setEditors)
    void window.termspace.updateState().then((u) => u && setUpd(u))
    // 光靠开面板时拉一次是不够的：下载进度得能动
    return window.termspace.onUpdateState(setUpd)
  }, [])

  const patch = (p: Partial<AppSettings>): void => {
    const before = s
    setS((cur) => (cur ? { ...cur, ...p } : cur)) // 乐观更新，控件不卡手
    void window.termspace.setSettings(p).then(setS, (e) => {
      // 失败必须回滚：勾选框停在新状态、实际没生效，是最难查的一类"看着好了"
      setS(before)
      setSaveErr(String((e as { message?: string })?.message ?? e))
    })
  }

  return (
    <div className="identity-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <aside className="settings-nav">
          <div className="settings-nav-title">设置</div>
          {SECTIONS.map((x) => (
            <button
              key={x.key}
              className={`settings-nav-item${section === x.key ? ' active' : ''}`}
              onClick={() => setSection(x.key)}
            >
              {x.label}
            </button>
          ))}
        </aside>
        <main className="settings-body">
          {saveErr && (
            <p className="settings-note settings-err">
              设置没能保存：<code>{saveErr}</code>　刚才那一项已回滚，磁盘/权限修好后再试。
            </p>
          )}
          <button className="term-node-close settings-close" onClick={onClose}>
            ✕
          </button>

          {section === 'general' && s && (
            <>
              <h3 className="settings-h">通用</h3>
              <label className="settings-row">
                <span>新终端默认字号</span>
                <input
                  type="number"
                  min={8}
                  max={24}
                  value={s.defaultFontSize}
                  onChange={(e) => patch({ defaultFontSize: Number(e.currentTarget.value) })}
                />
              </label>
              <p className="settings-note">
                单个终端可用 ⌥+滚轮 或右键菜单单独调整，不影响此默认值。
              </p>
              <h3 className="settings-h">工具中枢 · Skill 库（{skills.length}）</h3>
              <p className="settings-note">
                画布上每个终端都自带 <code>tb</code> 命令：agent 跑 <code>tb skills 关键词</code>{' '}
                搜工具、<code>tb load 名称</code> 取全文、<code>tb agents</code> 看同伴。
                常驻上下文里只有一句路由提示（约 60 token），工具全文按需拉取——
                不用把 skill 规则塞满每个 agent。默认扫描 <code>~/.claude/skills</code>。
              </p>
              <div className="skill-list">
                {skills.slice(0, 40).map((sk) => (
                  <div key={sk.name} className="skill-row">
                    <span className="skill-name">{sk.name}</span>
                    <span className="skill-desc">{sk.description}</span>
                  </div>
                ))}
                {skills.length === 0 && (
                  <div className="identity-empty">
                    ~/.claude/skills 下没扫到 skill（需 &lt;skill&gt;/SKILL.md 结构）
                  </div>
                )}
              </div>

              <h3 className="settings-h">工作区备份</h3>
              <p className="settings-note">
                app 已经在本机留了两层退路（<code>.bak</code> + 每小时一份、保留 24
                份的存档），但都在同一块盘上。换机、重装、误删要靠导出的文件。
                <br />
                <b>任务布局</b>是另一件事：它是能发给同事的骨架 ——
                不含任何凭证、目录是相对的、里面的命令<b>不会自动执行</b>
                （铺出来后你自己点）。想分享工作流用它，别直接发工作区文件。
              </p>
              <div className="settings-actions">
                <button
                  className="settings-btn"
                  onClick={() => {
                    setBackupMsg('')
                    void window.termspace.exportWorkspace(getWorkspace()).then((r) => {
                      if (r.canceled) return
                      setBackupMsg(r.ok ? `已导出到 ${r.path}` : `导出失败：${r.error}`)
                    })
                  }}
                >
                  导出工作区…
                </button>
                {/* **布局模板和工作区是两件事**：工作区是本机全量状态（含凭证绑定、
                    会随 command 自动执行）；模板是能发给别人的骨架 —— 无凭证、
                    相对路径、命令默认暂停。两个按钮放一起，文案要把差别说清楚。 */}
                <button className="settings-btn" onClick={() => void onExportLayout()}>
                  导出任务布局…
                </button>
                <button className="settings-btn" onClick={() => void onImportLayout()}>
                  导入任务布局…
                </button>
                <button
                  className="settings-btn"
                  onClick={() => {
                    setBackupMsg('')
                    // 成功的话主进程会直接重启 app，这个 then 根本不会跑到
                    void window.termspace.importWorkspace().then((r) => {
                      if (!r.ok && !r.canceled) setBackupMsg(`导入失败：${r.error}`)
                    })
                  }}
                >
                  导入工作区…
                </button>
                <button className="settings-btn" onClick={() => void window.termspace.revealUserData()}>
                  打开数据目录
                </button>
              </div>
              {backupMsg && <p className="settings-note">{backupMsg}</p>}

              <h3 className="settings-h">关于</h3>
              {info && (
                <>
                  <p className="settings-note">
                    Termspace {info.version} · Electron {info.electron}
                    <br />
                    数据目录 <code>{info.userData}</code>
                  </p>
                  {/* 崩溃过就说出来。白屏/闪退不留痕迹是这个项目最难查的一类问题 */}
                  {(info.crashCount > 0 || info.crashBytes > 0) && (
                    <p className="settings-note settings-err">
                      崩溃日志里有内容（{Math.ceil(info.crashBytes / 1024)} KB
                      {info.crashCount > 0 && `，本次运行 ${info.crashCount} 次`}）。
                      「打开数据目录」会直接定位到 <code>crash.log</code>。
                    </p>
                  )}
                </>
              )}
            </>
          )}

          {section === 'terminal' && s && (
            <>
              <h3 className="settings-h">终端</h3>
              <label className="settings-row">
                <span>默认 Shell</span>
                <input
                  placeholder="留空 = 跟随 $SHELL"
                  value={s.defaultShell}
                  onChange={(e) => patch({ defaultShell: e.currentTarget.value })}
                />
              </label>
              <label className="settings-row">
                <span>tmux 会话续存</span>
                <input
                  type="checkbox"
                  checked={s.tmuxEnabled}
                  onChange={(e) => patch({ tmuxEnabled: e.currentTarget.checked })}
                />
              </label>
              <p className="settings-note">
                开启后终端在 app 重启、reload 后自动接回原会话，跑着的进程不断；关闭 ✕
                节点才真正结束。关掉此项则退回普通 shell（无续存）。改动对新建/重开的终端生效。
              </p>
              <label className="settings-row">
                <span>回滚行数</span>
                <input
                  type="number"
                  min={500}
                  max={100000}
                  step={1000}
                  value={s.scrollback}
                  onChange={(e) => patch({ scrollback: Number(e.currentTarget.value) })}
                />
              </label>
            </>
          )}

          {section === 'presets' && renderPresets()}
          {section === 'identities' && renderIdentities()}

          {section === 'hooks' && (
            <>
              <h3 className="settings-h">Agent 状态 Hooks</h3>
              <div className="settings-row">
                <span>状态服务</span>
                <span className={`status-chip ${hooks?.installed ? 'running' : 'attention'}`}>
                  {hooks?.installed ? '运行中' : '未启动'}
                </span>
              </div>
              <div className="settings-row">
                <span>写入 ~/.claude/settings.json</span>
                <span className={`status-chip ${hooks?.consent === 'on' ? 'running' : 'idle'}`}>
                  {hooks?.consent === 'on' ? '已授权' : hooks?.consent === 'off' ? '未授权' : '未询问'}
                </span>
                {hooks?.consent === 'on' && (
                  <button
                    className="group-act"
                    title="从 ~/.claude/settings.json 摘掉 Termspace 的 hook 条目"
                    onClick={() => {
                      void window.termspace.uninstallHooks().then(() => {
                        void window.termspace.hooksStatus().then(setHooks)
                      })
                    }}
                  >
                    卸载
                  </button>
                )}
              </div>
              <p className="settings-note">
                Termspace 在本机回环端口跑一个 hook 服务，Claude Code 通过它上报运行状态
                （运行中 / 需要你 / 空闲），工具调用审批也走这条通道回到画布上。配置合并进{' '}
                <code>{hooks?.settingsPath}</code>，原文件首次备份为同名{' '}
                <code>.termboard-backup</code>。
                托管脚本对非 Termspace 终端会立即退出，不影响你在别处正常使用 Claude Code。
                卸载后需重启应用才会完全停止上报。
              </p>

              <h3 className="settings-h">依赖体检</h3>
              {doctor.map((d) => (
                <div className="settings-row" key={d.key}>
                  <span>{d.label}</span>
                  <span className={`status-chip ${d.ok ? 'running' : 'attention'}`}>
                    {d.ok ? '正常' : '缺失'}
                  </span>
                  <span className="settings-doctor-detail" title={d.hint}>
                    {d.ok ? d.detail : d.hint}
                  </span>
                </div>
              ))}

              <h3 className="settings-h">代理连接（agent 用得到、拿不到凭证）</h3>
              <p className="settings-note">
                这是<b>唯一</b>真正做到「AI 能用但看不到密码」的地方：连接串加密存在钥匙串里、
                只在主进程内使用，agent 只能说「在 <code>prod</code> 上跑这条 SQL」。
                终端里用 <code>tb db &lt;名字&gt; &quot;select …&quot;</code> 或{' '}
                <code>tb ssh &lt;名字&gt; &quot;ls /var/log&quot;</code>。
                <br />
                只读模式：数据库会拒绝写语句并让整个会话进只读事务；ssh 只放行一小组
                查看类命令且不含管道分号。<b>只对能代理的协议承诺</b> —— API key
                作为环境变量注入时做不到这件事，那是协议本身的性质。
              </p>
              <div className="identity-list">
                {(s?.brokers ?? []).map((b) => (
                  <div key={b.id} className="identity-row">
                    <span className={`identity-provider ${b.kind === 'ssh' ? 'custom' : 'codex'}`}>
                      {b.kind}
                    </span>
                    <span className="identity-name">{b.name}</span>
                    <span className="identity-keys">{b.readOnly ? '只读' : '可写'}</span>
                    <button
                      className="identity-del"
                      onClick={() => {
                        if (!window.confirm(`删除代理连接「${b.name}」？连接串一并删除。`)) return
                        void window.termspace.deleteBroker(b.id).then(() => {
                          void window.termspace.getSettings().then(setS)
                        })
                      }}
                    >
                      删除
                    </button>
                  </div>
                ))}
                {(s?.brokers ?? []).length === 0 && (
                  <div className="identity-empty">还没有代理连接</div>
                )}
              </div>
              <div className="identity-form-row">
                <input
                  placeholder="名字（agent 用它来指认，如 prod）"
                  value={brokerName}
                  onChange={(e) => setBrokerName(e.currentTarget.value)}
                />
                <select
                  value={brokerKind}
                  onChange={(e) => setBrokerKind(e.currentTarget.value as 'ssh' | 'postgres')}
                >
                  <option value="postgres">postgres</option>
                  <option value="ssh">ssh</option>
                </select>
                <label className="settings-inline">
                  <input
                    type="checkbox"
                    checked={brokerRO}
                    onChange={(e) => setBrokerRO(e.currentTarget.checked)}
                  />
                  只读
                </label>
              </div>
              <div className="identity-form-row">
                <input
                  type="password"
                  placeholder={
                    brokerKind === 'ssh'
                      ? 'ssh 目标（别名或 user@host）'
                      : 'postgres://用户:密码@主机/库'
                  }
                  value={brokerTarget}
                  onChange={(e) => setBrokerTarget(e.currentTarget.value)}
                />
                <button
                  className="settings-btn"
                  disabled={brokerSaving || !brokerName.trim() || !brokerTarget.trim()}
                  onClick={() => {
                    if (brokerSaving) return
                    setBrokerSaving(true)
                    void window.termspace
                      .saveBroker({
                        name: brokerName.trim(),
                        kind: brokerKind,
                        readOnly: brokerRO,
                        target: brokerTarget
                      })
                      .then((r) => {
                        if (!r.ok) return setSaveErr(r.error ?? '保存失败')
                        setBrokerName('')
                        setBrokerTarget('')
                        void window.termspace.getSettings().then(setS)
                      })
                      .finally(() => setBrokerSaving(false))
                  }}
                >
                  {brokerSaving ? '保存中…' : '保存'}
                </button>
              </div>
              <p className="settings-note">
                连接串保存后<b>再也读不回来</b>（没有那条 IPC，这是有意的）。要改就重填一次。
              </p>

              <h3 className="settings-h">在编辑器打开</h3>
              <div className="settings-row">
                <span>编辑器命令</span>
                <select
                  value={s?.editorCommand ?? ''}
                  onChange={(e) => patch({ editorCommand: e.currentTarget.value })}
                >
                  <option value="">不设置（在 Finder 里定位）</option>
                  {editors.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </div>
              <p className="settings-note">
                组头的「在编辑器打开」用它。**只接受这张表里的名字** ——
                名字会被主进程解析成绝对路径再执行，不经过 shell，所以这里不是一个
                能填任意命令的地方。没装那个编辑器时会退回 Finder 并告诉你。
              </p>

              <h3 className="settings-h">数据位置</h3>
              <p className="settings-note">
                画布布局、简报、预设、凭证密文均在
                <code> ~/Library/Application Support/termboard/</code>。
                {/* **别再写"明文不落盘"**：那句话不准。密钥确实是 Keychain 加密存的，
                    但终端起会话时它会以 0600 文件短暂物化（shell source 完当场删），
                    而且最终是以环境变量进程内可见 —— 那个终端里的 agent 读得到。
                    界面上把能力边界说清楚，比说一句好听的更有用。 */}
                凭证由系统 Keychain 加密保存。终端启动时会短暂物化成一个 0600
                文件（读完即删），并以环境变量注入 —— 该终端里的 agent 读得到它。
              </p>
            </>
          )}

          {section === 'remote' && s && (
            <>
              <h3 className="settings-h">远程访问</h3>
              <label className="settings-row">
                <span>开启远程 API</span>
                <input
                  type="checkbox"
                  checked={s.remoteEnabled}
                  onChange={(e) => patch({ remoteEnabled: e.currentTarget.checked })}
                />
                <span className={`status-chip ${remote?.running ? 'running' : 'idle'}`}>
                  {remote?.running ? '运行中' : '未启动'}
                </span>
              </label>
              {/* 开着却没起来必须给原因：只有一个"未启动"的话，端口被占的人无从下手 */}
              {!remote?.running && s.remoteEnabled && remote?.error && (
                <p className="settings-note settings-err">
                  启动失败：<code>{remote.error}</code>
                  {remote.error.includes('EADDRINUSE') &&
                    `　端口 ${remote.port} 被别的程序占了，换一个再重启。`}
                </p>
              )}
              <p className="settings-note">
                开启后手机 / 其他电脑可以看画布、看终端输出、处理审批。改动需重启应用生效。
              </p>

              <label className="settings-row">
                <span>允许远程写入终端</span>
                <input
                  type="checkbox"
                  checked={s.remoteAllowInput}
                  onChange={(e) => patch({ remoteAllowInput: e.currentTarget.checked })}
                />
                <span className={`status-chip ${s.remoteAllowInput ? 'attention' : 'idle'}`}>
                  {s.remoteAllowInput ? '可写入' : '只读'}
                </span>
              </label>
              <p className="settings-note">
                关闭时远程端只能看和审批，不能往终端敲字。写入等于把 shell 交出去，按需再开。
                这一项改完立刻生效。
              </p>

              <label className="settings-row">
                <span>允许远程批准工具调用</span>
                <input
                  type="checkbox"
                  checked={s.remoteAllowApprove}
                  onChange={(e) => patch({ remoteAllowApprove: e.currentTarget.checked })}
                />
                <span className={`status-chip ${s.remoteAllowApprove ? 'attention' : 'idle'}`}>
                  {s.remoteAllowApprove ? '可批准' : '不可批准'}
                </span>
              </label>
              <p className="settings-note">
                和"写入终端"分开控制：批准一次工具调用（可能是 rm -rf / git push --force）
                比敲一行字危险得多。关闭时远程端只能看审批内容，决定权留在这台机器上。
              </p>

              <label className="settings-row">
                <span>端口</span>
                <input
                  type="number"
                  min={1024}
                  max={65535}
                  value={s.remotePort}
                  onChange={(e) => patch({ remotePort: Number(e.currentTarget.value) })}
                />
              </label>

              <label className="settings-row">
                <span>监听网卡</span>
                <select
                  value={s.remoteBind}
                  onChange={(e) =>
                    patch({ remoteBind: e.currentTarget.value as AppSettings['remoteBind'] })
                  }
                >
                  <option value="loopback">仅本机（127.0.0.1）</option>
                  <option value="tailscale">Tailscale 网卡（手机可连）</option>
                </select>
                {remote?.fellBack && <span className="status-chip error">没找到 Tailscale</span>}
              </label>
              <p className="settings-note">
                只有这两个选项，<b>没有 0.0.0.0</b>：这个进程能开终端、读写文件、持有你的
                模型凭证，监听到公共 Wi-Fi 上等于把整台机器交出去。tailnet 是 WireGuard +
                设备认证的私有网络，绑它等于只让你自己的设备看得见这个端口。
                选了 Tailscale 却显示"没找到"，就是 Tailscale 没登录/没启动，
                此时会安全退回仅本机，不会偷偷开到别的网卡上。改动需重启应用生效。
              </p>

              {remote?.running && (
                <>
                  <div className="settings-row">
                    <span>地址</span>
                    <code className="settings-doctor-detail">
                      http://{remote.bind}:{remote.port}
                    </code>
                  </div>
                  <div className="settings-row">
                    <span>配对 token</span>
                    <code
                      className="settings-doctor-detail"
                      title="删除 userData/remote-token 可重新生成"
                    >
                      {remote.token}
                    </code>
                  </div>
                  <div className="settings-qr-row">
                    <PairQR url={remote.pairUrl} />
                    <div>
                      <p className="settings-note">
                        手机扫这个码直接进手机端页面，token 自动带上。
                        {remote.bind === '127.0.0.1' && (
                          <>
                            <br />
                            <b>当前只绑了本机，手机扫了也连不上</b> —— 上面「监听网卡」
                            改成 Tailscale 再重启。
                          </>
                        )}
                      </p>
                      <button
                        className="settings-btn"
                        onClick={() => void navigator.clipboard.writeText(remote.pairUrl)}
                      >
                        复制配对链接
                      </button>
                    </div>
                  </div>
                </>
              )}

              <h3 className="settings-h">只读分享</h3>
              <p className="settings-note">
                发一条<b>只读</b>链接给别人：他能看到画布布局、节点状态和谁在等你，
                <b>看不到终端内容、看不到审批、不能输入</b>。
                默认 24 小时后自动失效，也可以随时单独撤销 —— 这是每条链接一把 token
                （不是共用那把），撤一个不影响别人。
              </p>
              {remote?.running ? (
                <>
                  <div className="settings-actions">
                    <button
                      className="settings-btn"
                      onClick={async () => {
                        setShareUrl('')
                        const r = await window.termspace.issueViewerLink(shareLabel)
                        if (!r || r.error) return setShareUrl(`失败：${r?.error ?? '未知'}`)
                        setShareUrl(r.url ?? '')
                        setTokens(await window.termspace.remoteTokens())
                      }}
                    >
                      生成只读链接
                    </button>
                    <input
                      placeholder="给谁看（可留空）"
                      value={shareLabel}
                      onChange={(e) => setShareLabel(e.currentTarget.value)}
                    />
                  </div>
                  {shareUrl && (
                    <p className="settings-note">
                      {/* token 一生只在这里出现一次，之后主进程只回前 6 位 */}
                      <b>只显示这一次，关掉就看不到了：</b>
                      <br />
                      <code className="settings-token">{shareUrl}</code>
                      <br />
                      <button
                        className="settings-btn"
                        onClick={() => void navigator.clipboard.writeText(shareUrl)}
                      >
                        复制
                      </button>
                    </p>
                  )}
                  <div className="skill-list">
                    {tokens.map((t) => (
                      <div key={t.hint} className="skill-row">
                        <span className="skill-name">
                          {t.role === 'owner' ? '本机' : '只读'} · {t.label}
                        </span>
                        <span className="skill-desc">
                          {t.hint}…
                          {t.expiresAt
                            ? `　${new Date(t.expiresAt).toLocaleString('zh-CN')} 失效`
                            : '　不过期'}
                        </span>
                        {t.role === 'viewer' && (
                          <button
                            className="identity-del"
                            onClick={async () =>
                              setTokens(await window.termspace.revokeRemoteToken(t.hint))
                            }
                          >
                            撤销
                          </button>
                        )}
                      </div>
                    ))}
                    {tokens.length === 0 && <div className="identity-empty">还没有发出去的链接</div>}
                  </div>
                </>
              ) : (
                <p className="settings-note">远程访问没开，先打开上面的开关并重启。</p>
              )}

              <h3 className="settings-h">怎么从外面连</h3>
              <p className="settings-note">
                装 <code>Tailscale</code>（WireGuard + 设备认证），手机加入同一个 tailnet，
                上面「监听网卡」选 Tailscale，重启后扫码即可。走蜂窝网也一样能连。
                <br />
                手机端页面就是这台机器发的（<code>/</code> 路由），API 请求头带
                <code> Authorization: Bearer &lt;token&gt;</code>。
                怀疑 token 泄露就删掉 <code>userData/remote-token</code> 重启，会重新生成，
                旧手机随即失效。
                <br />
                注意 tailnet 里被共享进来的其他人的设备也能打到这个端口 —— 真要隔离，
                在 Tailscale 后台用 ACL 限制到你自己的设备。
              </p>

              <h3 className="settings-h">离开电脑时通知我</h3>
              <label className="settings-row">
                <span>推送地址</span>
                {/* 草稿同 updateFeedUrl：边打字边提交会把半截 URL 存成"不合法"清空 */}
                <input
                  type="text"
                  value={notifyDraft ?? s.notifyUrl}
                  placeholder="https://ntfy.sh/你自己起的一串随机字"
                  onChange={(e) => setNotifyDraft(e.currentTarget.value)}
                  onBlur={() => {
                    if (notifyDraft === null || notifyDraft === s.notifyUrl) return setNotifyDraft(null)
                    void window.termspace.setSettings({ notifyUrl: notifyDraft }).then(
                      () => {
                        setNotifyDraft(null)
                        setNotifyMsg('')
                      },
                      (e) => {
                        setNotifyDraft(null)
                        setSaveErr(String((e as { message?: string })?.message ?? e))
                      }
                    )
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur()
                    if (e.key === 'Escape') setNotifyDraft(null)
                  }}
                />
              </label>
              <label className="settings-row">
                <span>什么时候推</span>
                <select
                  value={s.notifyLevel}
                  onChange={(e) =>
                    patch({ notifyLevel: e.currentTarget.value as AppSettings['notifyLevel'] })
                  }
                >
                  <option value="attention">只在 agent 等你时（要批准 / 有问题）</option>
                  <option value="all">再加上「跑完了」</option>
                </select>
              </label>
              <div className="settings-row">
                <span>连通性</span>
                <button
                  className="settings-btn"
                  onClick={() => {
                    setNotifyMsg('发送中…')
                    void window.termspace
                      .notifyTest(notifyDraft ?? s.notifyUrl)
                      .then((r) => setNotifyMsg(r.ok ? '已发出，看看手机收到没' : `失败：${r.error}`))
                  }}
                >
                  发测试通知
                </button>
                {notifyMsg && <span className="settings-doctor-detail">{notifyMsg}</span>}
              </div>
              <p className="settings-note">
                填一个 <b>ntfy</b> 或 <b>Bark</b> 的地址（都免费、都能自建、都不用注册）：
                手机装 app 订阅同一个 topic，agent 卡住等你时就会响。
                最省事的是 <code>https://ntfy.sh/</code> 后面接一串<b>你自己编的随机字</b>
                —— 那串字就是密码，别用 <code>termspace</code> 这种能被人猜到的。
                <br />
                <b>推文里只有节点标题和状态</b>（「『前端重构』在等你回答」），
                没有终端内容、没有命令、没有路径、没有你的 tailnet 地址 ——
                这是 app 里唯一主动往外网发东西的地方，而地址那头不是我们的服务器，
                消息会留在别人的库里、也会亮在你的锁屏上。所以给的信息刚好够你决定
                「要不要现在掏手机」，看内容还是得回到上面那个 tailnet 里的页面。
                <br />
                只收 <code>https</code>，留空 = 不通知（默认）。同一个节点同一类事
                一分钟内只推一条。
              </p>

              <h3 className="settings-h">想要完整 PWA（离线壳 / 安卓可安装）</h3>
              <p className="settings-note">
                直连 <code>http://100.x.x.x:7333</code> 不是浏览器认的「安全上下文」，
                Service Worker 根本不存在 —— 所以离线壳和安卓的「安装应用」拿不到。
                <b>iOS 的「添加到主屏幕」不受影响</b>，现在就能用。
                <br />
                要完整 PWA：Tailscale 后台打开 HTTPS 证书，然后跑{' '}
                <code>tailscale serve --bg {remote?.port ?? s.remotePort}</code>，
                改用 <code>https://&lt;机器名&gt;.ts.net</code> 访问。
                这条路还更安全 —— 此时「监听网卡」可以留在<b>仅本机</b>，
                由 Tailscale 从 tailnet 转发到回环，本进程一个对外端口都不开。
              </p>
            </>
          )}

          {section === 'update' && s && (
            <>
              <h3 className="settings-h">更新</h3>
              <label className="settings-row">
                <span>后台检查更新</span>
                <input
                  type="checkbox"
                  checked={s.autoUpdate}
                  onChange={(e) => patch({ autoUpdate: e.currentTarget.checked })}
                />
                <button
                  className="btn-ghost"
                  onClick={() => void window.termspace.checkUpdate()}
                  disabled={upd?.phase === 'checking' || upd?.phase === 'downloading'}
                >
                  立即检查
                </button>
              </label>
              <label className="settings-row">
                <span>更新源</span>
                {/* **这一栏不能每敲一个键就 patch**：主进程的 sanitize 对半截 URL
                    （"h" / "ht" / "https:/"）一律返回空串，而 patch 会把返回值写回
                    state —— 受控 input 当场被清空，逐字键入根本打不完一个地址。
                    敲到 "https://x" 时又会被规范化成 "https://x/"，光标顶到末尾，
                    后面的字符落到斜杠后面。所以本地留一份草稿，失焦时才提交。 */}
                <input
                  type="text"
                  value={feedDraft ?? s.updateFeedUrl}
                  placeholder="https://你的域名/termspace/"
                  onChange={(e) => setFeedDraft(e.currentTarget.value)}
                  onBlur={() => {
                    if (feedDraft === null || feedDraft === s.updateFeedUrl) return setFeedDraft(null)
                    void window.termspace.setSettings({ updateFeedUrl: feedDraft }).then(
                      (next) => {
                        setS(next)
                        /* 用 sanitize 之后的值回填，让用户看见"我填的被改成了什么"
                           （补了结尾斜杠、或者因为不合法被清空）。 */
                        setFeedDraft(null)
                      },
                      (e) => {
                        setFeedDraft(null)
                        setSaveErr(String((e as { message?: string })?.message ?? e))
                      }
                    )
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur()
                    if (e.key === 'Escape') setFeedDraft(null)
                  }}
                />
              </label>
              <p className="settings-note">
                指向一个存着 <code>latest-mac.yml</code> 和 <code>*.zip</code> 的 HTTPS 目录
                （打包产物在 <code>dist/</code>，把这两样传上去即可）。留空则更新功能不工作。
              </p>
              <p className="settings-note settings-err">
                <b>只填你自己的地址。</b>这一栏决定这台机器从哪里取更新包 ——
                填成别人的地址，等于让那个人决定给你装什么。
                <br />
                https 只保证「连上了你填的那台服务器」，不保证那台服务器是可信的。
                最后拦住恶意包的是 macOS 的代码签名校验（候选包必须满足当前 app
                签名导出的要求），但那是最后一道，不该拿它当第一道。
                {s.updateFeedUrl && (
                  <>
                    <br />
                    当前会从 <code>{(() => {
                      try {
                        return new URL(s.updateFeedUrl).host
                      } catch {
                        return s.updateFeedUrl
                      }
                    })()}</code> 取更新。
                  </>
                )}
              </p>
              <p className="settings-note">
                {upd?.phase === 'checking' && '正在检查…'}
                {upd?.phase === 'current' && `已是最新（${upd.version}）`}
                {upd?.phase === 'available' && `发现 ${upd.version}，正在后台下载…`}
                {upd?.phase === 'downloading' && `正在下载 ${upd.version}… ${upd.percent}%`}
                {upd?.phase === 'ready' && `${upd.version} 已下载好，随时可以装。`}
                {/* 查不了就如实说，但不打断 —— 离线、发布源没配都会走到这里 */}
                {upd?.phase === 'error' && `查不了更新：${upd.message}`}
                {(!upd || upd.phase === 'idle') && '还没检查过。'}
              </p>
              {upd?.phase === 'ready' && (
                <>
                  <button className="btn-primary" onClick={() => void window.termspace.installUpdate()}>
                    重启并安装 {upd.version}
                  </button>
                  <p className="settings-note">
                    <b>会关掉这个窗口重开。</b>终端会话本身由 tmux 续存、重开后能接回来，
                    但<b>正在跑的那一轮 agent 对话会断</b>。挑个空档再点。
                  </p>
                </>
              )}

            </>
          )}

          {section === 'peers' && s && (
            <>
              <h3 className="settings-h">派活到别的机器</h3>
              <p className="settings-note">
                在终端里跑 <code>tb ask 机器名:节点id 任务</code>，任务会派到那台机器上
                Termspace 里的那个终端，做完把回答带回来。走的是你已经配好的{' '}
                <code>ssh</code>，<b>不新开任何网络端口</b>。
              </p>
              <label className="settings-row">
                <span>可以派活过去的机器</span>
                <input
                  type="text"
                  value={s.peers.join(' ')}
                  placeholder="mac-mini nas"
                  onChange={(e) =>
                    patch({
                      peers: e.currentTarget.value
                        .split(/[\s,]+/)
                        .map((x) => x.trim())
                        .filter(Boolean)
                    })
                  }
                />
              </label>
              <p className="settings-note">
                空格分隔，填的是 <code>~/.ssh/config</code> 里的主机别名。
                先在终端里跑一次 <code>ssh 机器名</code> 确认免密通了 ——
                要密码的话派活会立刻失败（不会挂在密码提示上）。
                <br />
                这里是白名单不是摆设：别名会原样进 <code>ssh</code> 的参数，
                不限制的话一个像 <code>-oProxyCommand=…</code> 的「机器名」就是本机任意命令执行。
              </p>

              <h3 className="settings-h">接受别的机器派来的活</h3>
              <label className="settings-row">
                <span>允许跨机派活进来</span>
                <input
                  type="checkbox"
                  checked={s.peerDelegate}
                  onChange={(e) => patch({ peerDelegate: e.currentTarget.checked })}
                />
                <span className={`status-chip ${s.peerDelegate ? 'attention' : 'idle'}`}>
                  {s.peerDelegate ? '接受' : '不接受'}
                </span>
              </label>
              <p className="settings-note">
                关着时对面派过来会被直接拒绝。开着时，任务会像你自己敲字一样进到目标终端的
                agent 里 —— 只进<b>正在跑 agent</b> 的终端，普通 shell 一律拒（那等于直接执行命令）。
                这一项改完立刻生效。
              </p>
              <p className="settings-note">
                说清楚边界：能 ssh 进这台机的人本来就有完整 shell 权限，
                所以这个开关和上面的白名单是<b>产品护栏</b>（挡误用、挡 agent 自作主张），
                <b>不是安全边界</b>。别把它当成"对外开放"的依据。
              </p>

              <h3 className="settings-h">对面要装什么</h3>
              <p className="settings-note">
                那台机器上也要跑 Termspace，并在这一页把「允许跨机派活进来」打开。
                入口脚本是它自己生成的（<code>userData/bin/tb-peer</code>），
                你不用手动拷任何东西 —— 本机 ssh 过去直接执行它。
                <br />
                派活是同步等的，最长 4 分钟。超时或断线**不代表任务没跑** ——
                它已经注入进去了，那边多半还在干。所以不会自动重试。
                <br />
                真去重发同一个任务也不会注入两遍：对面按内容记着十分钟，
                重发只会把上次的状态或结果告诉你。想真的重派一次，改一下措辞或等十分钟。
              </p>
            </>
          )}
        </main>
      </div>
    </div>
  )
}

export type { Section as SettingsSection }
