# AI Native 内核（本地版）

照着抖音 @Simon 林两支视频（《电商 AI Native 的闭环详解》《我用 CEO Agent 把自己给替换了》）重建的**零依赖 Node** 内核。
不是复刻他的代码（他没开源），是照画面上的字段级设计重建的：**数据底座 → 早报 → 台账 → 决策包/决定库 → 判据验收 → Agent 汇报 → CEO 巡视 → 知识沉淀**。

```
node seed.mjs --reset     # 灌一份示例数据（30 张 T 恤设计那套例子）
node server.mjs           # → http://127.0.0.1:8788
```

只要 Node ≥ 22.5（用内置 `node:sqlite`），不用 `npm install`，不用数据库服务。

```
node sync.mjs             # 跑连接器：把真数据写进界面（npm / CSV / GitHub 已通）
```

- **每个功能怎么按 → [调用手册.md](调用手册.md)**
- **真数据怎么接进来 → [对接手册.md](对接手册.md)**

## 版式：接手 `http://127.0.0.1:8899/`（指挥台 · Command Console）

原来那两版（深色「公司运转台」、浅色 Paperclip 风）都换掉了。现在这套是 8899 的脸：

- 深色底 `#06080C` + 两团径向光（蓝 / 橙），卡片是 `rgba(255,255,255,.032)` 的玻璃层
- 顶栏：`AI` 方块 + 页签（总览 / 早报 / 台账 / 决策 / 判据 / 巡检 / 待办，带橙色数字角标）+ 右上「N/N 个 Agent 在岗」
- 总览：`我 · 创始人` 橙卡（等你 N 件）→ 两根 `拍板` / `汇报` 连线卡 → `CEO Agent` 蓝卡（雷达扫描动画）→ 6 张 Agent 卡 → 12 张读数卡
- **扇形连线**：CEO 底部往 6 个 Agent 拉贝塞尔线，线上跑光点。`↑` 汇报流是蓝色粒子，`↓` 派活只有真的有派活的边才有、且是橙色更快；汇报断了（今天没汇报）那条变红。边上带 `↓ 派活 N 件 / ↑ 日报 hh:mm` 小标签
- 抽屉：右侧滑出，`kv` 行 + 底部动作按钮

### 和 8899 最大的区别

| | `:8899` 指挥台 | `:8788` 本内核 |
| --- | --- | --- |
| 数据 | 全硬编码在 `app.js` 的 `DATA` 对象 | `GET /api/state`，每次请求现算 |
| 卡上的数 | 手写的（页脚自认「demo 数据带 DEMO 标记」） | SQLite 里的真实行 |
| 点「立即跑一次」 | `setTimeout` 把按钮改成「完成」 | `POST /api/patrol`，真的写 `patrols` 表并改台账日志 |
| 派活 | 无 | `POST /api/cards`，缺 `done_def` 直接 400 |
| P0 大事 | 无闸门 | 没过决策包 → 403，卡片只给「提请决策」 |
| 验收 | 无 | 交验分离，`verifier == owner` → 403 |
| 判据 | 无 | 未到第 N 天 → 409 |

**一句话：8899 是壳，8788 是骨。现在壳换成它的，骨还是真的。**

### 页面

| 页签 | 内容 |
| --- | --- |
| 总览 | 我 / 拍板 / 汇报 / CEO / 6 个 Agent（带扇形连线）/ 12 张读数卡 |
| 早报 | `一处要看，其余正常` 四行 + 建议块，来源标注 ledger / platform |
| 台账 | 4 列看板 + 卡住单列；`+ 派活` 弹表单（七项必填）；即时搜索 |
| 决策 | 等我定（5 问全展开）+ 决定库 + 搜索 |
| 判据 | 每条判据一卡，规则三档，到点才能读 |
| 巡检 | 六组：P0 欠决策 / 到期没动 / 卡住 / 待验收 / 到点读数 / 没人回 + 「巡一轮」「知识沉淀」 |
| 待办 | 六类聚合，点进去就是那张卡或那个决策包 |

### 动效

| 动效 | 在哪 |
| --- | --- |
| 扇形连线粒子（`animateMotion` 沿贝塞尔路径，蓝=汇报 / 橙=派活 / 红=汇报断了） | 总览 |
| CEO 雷达扫描（`conic-gradient` 旋转） | CEO 卡 |
| 抽屉右侧滑出（`translateX(102%)→0`，`.24s cubic-bezier(.16,1,.3,1)`） | 任意卡片 |
| 卡片 hover 抬 2px + 换底 | 全部 |
| 顶栏页签 active 高亮 + 橙色角标 | 顶栏 |
| toast 弹入 | 所有写操作 |

**没有 DEMO 角标** —— 8899 每个数都挂 `DEMO`，这里一个都没有，因为全是真数。

> 深色那版里做过的「列数 / 密度 / 排班 / 汇报开关」随版式重做一起去掉了 —— 新布局是固定栅格，塞这些开关反而是噪音。要留就说话。

来源：`http://127.0.0.1:3100`（Paperclip，Jingyu Lab 那套），只取版式与视觉语言，数据和逻辑还是本内核的。

