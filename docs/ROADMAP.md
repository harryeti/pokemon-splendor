# Roadmap / TODO

本文件是新 session 的起点。所有结论都来自 2026-11 的一次只读调研（没有运行任何外部代码），标注"待核实"的地方开工前先确认。

## 背景与目标

- 本仓库是 `Ethan9123/pokemon-splendor` 的 fork（origin: `harryeti/pokemon-splendor`），原生 JS、无构建步骤，联机靠 Cloudflare Worker + Durable Object。
- 用户的使用场景：网页和机器人对战；局域网和朋友联机。
- 参考副本（只读参考，不要在里面改）：
  - `../honey634546-dev/pokemon-splendor`：Node `ws` 房间服务器。
  - `../liyanghh55/pokemon-splendor`：另一套界面（"桌面冒险"主题的来源）。
  - `../Ethan9123/pokemon-splendor`：上游原样。
- liyanghh55 与本仓库的共同祖先是提交 `72ee3ee`。取它的界面改动：
  `git -C ../liyanghh55/pokemon-splendor diff 72ee3ee HEAD -- index.html js/ui.js css/style.css`
- 注意：`gh` 登录的账号是 `tompson-wu`，而 origin 走的是 SSH 别名 `github-personal`（`harryeti`）。读公开仓库没问题，推送前确认用的是哪个身份。

## 总体顺序

1. 局域网联机（honey）→ 2. 多语言 → 3. 多主题机制 → 4. 桌面冒险主题 → 5. 其他 → 6. 测试基线

- 4 依赖 3；2 最好在 3、4 之前（新主题的文字可以直接走 `t()`）。
- 1 与其他项基本独立，只动联机层，且直接服务"局域网和朋友玩"这个最初目标，所以排第一。
- 开工前新建分支，别直接在 `main` 上改。
- `assets/cards/`（卡图的来源、版权、是否进仓库）暂不处理，不在本路线图范围内。

## 已完成

- [x] `wrangler.jsonc`：去掉了原作者的自定义域名 `pokemon-splendor.try-board-game.uk`，`routes` 留空；`workers_dev` 改为 `true`，部署后有 `*.workers.dev` 地址。要用自己的域名时手动加 `routes`（该文件不支持环境变量，所以没法真正参数化）。
  - `test/room.test.js:350,352` 里还有这个域名，但那只是邀请链接解析的样例字符串，不是配置，可以不动。

---

## 1. 局域网联机：评估并合并 honey634546-dev 的 Node 服务器

### 1.0 先评估，再决定合不合（go / no-go）

目标：确认它在局域网场景下真的能用，再动本仓库。评估在参考副本 `../honey634546-dev/pokemon-splendor` 里做，**不要在本仓库里先改**。它是外部代码，按外部代码对待：先读 `package.json`、`package-lock.json`（只应有 `ws`）和 `server/` 全部源码，再 `npm ci`；用于测试的临时脚本放在仓库目录之外。

- [x] 在它自己的副本里跑它自带的测试（`npm test`，重点 `test/server.test.js`、`test/room.test.js`），记录结果。
- [x] 手动起服务（`npm start`），用两个 WebSocket 客户端（浏览器或脚本）验证：建房、加入、开局、走一步、刷新后同 token 回座位、关闭服务再启动后房间快照恢复（`.runtime/rooms/`）。
- [x] 用 `diff` 对比它的 `js/room.js` 和本仓库的，列出本仓库独有的消息和功能（大厅电脑补位 `addAI`/`removeAI`、随机座位、`takeover` 等）。逐项判断服务器是否支持：它没有定时器，预期**电脑座位不会走棋**，这是已知缺口，不算评估失败，但要确认补上调度器的工作量（对照 `worker/index.js:85-125`）。
- [x] 评估是否让服务器同时提供静态文件，并确认 `js/net.js` 拼出的 WebSocket 地址在局域网 IP 访问下可用。
- [x] 把评估结论写进本文件（可用 / 需要改动 / 不建议），再决定走 1.1。
- [ ] ~~**no-go 的备选**：自己写一个很薄的 Node 适配层~~（评估结论为 go，不需要）。

