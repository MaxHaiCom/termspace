/**
 * 远程 API —— 给手机/其他电脑当客户端用，并托管手机端 PWA 静态页。
 *
 * 安全底线，改这个文件前先读一遍：
 * - **只绑回环或 Tailscale 网卡**（见 net-iface.ts）。**绝不绑 0.0.0.0**：
 *   这个进程能 spawn pty、读写文件、持有 Claude 凭证，开到公网/公共 Wi-Fi
 *   等于交出整台机器。
 * - **独立 token**，和 hook/tb 那套分开，可单独撤销。
 * - **默认只读**：写入终端要 settings.remoteAllowInput 显式打开。
 * - 这里**不提供**任何 spawn / kill / destroy / 执行任意命令的路由。
 * - 静态文件走**固定白名单**，不拼路径 —— 从根上没有目录穿越这回事。
 */
import http from 'node:http'
import { join } from 'node:path' // 不整个 import path：处理函数里有个局部变量也叫 path
import { readFile } from 'node:fs/promises'
import { hostAllowed } from './net-iface.ts'
import {
  ensureOwnerToken,
  matchToken,
  redactBoardForViewer,
  type RemoteToken
} from './remote-tokens.ts'

export interface RemoteDeps {
  /** userData 下的 token 文件路径 */
  tokenFile: string
  port: number
  /** 绑定地址，由 resolveBind() 决定。调用方负责保证它不是 0.0.0.0 */
  host: string
  /** 手机端 PWA 的静态文件目录（打包后在 asar 里，fs 能直接读） */
  staticDir: string
  allowInput: () => boolean
  /** 远程能否批准工具调用。和 allowInput 分开：批准一次 rm -rf 比敲一行字危险得多 */
  allowApprove: () => boolean
  /** 画布快照（由 renderer 上报，主进程缓存） */
  getBoard: () => unknown
  listApprovals: () => unknown[]
  decideApproval: (id: string, allow: boolean) => boolean
  /** 抓某终端屏幕文本。before = 从尾部往前跳过多少行（手机端翻历史） */
  peek: (nodeId: string, lines: number, before: number) => Promise<{ text: string; more: boolean }>
  /** 往终端写入（受 allowInput 门控） */
  writeInput: (nodeId: string, text: string) => boolean
}

export interface RemoteApi {
  port: number
  host: string
  /** owner 那把（配对二维码用）。viewer 的另发，见 remote-tokens.ts */
  token: string
  /** token 表变了（签发/撤销）→ 立刻生效，不用重启服务 */
  reloadTokens: () => Promise<void>
  /** 状态/审批有变化时推给所有 SSE 客户端 */
  push: (event: string, data: unknown) => void
  dispose: () => void
}

const NODE_ID = /^[A-Za-z0-9_-]{1,64}$/
const INPUT_LIMIT = 4096
const MAX_CLIENTS = 8

/**
 * 手机端 PWA 的静态资源白名单：路由 → [文件名, content-type]。
 * 用固定表而不是 path.join(dir, req.url) —— 后者要额外防 `..`、防符号链接、
 * 防 URL 编码绕过，而白名单从根上不存在这些问题。
 */
const STATIC: Record<string, [string, string]> = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/sw.js': ['sw.js', 'text/javascript; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
  // iOS 的 apple-touch-icon / 安卓的安装图标都不吃 SVG，必须发 PNG。
  // 重新生成：rsvg-convert -w 180 -h 180 -o mobile/icon-180.png mobile/icon.svg
  '/icon-180.png': ['icon-180.png', 'image/png'],
  '/icon-512.png': ['icon-512.png', 'image/png']
}

/**
 * CSP 不给 'unsafe-inline'：页面的 JS/CSS 全是外链文件（所以 mobile/ 才拆成
 * index.html + app.js + style.css，而不是图省事塞一个单文件）。
 * token 存在 localStorage，一旦同源出 XSS 就等于泄露 token，所以这条不能省。
 */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ')