## 数据模型

```
cards      台账卡：title(这件事) why(为什么做) deliverable(要交什么)
                   done_def(怎么算完成) level(P0..P3) owner status check_day
decisions  决策包：question(① 要定什么) recommendation(② 它建议什么)
                   cost(③ 代价是什么) scope(④ 批的范围多大) silent_default(⑤ 我不回会怎样)
                   answer(agree|conditional|reject|defer) condition → 有 answer 就进决定库
criteria   判据：batch metric read_day rules_json value verdict(成|中间|不成)
briefs     早报：day headline items_json suggestion source(platform|ledger)
card_log   台账日志：谁在什么时候改了什么（验收失败退回、催办都记）
agents     谁负责，能定到哪一级（P0 我 / P1 CEO / P2 专职 AI）
           + alive(在岗灯) last_run_at next_run_at shift_json(排班) metric_*
reports    Agent 汇报：agent_id day summary payload_json
patrols    CEO 巡视轮次：at round_no actions_json（催办/上报/提验收/催汇报）
kb_entries 知识沉淀：dept title body source_card_id（同卡不重复入）
```

## 服务端强制的六条硬规则

这几条是这个内核和「又一个 todo 应用」的区别，全部在 `server.mjs` 里拦，前端绕不过：

1. **派活必须有 `done_def` 和 `check_day`** → 否则 400 `缺字段：done_def`。「开工前先写怎么算完成」。
2. **交的和验的分开** → 验收人等于负责人直接 403。自己不许验自己。
3. **`review → done` 只能走 `/verdict`** → 状态接口不接受 `done`，必须带验收结论。
4. **没到那一天不许读数** → 409 `还没到第 14 天（现在是第 0 天），不提前找理由。`
5. **决策包 5 问一个不能空；附条件同意必须写条件** → 否则 400。
6. **P0 大事没过决策包不许开工** → 403 `P0 大事：没过我的决策包，不许开工。先提请决策。`
   闸门只认 `agree` / `conditional`，`reject` / `defer` / 「没人回」都不算批过。没过闸的 P0 卡在台账上按钮直接变成「提请决策」，巡检里单列一栏「P0 大事欠决策 → 动不了」。

外加一条软的：**不回 = 不做、不花钱**。没人回的决策包会被巡检列出来，等你 24 小时，不自动执行。

## API（任意 Agent 都能派活 / 读数 / 验收）

```bash
GET  /api/state                       # 全量状态（卡带 gate；含 agents/patrol/reports/kb）
GET  /api/cards/:id                   # 单卡 + 日志
POST /api/cards                       # 派活（缺 done_def 直接拒）
POST /api/cards/:id/status            # todo|doing|review|blocked|cancelled（P0 有闸门）
POST /api/cards/:id/request-decision   # 提请决策：开决策包并挂到卡上
POST /api/cards/:id/verdict           # {verdict:"pass"|"fail", verifier:"S"}
POST /api/decisions                   # 开决策包（5 问必填）
POST /api/decisions/:id/answer        # 我回四种口径之一
GET  /api/decisions/search?q=…        # 翻决定库（提建议前先查）
POST /api/criteria                    # 写判据
POST /api/criteria/:id/evaluate       # 到点读数（未到点 409）
POST /api/briefs/generate             # 生成治理侧早报（规则生成，不调模型）
POST /api/briefs                      # 平台侧早报入库（数据底座推进来）
POST /api/agents/:id/heartbeat        # 在岗灯 + 主指标 + 下次时间
POST /api/agents/:id/schedule         # 排班 [{at,do}]
POST /api/reports                     # Agent 汇报（summary 必填）
GET  /api/reports?agent=&limit=       # 看汇报
POST /api/patrol                      # CEO 巡一轮：催/报/提验收/催汇报，全记录
GET  /api/patrols?limit=              # 今日轮数、出手次数、每轮动作
POST /api/kb/absorb                   # 知识沉淀（幂等）
GET  /api/kb?dept=&limit=             # 翻知识库
GET  /api/export                      # 全量导出 JSON
```

命令行入口 `cli.mjs`（不用起浏览器，`node cli.mjs` 不带参数出全部用法）：

```bash
node cli.mjs state                                    # 今天要你处理什么
node cli.mjs card --title T --why W --deliver D --done DEF --level P1 --owner shop --day 7
node cli.mjs answer --id 3 --answer agree
node cli.mjs read --id 2 --value 16
node cli.mjs report --agent shop --summary "今天干了什么、卡在哪"
node cli.mjs beat --id shop --label "本周销售" --value 322 --extra "4 个店"
node cli.mjs patrol                                   # CEO 巡一轮
node cli.mjs kb                                       # 知识沉淀
node cli.mjs brief                                    # 治理侧早报
```

每个功能一条命令的完整对照（含 curl、计划任务挂法、踩坑）→ **[调用手册.md](调用手册.md)**。

早报两个来源，别混：