#### 1.0 评估结论（2026-11-04）：**可用，需要改动** → 走 1.1

审查：唯一依赖 `ws@8.21.3`（npm 官方源，lock 里只有这一项）；`server/` 共 220 行，没有可疑代码；房间码限定 `[A-Za-z0-9_-]{1,32}`，快照路径不会被穿越。安装用的是 `npm ci --ignore-scripts`。

在 honey 自己的副本里（Node v26.13.0）：
- 自带测试全部通过：`server`、`room` 16/16、`engine` 17/17、`megas` 8/8、`pokemart` 17/17、`ai`。
- 端到端脚本（放在仓库外的 `/tmp/lan-eval/`）：两个客户端建房、加入、开局、走 6 回合；刷新后同 token 回到原座位；新连接先于旧连接关闭时，座位仍保持在线；停服后快照（`EVAL1.json`）恢复，筹码完全一致；继续打完一局，正常收到 `over`。全部通过。

**换成本仓库的 `js/` + `data/` 再跑**：大厅的 `addAI` 等功能可用（这些全在 `room.js` 里），但轮到电脑时 `aiPending()` 一直是 true，**电脑座位卡住不动**。手动调 `stepAI()` 就能正常走棋。

需要改的地方（都在 `server/` 里，`room.js` 不用动）：
1. `room-manager.js` 构造 `Room` 时没有注入 `ai: require('../js/ai.js')`，要加上。
2. 加走棋调度器：每条消息处理完、每次连接关闭后检查 `aiPending() && humansConnected()`，然后 `setTimeout(AI_TURN_DELAY_MS)` 调 `stepAI(attempt)`，接着落盘，有下一个电脑就继续排。每个房间最多挂一个定时器，按 `seq` 统计重试次数。估计 40–60 行。
3. 落盘的消息列表只有 `join/start/action/takeover`，要对齐 Worker 的 `MUTATING`（补上 `name`、`rematch`、`addAI`、`removeAI`、`aiLevel`、`shuffle`）。
4. 静态文件：目前只有 `/healthz`，其他请求一律 404。要加一个只读的静态文件服务（限定在仓库目录内，只开放白名单里的目录和文件，不暴露 `server/`、`.runtime/`、`node_modules/`）。
5. 默认监听 `127.0.0.1`，局域网用要改成 `0.0.0.0`（或者用 `HOST` 环境变量），启动时打印本机局域网 IP。
6. `js/net.js:62-63` 用的是 `location.host`，和页面同源就能用，局域网 IP 访问没问题，**不用改**。
7. 次要：房间对象只进内存不清理（局域网场景无所谓，可以加空闲回收）。

更正下面 1.1 的一条：「同 token 重连时把旧连接降级」本仓库**已经有了**（`room.js` 的 `_bind`，`conns[previous] = -1`，还会通知旧连接），不需要移植。

### 1.1 合并（评估通过之后）

honey 的改动共 13 个文件（`git -C ../honey634546-dev/pokemon-splendor diff $(git merge-base HEAD up/main) HEAD --stat`）：
`server/index.js`（127 行）、`server/room-manager.js`（93 行）、`test/server.test.js`、`package.json`（唯一依赖 `ws`）、`deploy/`（nginx、systemd，ECS 专用）、`docs/ECS_DEPLOY.md`、`AGENTS.md`、`js/room.js` 小改动等。

**进度（2026-11-04，分支 `lan-server`）**：已合入 `server/`、`package.json`/`package-lock.json`，重写了 `test/server.test.js`（4 项：静态文件白名单、两人对局 + 重启恢复、电脑调度/暂停/恢复/大厅改动持久化、两人加一个电脑打完整局且中途刷新和重启）。全部 15 个 Node 测试套件通过。`.gitignore` 加了 `.runtime/`，`.assetsignore` 加了 `server`、`package*.json`、`.runtime`（不会被发布成 Cloudflare 的静态资源）。只剩真机验收。