export async function startRemoteApi(deps: RemoteDeps): Promise<RemoteApi> {
  let tokens = await ensureOwnerToken(deps.tokenFile)
  const ownerToken: string = tokens.find((t) => t.role === 'owner')!.token
  const clients = new Set<http.ServerResponse>()
  const boundHost = deps.host

  /** 认出是谁。**返回主体而不是布尔** —— 只读分享的全部前提就是服务端知道来的是谁 */
  const authed = (req: http.IncomingMessage): RemoteToken | null => {
    const raw = String(req.headers['authorization'] ?? '')
    return matchToken(tokens, raw.replace(/^Bearer\s+/i, ''))
  }

  const json = (res: http.ServerResponse, code: number, body: unknown): void => {
    const s = JSON.stringify(body)
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    })
    res.end(s)
  }

  /** 解析 JSON body。**任何情况下都要 resolve**，否则路由 handler 会永远挂着 */
  const readBody = (req: http.IncomingMessage): Promise<unknown> =>
    new Promise((resolve) => {
      let size = 0
      let done = false
      const chunks: Buffer[] = []
      const finish = (v: unknown): void => {
        if (done) return
        done = true
        resolve(v)
      }
      req.on('data', (c: Buffer) => {
        size += c.length
        if (size > INPUT_LIMIT * 2) {
          // 超限直接掐；destroy 之后不会有 'end'，所以这里就得给答案
          finish({})
          req.destroy()
        } else chunks.push(c)
      })
      req.on('end', () => {
        try {
          finish(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
        } catch {
          finish({})
        }
      })
      req.on('error', () => finish({}))
      // 客户端中途断开时既不会 end 也不一定 error
      req.on('aborted', () => finish({}))
      req.on('close', () => finish({}))
    })

  /** 静态文件：只认白名单，读不到就 404。生产环境在 asar 里，fs 照样能读 */
  const serveStatic = async (res: http.ServerResponse, route: string): Promise<void> => {
    const hit = STATIC[route]
    if (!hit) return json(res, 404, { error: 'not found' })
    try {
      const buf = await readFile(join(deps.staticDir, hit[0]))
      res.writeHead(200, {
        'content-type': hit[1],
        // 页面本体不缓存（改了要立刻生效），静态资源交给 service worker 管
        'cache-control': 'no-cache',
        'content-security-policy': CSP,
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer'
      })
      res.end(buf)
    } catch {
      json(res, 404, { error: '手机端页面缺失（mobile/ 未打包？）' })
    }
  }

  const server = http.createServer((req, res) => {
    void (async (): Promise<void> => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const path = url.pathname

      /* DNS rebinding：攻击者把自己域名解析到本机 tailnet 地址，诱导用户浏览器发同源请求。
         写操作都要 Bearer token（攻击页读不到，因为我们不发任何 CORS 头也不用 cookie），
         危害本就有限；但这条检查五行代码就掐掉一整类问题，顺手做了。 */
      if (!hostAllowed(req.headers.host, boundHost)) {
        return json(res, 421, { error: 'bad host' })
      }

      // 健康检查不需要 token（只回一个固定标识，不泄露任何状态）
      if (path === '/api/ping') return json(res, 200, { ok: true, app: 'termspace' })

      /* 手机端页面本身不需要 token —— 它只是一段公开的前端代码，
         真正的数据全在下面要 token 的 /api/* 后面。页面自己负责引导用户配对。 */
      if (!path.startsWith('/api/')) {
        if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
        return serveStatic(res, path)
      }

      const who = authed(req)
      if (!who) return json(res, 401, { error: 'unauthorized' })
      /* **只读角色靠身份挡，不靠那两个全局开关。**
         开关是"我允许远程输入"，角色是"这个人本来就不该能输入" ——
         两者是不同的东西，混在一起的话，用户为了自己手机方便打开开关，
         就等于把写权限一起给了拿着分享链接的人。 */
      const viewer = who.role === 'viewer'

      // ── 画布快照 ──
      if (path === '/api/board' && req.method === 'GET') {
        if (viewer) {
          /* 只读的人拿到的是**脱敏后的布局**：没有绝对路径、没有审批清单
             （审批摘要里有命令和文件名），两个开关一律报 false —— 他本来就不能写 */
          return json(res, 200, {
            board: redactBoardForViewer(deps.getBoard()),
            approvals: [],
            allowInput: false,
            allowApprove: false,
            role: 'viewer'
          })
        }
        return json(res, 200, {
          board: deps.getBoard(),
          approvals: deps.listApprovals(),
          allowInput: deps.allowInput(),
          allowApprove: deps.allowApprove(),
          role: 'owner'
        })
      }

      // ── 状态推送（SSE）──
      if (path === '/api/events' && req.method === 'GET') {
        /* **只读的人不给实时流。**
           `push()` 推的是**完整**画布快照（含项目 cwd 这类绝对路径）和**完整**审批列表
           （summary 里有命令和文件名）。快照那三条路径（/api/board、/api/approvals、
           /api/terminal）都做了脱敏，唯独这条推送没有 —— 于是同一份数据有两个出口，
           只有一个被守住。这正是项目里出过一次的那个形状（`toPublicApproval` 曾经
           只写在两条外发路径中的一条），在高一层原样重演。

           为什么是 403 而不是"推脱敏版"：手机端本来就是**轮询**不是 SSE
           （EventSource 设不了 Authorization 头，见 CLAUDE.md），
           所以这条路对 viewer 没有任何功能价值，堵死是最省事也最不会再漏的做法。
           真要给 viewer 实时流，得给每个 client 打上角色标签、push 时按角色分发 ——
           那是另一件事，别顺手在这里加半套。 */
        if (viewer) return json(res, 403, { error: '只读访问没有实时推送' })
        if (clients.size >= MAX_CLIENTS) return json(res, 429, { error: 'too many clients' })
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store',
          connection: 'keep-alive'
        })
        res.write(`event: hello\ndata: ${JSON.stringify({ ok: true })}\n\n`)
        clients.add(res)
        // 心跳：中间设备会掐掉静默连接
        const beat = setInterval(() => res.write(': beat\n\n'), 25_000)
        res.on('close', () => {
          clearInterval(beat)
          clients.delete(res)
        })
        return
      }

      // ── 审批 ──
      if (path === '/api/approvals' && req.method === 'GET') {
        if (viewer) return json(res, 200, { approvals: [] })
        return json(res, 200, { approvals: deps.listApprovals() })
      }
      const decide = path.match(/^\/api\/approvals\/([A-Za-z0-9-]{1,64})$/)
      if (decide && req.method === 'POST') {
        /* 必须单独门控。此前只查 token 就放行，而写入终端反倒要开关——语义是倒挂的：
           批准一次工具调用（可能是 rm -rf / git push --force）比敲一行字危险得多。 */
        if (viewer) return json(res, 403, { error: '只读访问不能批准工具调用' })
        if (!deps.allowApprove()) {
          return json(res, 403, { error: '远程审批未开启（设置 → 远程访问）' })
        }
        const body = (await readBody(req)) as { allow?: unknown }
        /* 读 body 是异步的：客户端可以在开关还开着时把请求头发出来、把 body 拖住，
           等用户关掉开关之后再补完 —— 只在读之前查一次等于门形同虚设。 */
        if (!deps.allowApprove()) {
          return json(res, 403, { error: '远程审批已被关闭' })
        }
        const hit = deps.decideApproval(decide[1], body.allow === true)
        return json(res, hit ? 200 : 409, hit ? { ok: true } : { error: '该审批已失效' })
      }

      // ── 终端当前屏文本（只读）──
      const peek = path.match(/^\/api\/terminal\/([A-Za-z0-9_-]{1,64})$/)
      if (peek && req.method === 'GET') {
        /* **终端内容默认不给只读的人。** 屏幕上有路径、邮箱、客户名，
           还可能有粘贴进去的 token —— 而"看一眼谁在等你"这个诉求不需要内容。
           要给的话应当是 owner 逐节点显式开，不是默认全开。 */
        if (viewer) return json(res, 403, { error: '只读访问看不到终端内容' })
        const lines = Math.min(200, Math.max(1, Number(url.searchParams.get('lines')) || 40))
        /* before 上限 4000：capture-pane 只抓 800 行历史，超出部分 sliceScreen 会
           返回空 + more=false，所以这里只需挡住 NaN / 负数 / 天文数字。 */
        const before = Math.min(4000, Math.max(0, Number(url.searchParams.get('before')) || 0))
        const scr = await deps.peek(peek[1], lines, before)
        return json(res, 200, { nodeId: peek[1], text: scr.text, more: scr.more, before })
      }

      // ── 写入终端（默认关闭）──
      const input = path.match(/^\/api\/terminal\/([A-Za-z0-9_-]{1,64})\/input$/)
      if (input && req.method === 'POST') {
        if (viewer) return json(res, 403, { error: '只读访问不能写入终端' })
        if (!deps.allowInput()) {
          return json(res, 403, { error: '远程输入未开启（设置 → 远程访问）' })
        }
        const body = (await readBody(req)) as { text?: unknown }
        // 同上：慢 body 攻击能跨过开关被关掉的那一刻，落笔前必须再查一次
        if (!deps.allowInput()) {
          return json(res, 403, { error: '远程输入已被关闭' })
        }
        const text = typeof body.text === 'string' ? body.text : ''
        if (!text || text.length > INPUT_LIMIT) return json(res, 400, { error: '内容不合法' })
        if (!NODE_ID.test(input[1])) return json(res, 400, { error: '非法节点 id' })
        const ok = deps.writeInput(input[1], text)
        return json(res, ok ? 200 : 404, ok ? { ok: true } : { error: '终端不存在' })
      }

      return json(res, 404, { error: 'not found' })
    })().catch(() => json(res, 500, { error: 'internal' }))
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    /* 只绑回环或 Tailscale 网卡（由 resolveBind 决定）。
       **不要改成 0.0.0.0** —— 见文件头。 */
    server.listen(deps.port, boundHost, resolve)
  })
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : deps.port

  return {
    port,
    host: boundHost,
    token: ownerToken,
    /* 签发/撤销后立刻生效。**不能靠重启服务** —— 撤销一个人要马上断，
       而重启会把所有 SSE 连接一起掐掉，包括用户自己手机上那条 */
    reloadTokens: async () => {
      tokens = await ensureOwnerToken(deps.tokenFile)
    },
    push: (event, data) => {
      const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
      for (const c of clients) {
        try {
          c.write(payload)
        } catch {
          clients.delete(c)
        }
      }
    },
    dispose: () => {
      for (const c of clients) {
        try {
          c.end()
        } catch {
          // 已断开
        }
      }
      clients.clear()
      server.close()
    }
  }
}