| source | 谁生成 | 里面是什么 |
| --- | --- | --- |
| `platform` | 数据底座（要接 SP-API + Printful） | 流量 / 订单 / 评论 / 异常 |
| `ledger` | `brief.mjs`，纯规则 | 到期没动 / 到点该读数 / 没人回 / 卡住 —— 全是台账算得出来的事实 |

`node brief.mjs` 直接跑一次并入库。**治理侧早报不需要模型，也不需要店铺**，装完就能用。

## 要接真实店铺，接在哪

| 环节 | 接什么 | 坑 |
| --- | --- | --- |
| 数据底座 | Amazon SP-API（订单 / 销售流量报表 / 品牌分析）+ Printful API（订单 / 成本 / 物流） | SP-API 要卖家授权 + LWA 应用审核，节奏以天计；品牌分析不是所有站点都有 |
| 早报 | 定时任务读上面四路 → `POST /api/briefs`（接口已留，表已建）；治理侧那四行不用模型，`/api/briefs/generate` 直接出 | 建议必须落到「可执行的下一步」，否则早报会退化成报表 |
| 上品 | 图片生成 + 拼写校验 + 商标检索 → `POST /api/cards` 开卡，人过闸 | 商标检索没有免费靠谱接口，基本要人判 |
| 发货 | Printful 下单回推 + 物流单号回填 | 按需打印的时效和 Amazon 的 shipping 承诺对不上会掉 Buy Box |
| 验收 | 每个环节的 `done_def` 写成可机器判的表达式，谁来判都要能复现 | 这一条写不出可判表达式，说明这件事还不能自动 |

## 当成 skill 用

规程已经封成 `ainative-ledger`（派活与验收的强制规程），任何 Agent 派活 / 交付 / 验收前先加载它：

```
{{SKILLS}}/{{NAME}}\SKILL.md
```

它带七条铁律、三套模板（台账卡 / 决策包 / 判据）、内核调用方式，以及一份反模式清单（「做完了」「大概能行」「先干着看」「反正没人反对」这类说法为什么不算数）。**内核不在时它要求降级成 markdown 台账，而不是不写判据。**

## 明确没做的（别自己骗自己）

- **没有登录和权限系统**。现在是单机单人，`S` / `ceo` / `shop` 只是字符串；P0 闸门靠调用方不自欺。
- **三个平台的 key 还在你手里**。npm / CSV / 通用 JSON 已通；Amazon SP-API、Printful、抖音是闸门桩，没凭证就报「缺 XXX」，给了凭证也只报到「下一步调哪个端点」，不做假成功。
- **没有内置模型调用**。治理侧早报是规则生成的（这也是它能不依赖任何 key 就干活的原因）；要模型润色，在 `cli.mjs brief` 或 `POST /api/briefs` 外面套一层。
- **没有执行器**。派活之后真去改标题、上架、发货这一段没写 —— 要写就得先有平台写权限，而且必须过 P0 闸门。
- **没有内置定时器**。`sync` / 巡视 / 沉淀都是命令，用系统计划任务挂（`对接手册.md` 第 5 节给了 schtasks 和 cron）。
- **没有脱敏开关**。要隐藏店名就在写入 `reports` 之前自己替换。

## 文件

```
db.mjs          schema + 规则求值 + 闸门查询 + 决定库检索 + 日志
seed.mjs        示例数据（--reset 清库重灌）
server.mjs      HTTP + JSON API + 六条硬规则 + 巡视/汇报/沉淀/活动流 + 改名接口
brief.mjs       治理侧早报生成（纯规则，node brief.mjs 直接跑）
sync.mjs        跑连接器 → 写 heartbeat + reports
auto.mjs        全自动循环：拉数 → 判规则 → 开卡/派活 → 巡视
connectors/     连接器（npm / csv / github / http-json / 三个凭证桩）
connectors.json 哪个连接器启用、写到哪个 Agent、参数
automation.json 自动化的档位（off/assist/auto）、规则、阈值
profile.json    组织名 / 我的名字与头像字母 / 有哪些号与店
cli.mjs         终端入口（node cli.mjs 出全部用法，含 me / org / rename / auto）
调用手册.md      每个功能怎么按：CLI + curl + 计划任务 + 踩坑
对接手册.md      真数据怎么接：契约 / 已通的 / 缺凭证的 / 定时
店铺接入.md      开 N 家店：界面/CSV/三家官方API签名/试连/规则
电商落地路线.md   从看数到干活：订单明细→商品维度→判据→早报→闸门
执行器手册.md    真去动店里：抖店写接口 / 决策包闸门 / 幂等 / 审计
watch.mjs        轮询守护（配合 /api/stream 的 SSE 推送做到实时）
自动化手册.md     改名 / 自媒体 / 店铺 / 全自动三档位 / 红线
public/         单页前端（原生 JS，无构建）
ui-*.png        截图
```

---

来源：抖音 @Simon 林（simonlin1212）《电商 AI Native 的闭环详解》《我用 CEO Agent 把自己给替换了》，2026-11。
他那套代码未开源，所有字段与流程来自视频画面与口播转写，见 `../00_工作台/2026-11-16_电商AI-Native闭环/`。