**关键风险：honey 基于较旧的上游，缺少本仓库已有的功能。**

- [x] **补走棋调度器（最重要）**（`server/room-manager.js` 的 `armAI`/`_runAI`：没有真人在线时暂停，按 `seq` 统计重试，停服时不再排定时器）：本仓库的 Worker 用 DO 闹钟驱动电脑座位，一个闹钟走一步（`worker/index.js:85-125`，含 `AI_TURN_DELAY_MS`、按回合计数的重试、重复闹钟去重）。honey 的服务器没有任何定时器，合并后联机房间里的电脑座位不会动。需要在 Node 服务器里用 `setTimeout` 实现同等逻辑；先读 Worker 是怎么调用 authority 的（方法名待核实）。
- [x] **超时代打**（和 Worker 一样只是转发 `takeover`，校验全在 `room.js`，`room.test.js` 已覆盖；真机上 3 分钟超时留到最终验收时顺便看）：`room.js` 的 `takeover` 依赖 `this.now`，honey 在 `handle()` 里设置 `authority.now = Date.now()`，这点没问题；但 3 分钟超时的触发仍依赖客户端发 `takeover`，确认房主客户端在局域网场景下正常发起。
- [x] **room.js 重连修复**（已核实本仓库已有，见 1.0 结论）：honey 的修复有两部分。本仓库已有"旧连接晚关闭时不改座位状态"的判断（`room.js:185`），但没看到"同 token 重连时把旧连接降级"（`conns[st.connId] = -1`）这一段。核实后，决定是否移植，并补测试。
- [x] **同源服务静态文件**（白名单方式；默认 `0.0.0.0`，启动时打印局域网地址）：honey 的服务器只处理 WebSocket 和 `/healthz`。局域网用法最好一个端口同时提供静态文件和 `/room/:code/ws`，并默认监听 `0.0.0.0`（honey 默认 `127.0.0.1`），启动时打印本机局域网 IP。
- [x] 核实 `js/net.js` 是怎么拼 WebSocket 地址的（已核实：`location.host`，不用改）（honey 没改它，应该用 `location.host`，同源即可用；待核实）。
- [x] `server/room-manager.js` 构造 `Room` 时传的参数（已补上 `ai`）（`cardDB`、`megaDB`、`pokemartDB`、`maxSeats`、`send`）要对照本仓库当前 `room.js` 的构造函数（`room.js:109`）。
- [x] `test/server.test.js` 按当前 room.js（大厅电脑补位、随机座位）更新。
- [ ] （暂不带入）可选：把 honey 的 `AGENTS.md` 带进来（贡献者约定写得清楚）；`deploy/` 和 `ECS_DEPLOY.md` 是阿里云部署用的，局域网用不上，按需取舍。
- [ ] **验收（需要真机，由用户来做）**：同一局域网两台设备 + 一个电脑座位完整打完一局；中途刷新、断线重连都能回到原座位；停掉服务再启动，房间能恢复。

---

## 2. 多语言（i18n）

现状：没有任何 i18n 框架，界面文字全部写死中文。含中文的行数：`ui.js` 254、`tutorial.js` 77、`engine.js` 105、`room.js` 38、`ai.js` 11、`net.js` 7，另有 `index.html`。`engine.js:1003` 的 "i18n bits" 只是精灵球名、等级名的中文映射。`ui.js:620` 的时间格式写死 `zh-CN`。

**前置：消除"按名字匹配"。** 宝可梦名字既是显示文字又是游戏逻辑的键：

- 进化目标：`engine.js:581`（`byId[a.id].name !== c.evolvesTo`）。
- Mega 原形态：`engine.js:639`（`name === mega.megaFrom`）。
- 数据字段 `evolvesTo`、`megaFrom` 存的是中文名（`data/cards.json`、`data/megas.json`）。
- [ ] 全仓库 grep `.name` 的逻辑用法（`ai.js`、`vsearch.js`、`room.js`、`tutorial.js`、测试），列出清单。
- [ ] 改成按 ID 或图鉴编号匹配；`js/cards.js`、`js/megas.js`、`js/pokemart.js` 是生成文件（标注"勿手改"），先找到生成脚本再改数据（脚本位置待核实）。
- [ ] 改完用现有的引擎、规则一致性、100 局自走测试兜底。

然后：

**已确定的语言**：简体中文（`zh-CN`，现有文字作为源语言）、繁体中文（`zh-TW`）、英文（`en`）、日文（`ja`）。

- [ ] 建 `js/i18n.js`：`t(key, params)`、语言检测、`localStorage` 持久化、同步 `<html lang>`；`index.html` 用 `data-i18n` 属性。
- [ ] 语言检测规则：`zh-TW` / `zh-HK` / `zh-Hant` → `zh-TW`；其他 `zh` → `zh-CN`；`ja` → `ja`；其余 → `en`；用户手动选择优先。
- [ ] 繁体不能只靠简繁自动转换：用词不同（例如 精灵球 / 精靈球 / 寶可夢球 一类的叫法，宝可梦官方译名在大陆和台湾也不同）。单独维护一张 `zh-TW` 表，术语以台湾官方译名为准（待核实具体用词）。
- [ ] 宝可梦名、道具名：按**图鉴编号**建四语言名字表。可以考虑用 PokéAPI 的物种名数据（含 zh-Hans、zh-Hant、ja、en）在开发时生成并提交为静态数据，运行时不联网（待核实数据是否齐全）。
- [ ] CJK 字体：按 `:lang()` 设置各语言的 `font-family`，日文和中文的字形不同。
- [ ] 文字长度：英文、日文通常比中文长，按钮和窄屏布局要逐屏检查（尤其手机、教程气泡、确认弹窗）。
- [ ] 三套教程文字量最大，四种语言都要翻译，需要有人校对（机翻后至少通读一遍规则术语是否一致）。
- [ ] 逐文件抽取中文，优先 `ui.js`、`index.html`、`tutorial.js`。
- [ ] 引擎和 `room.js` 生成的文字（日志、拒绝原因 `reject.reason`）改成"key + 参数"，由界面翻译；联机时服务端发的也要走同样的路径。
- [ ] 宝可梦名、道具名的翻译表。卡面图片上印的文字无法翻译，这点要在文档里说明。
- [ ] 日期、数字用 `Intl`，不要写死 `zh-CN`。
- [ ] 加一个测试：所有语言的 key 集合一致，且没有缺失。
- [ ] `sw.js` 预缓存列表加入新文件（升级缓存版本号）。

---

## 3. 多主题机制

- [ ] `<html data-theme="...">` + 主题注册表（`js/theme.js`），选择存 `localStorage`，开始页放切换入口。
- [ ] 样式拆成"基础样式 + 主题样式"，主题样式按需加载（单独的 CSS 文件）。不要用原生 CSS 嵌套给整个文件加前缀：项目要兼容 iPhone 微信内置浏览器（README 里提过），嵌套支持不够稳。
- [ ] 主题只影响本地显示，联机时各人可以用各自的主题。
- [ ] 教程默认在进入时自动切回经典主题（教程依赖操作栏按钮的选择器）。
- [ ] 先确认 `css/style.css` 是否已用 CSS 变量（`:root`）管理颜色，没有的话先抽出来（待核实）。
- [ ] `sw.js` 预缓存、版本号。

主题命名：**经典**（`classic`，默认）、**桌面冒险**（`tabletop`，来自 liyanghh55 自己的 `TABLETOP ADVENTURE` 标语）。

---

## 4. 桌面冒险主题（来源：liyanghh55）

它不是换皮，而是改了布局和交互。需要手工移植（不能 merge：本仓库的 `ui.js` 比它多了联机恢复、Safari 兜底、保留按钮状态等后续修复）。

**index.html**
- [ ] 开始页的 `setup-shell` / `setup-hero` 结构；经典主题下用 CSS 隐藏 hero，保持原样。
- [ ] 大厅的 `lobby-shell` / `lobby-hero`。
- [ ] `#zoom` 里新增 `#zoom-info`；新增 `#confirm-modal`。

**ui.js：按主题分支的函数**（行号是本仓库当前的）

| 函数 | 行 | tabletop 的变化 |
|---|---|---|
| `cardHTML` | 655 | 卡旁的"捕捉/保留"按钮（`sideActions`）|
| `renderMyResources` | 689 | 单人局固定显示人类玩家 |
| `renderField` | 729 | 牌堆用 `deckHTML`（带"盲抽保留"按钮）、特殊牌堆计数 |
| `renderSupply` | 923 | 供应区底部的已选球 + 确认/取消栏 |
| `renderActionBar` | 977 | 主阶段变成只读摘要；进化面板改版 |
| `renderPlayers` | 1077 | 固定高度玩家栏 + 悬停详情；保留卡的"捕捉"按钮 |
| `onSupplyClick` / `onCardClick` / `onDeckClick` | 1153–1165 | 不再自动聚焦操作栏；有悬停设备时点击不选卡 |
| `setupZoom` | 1662 | 悬停详情面板（含费用、进化信息）|
| 事件委托 | 1857–1899 | `#supply`、`#field`、`#inspect`、`#action-bar`、`#players` 的新按钮 |
| 新增 | – | `confirmOperation`、`runConfirmed`、`confirmCardAction`、`confirmDeckReserve`、`confirmTakeBalls`（所有操作二次确认）|

- [ ] **移植时必须保留本仓库独有的逻辑**：`reserveState(loc, p)` 和保留按钮的禁用原因（`renderActionBar` 里 1032–1044）、`escapeHTML`、`netDot`、`netReady()` / `UI.net.pendingAction` 的联机状态。liyanghh55 的版本没有这些。
- [ ] 样式：`css/theme-tabletop.css`，来源是上面 diff 的 `css/style.css` 部分（约 +528 行）；注意有些是修改基础样式的行，不只是新增。
- [ ] 联机时二次确认弹窗与 `UI.net.pendingAction`、断线状态的交互要测。
- [ ] 手动验收：两个主题各走一遍——单人对电脑、热座、联机、PokéMart + Mega 扩展、手机窄屏。

---

## 5. 其他

- [ ] README 更新：说明 fork 来源、局域网联机用法、主题切换。
- [ ] 其他 fork 里可借鉴的想法（没有核实质量，只当参考）：
  - `primabrucexu/pokemon-splendor`：房主踢人功能（`js/room.js`、`js/ui.js`）。
  - `yaindrop/pokemon-splendor`：全员同意的悔棋、一屏布局、Playwright 回归测试。它已改写成 TypeScript monorepo，无法合并，且改过 `data/cards.json`（内容未核对）。
- [ ] 用户自己想做的其他优化（待补充）。

---

## 6. 测试基线（放在最后）

- [ ] 跑全部现有测试：`node test/engine.test.js`、`room.test.js`、`ai.test.js`、`megas.test.js`、`pokemart.test.js`、`rules_conformance.test.js`、`invariants.test.js` 等（README 有完整列表）。
- [ ] 前面各阶段加的测试（服务器、i18n key 一致性等）一并纳入。
- [ ] 如果有失败，用 `git stash` 或检出 `main`，在改动前的代码上再跑一次，区分"原本就失败"和"我们改坏的"。因为基线放在最后，这一步不能省。
- [ ] 手机端、联机端到端的 Python Playwright 测试（`test/*.py`）需要额外环境，按 README 说明单独跑。

## 已决定

1. 多语言：简体中文、繁体中文、英文、日文。
2. 局域网联机的 Node 服务器和 Cloudflare Worker 两条路径都保留，共用 `js/room.js`；改 `room.js` 时两边都要测。
3. honey 的改动合并前先做 1.0 评估。
