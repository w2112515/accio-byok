# Accio BYOK：实施结果与验收

## 1.4.1: Connection and recovery clarity / 状态与恢复体验已打磨

2026-10-01. The approved follow-up is implemented and verified locally, preserving the existing design. Current-connection evidence is isolated; capability checks older than 30 days prompt manual review; the latest completed snapshot captured with Accio closed is read from disk. Version 1.4.1 is distributed as a [public preview](https://github.com/w2112515/accio-byok/releases/tag/v1.4.1), with a Windows x64 installer, portable executable and SHA-256 checksums. Real-account acceptance stays pending.

### Changes / 改动

- **连接归属：**旧版 1.4.0 便携包已在隔离目录复现：同一供应商记录更改地址、模型不变后，仍展示旧请求成功与 94% 上下文占用。现在请求在发起时记录连接身份；上下文、最近请求、首次接入验证及用量快照只使用匹配连接的数据。变更后等待新请求，名称、备注及价格编辑保留匹配记录，历史日志不删除。
- **旧配置兼容：**实际表单复核暴露了“省略默认选项”与“显式填写默认选项”被误判成不同连接的问题。现按相同默认行为计算身份，手动复核成功后当前表单记录立即更新，首页提醒同步清除。API Key 模式始终包含 Key 的变化，OAuth 刷新则保持同一授权连接身份。无法匹配新身份的旧记录不当作当前验证，必要时手动重新检测。
- **检测复核：**超过 30 天的成功记录显示“曾通过 · 建议复核”，保留原日期与结果；这是提醒期限，不是服务失效判定。首页“复核检测”直接打开、展开并定位相关记录。切换前也提醒缺少近期多轮工具证据，不自动发请求或强制重测。
- **备份时间：**首页与会话备份页显示落盘快照的实际时间和所属账号，重启后保留。摘要只表示各账号中最新一份关闭 Accio 后的快照，明确其他账号可能更早或尚无备份；超过七天提示按近期工作复核。等待关闭、读取失败、没有快照及已经完成分别展示，开启自动计划不冒充备份成功。
- **首页表达：**将最近请求、备份时间与上下文依据放在同一现有卡片内；错误和操作可以换行。连接说明兼容 Key 与 OAuth，保留原导航、色彩和组件。

### Verification / 验证

- Existing 48 tests passed. After the final identity-normalization fix, the 11 affected proxy/security checks passed again. Type checking and the final build passed. No new test suite, dependency or framework was added.
- 原有 48 项检查通过；最终连接身份修正后复验相关 11 项代理与安全检查，全部通过。类型检查、构建及打包通过；没有新增自动化测试套件或依赖。前端体积警告保留，未扩展为性能重构。
- Isolated Electron runs reproduced the old defect and verified endpoint/key changes, preserved metadata-only edits, stale check/backup reminders, and backup read failures. The stale reminder walkthrough caused zero new mock-provider generation requests. Fixture dates were adjusted only in the isolated directory; the system clock and real account data were unchanged.
- 实际便携包完整走通：重启读取加密配置及连接身份 → 读取磁盘备份时间 → 由首页进入复核 → 点击工具多轮及文本检测 → 表单记录即时更新、首页旧提醒消失 → 新建备份更新时间 → 改连接后旧状态隐藏 → 新代理请求 HTTP 200 后显示匹配上下文。历史日志保留；默认诊断未包含合成提示词、测试 Key 或连接指纹。
- 已检查 980×660 中英文首页、备份状态和检测表单，按钮可达、重要提示可读。备份目录读取失败明确报错，未显示成“尚无备份”；恢复测试目录后最终便携包重新读取成功。这不等同于真实 Accio 打开恢复会话的验收。
- Final artifacts are in `release/1.4.1`. The extracted installer `app.asar` matches `win-unpacked`; all six packaged build files match the final build, package version is 1.4.1, and `SHA256SUMS.txt` records both executables. The final portable walkthrough completed after the last source change.

真实 OAuth、账号资格、付费调用、真实 Accio 恢复后继续工作、Windows 覆盖安装和登录自启仍待单独验收。安装器本轮核对内容一致性，没有执行安装。1.4.1 公开测试版包含 1.4.0 功能与 1.4.1 打磨，Release 提供安装版、便携版及校验文件；发布不改变上述验证边界，本地模拟服务已结束。

## 1.4.0: Local delivery verified / 本地交付已验证

2026-10-01. The approved six-part implementation was completed for local delivery, preserving the current English-first bilingual design and Electron/proxy/session architecture. At the user's direction, this round covered implementation and local simulation; real accounts will be verified separately. Version 1.4.0 was not published separately; these changes are included in 1.4.1.

已按确认的完整方案完成六项能力，并保留现有前端设计、英文优先双语界面和技术栈。依用户后续限定，本轮完成实现与本地模拟验证，真实账号稍后验收。1.4.0 当时仅本地交付，没有单独发布；相关改动现已包含在 1.4.1 中。

### Implemented / 已实现

1. **Provider access / 供应商接入：**保留既有 API 与中转入口；新增 OpenAI 官方 ChatGPT 授权和 OpenRouter OAuth，以及独立的 Kimi Code、MiniMax、GLM、百炼订阅 Key 入口和适用范围提示。授权凭据在主进程加密存储，官方凭据限定官方地址；新授权校验成功后才替换旧状态。订阅渠道需确认适用范围，不代表所有 Accio 任务均获供应商许可。
2. **Connection evidence and switching / 连接证据与切换：**文本、工具、图片、多轮工具结果分别检测并记录；连接或模型变化后相关证据失效。可标记备用连接，切换前查看数据接收方、费用与能力差异，只影响后续请求；不重放在途请求或自动切入付费渠道。
3. **Context and diagnostics / 上下文与诊断：**展示上游实际用量或明确标注的文本估算、窗口来源与核对日期、80% 阈值提示，以及缓存读写用量和可定位的错误。未知值保留未知；估算不保证覆盖图片、音频及不透明推理内容，也没有暗中裁剪历史或接管 Accio 原生压缩。
4. **Billing and provider usage / 计费与额度：**区分 API、订阅与本地请求，只有 API 请求进入 API 费用估算及定价覆盖率。支持公开接口提供的额度或余额快照，其余引导供应商控制台。MiniMax 未说明单位的字段按原名展示，不推测 token 数或重置时间；百炼订阅入口按已核对限制禁用 API 探测。
5. **Session recovery / 会话恢复：**可选每日自动备份变化账号，每账号保留 1–30 份自动快照，保留手动和保护备份；失败后等待 15 分钟再尝试。恢复与迁移前展示范围及风险，在暂存副本校验 SHA-256 和 SQLite，写入要求 Accio 关闭并建立保护备份；未知结构停止，不全局替换正文中的账号数字。
6. **Updates and maintenance / 更新与维护：**查询发布说明和预览版状态，依据发布摘要校验下载，显式触发安装并保存配置备份。配置恢复要求版本一致，保留当前配置并重置自动启动、自动备份及代理选择供复核，不恢复 OAuth 凭据。诊断先预览后本地导出，默认不含会话，最多三段会话需显式选入并复核隐私内容。

### Verification / 实际验证

- **Checks:** all 48 tests, TypeScript checks and the final package build passed. Ten focused tests were added to the 38-test baseline for authorization, credential boundaries, verified downloads, diagnostic redaction, usage isolation, and recovery. No new test framework or runtime dependency was added.
- **定向检查：**最终 48/48 通过，类型检查及打包通过。针对授权回调、令牌刷新与账号校验、凭据地址隔离、摘要校验、诊断脱敏、额度隔离、配置恢复及快照损坏等高风险行为补充最小验证；没有新增测试框架或运行时依赖。
- **Packaged runtime:** isolated Electron and portable runs passed text, tool, image and tool-result round trips against a local mock provider, and an actual local proxy request returned HTTP 200. The final portable reopened encrypted credentials and four saved capability checks after restart. Restored fixture sessions were readable through the app; SHA-256 integrity and account counts were confirmed. Default diagnostics excluded the synthetic key, prompt and private name. A real read-only release query correctly reported the published 1.3.0 preview as older than this local build.
- **运行与界面：**本地模拟供应商配合真实 Electron 和便携包验证四类检测、实际代理请求、加密配置跨进程读取、恢复后的测试会话读取、诊断隐私边界及更新查询。所有应用与 Accio 数据均位于隔离目录。已检查 980×660 下中英文界面、授权表单、上下文来源/日期与 94% 用量提示、恢复预览和维护操作；没有把模拟供应商结果写成真实服务兼容结论。
- **Billing:** a separate three-request fixture confirmed that API, subscription and local requests were counted separately, with only the API request entering estimated cost and pricing coverage.
- **Packages:** installer and portable executables are in `release/1.4.0`, with `SHA256SUMS.txt`. The installer's extracted `app.asar` exactly matches `win-unpacked`; all six packaged build files match the final build output, and the package reports 1.4.0. The final portable was run after the last source change. Temporary mock and app processes have stopped.

### Remaining acceptance / 待真实环境验收

Real OAuth sign-in, account eligibility, paid inference, real Accio consumption of restored sessions, Windows upgrade installation and login startup remain untested. Installer payload verification is not an installation test. The installed Accio version was read as 0.33.0.0; this is not broad version-compatibility certification. Existing frontend bundle-size warnings remain. No real account data was modified and no paid inference was performed.

真实 OAuth 登录、账号/套餐资格、付费模型调用、真实 Accio 打开恢复会话、覆盖安装与登录自启尚未实测。安装器内容一致性不能替代实际安装验收；本机读到 Accio 0.33.0.0，不据此声称兼容所有版本。前端包体积警告保留，未扩大为性能改造。原生自动压缩仍属于单独评审范围。本轮没有修改真实账号数据或调用付费模型。

## 1.3.0: English-first bilingual app / 英文优先双语版

2026-10-01. The app defaults to English and offers Simplified Chinese in the top bar and Settings. The same saved preference controls navigation, forms, preset descriptions, date formatting, tray menus, native dialogs, and new app errors. Existing provider names, notes, session content, historical logs, and upstream text keep their original language. No localization dependency was added. The installer offers English and Simplified Chinese independently of the app preference.

软件默认英文，可在顶部或设置中切换简体中文并记住选择。界面、预设说明、日期、托盘、系统对话框与新产生的应用错误使用相同语言设置；不改写供应商名称、备注、会话内容、历史日志或上游原文。没有新增本地化依赖；安装器语言与软件语言独立。

The existing 38 checks, type checking, and builds passed. All 767 English entries had matching interpolation placeholders; representative outbound conversation bodies stayed identical across languages for all four protocols. Isolated Electron runs confirmed the English default and translated validation errors. The final portable package confirmed both language controls, Chinese persistence after process restart, unchanged custom provider names, and readable controls/summary wrapping at 980×660. The installer's app.asar matched win-unpacked, and all six packaged build files matched the final source build. Packages and checksums are in release/1.3.0. No paid models, real Accio restart, or real account writes were used. Actual upgrade installation and login startup remain untested. Historical records below remain in their original Chinese; they are not claims of new verification.

现有 38 项检查、类型检查和构建通过。767 条英文文案占位参数一致，四种协议的代表性出站会话内容在语言切换前后相同。隔离 Electron 实测确认英文默认值和英文校验错误；最终便携包验证两处语言入口、重启后中文选择保留、用户名称不变，以及 980×660 下按钮可见、英文摘要完整换行。安装器 app.asar 与解包目录一致，包内 6 个构建文件与最终源码构建一致；产物及校验值在 release/1.3.0。本轮未调用付费模型、重启真实 Accio 或写入真实账号。覆盖安装与登录自启仍未实测。下方历史正文保留中文，不代表重新验收。

## 1.2.1：审计问题修复

2026-10-01。根据综合审计及用户“同意，开始修复优化”的授权执行。本轮以已复现的五处问题和故障恢复为边界，保留原技术栈、依赖、压缩专项停止条件和第三方接入方式。

### 证据、取舍与行为约定

- 会话迁移：原实现会把正文中的账号数字一并替换。现在只处理已知归属/引用字段和标识路径，正文、标题、工具输入输出、作品内容不参与全局替换；未知引用先停止。沿用暂存、目标保护备份和冲突保留机制，没有设计通用迁移引擎。
- 工具终止：原 Chat/Anthropic/Gemini 在输出上限结束且参数碰巧是合法 JSON 时仍会交付工具。现在统一在正常结束后交付完整工具集合；截断、拒绝、安全结束或取消均不交付待处理调用，不自动重试。
- 空结果：四种协议正常结束却没有可用正文或工具时明确报错；仅思考或空白也不算业务成功，保留已报告用量及可能计费提示。
- 签名：原 Anthropic/Gemini 仅按供应商记录 ID 隔离，编辑同一记录会把旧签名发向新连接。现绑定协议、地址、Key、请求头、模型及记录 ID；旧格式签名舍弃，Responses 既有格式保留。
- 上游明文：远程 HTTP 登录/同步网关现在被设置校验和 HTTP/WebSocket 实际转发边界拒绝，本机 HTTP 保留。升级加载旧地址时仍保留供应商数据，设置页提示修复；没有自动改写地址或要求清空配置。
- 可恢复性：保护状态显示当前并发及本地冷却倒计时，本地拦截记录标明未发送；会话/备份列表读取失败保留错误和重试，阻止旧列表操作。运行验证发现 Accio 插件目录的符号链接会使列表统计失败，现仅列表统计跳过链接目标，实际备份与恢复的链接保护保持不变。

### 改动范围与验证

基线 33/33 通过。新增 5 个聚焦检查，并扩展已有签名、迁移、冷却、配置检查，防止正文损坏、异常工具交付及明文凭据传输；没有新增 UI 测试框架或一般性覆盖率工程。最终为 38/38，类型检查和构建通过；最后的列表链接处理另复验全部 6 项会话检查。前端包体积警告延续之前的约 500 kB 限制，没有扩展为性能改造。

范围仍属于授权的局部修复。因状态需贯穿主进程、共享类型及三个界面位置，且网关校验需同时覆盖配置与实际转发，文件数量预算由 24 调整为 28；行数上限仍为 1,100。无 Git 仓库，使用修复前源码副本对比 src/tests/docs/scripts/README/两个清单文件并运行 supplied-numstat 检查；不将此称为 Git 全仓检查。依赖版本、真实 Accio 文件与真实账号数据均未修改。最终范围计数和打包走查结果见下方追加记录。

### 最终验收

- 本地模拟供应商与真实 Electron 便携版（1.2.1）：短文本请求成功；实时并发显示 1/4，HTTP 429 后显示 3 秒倒计时；下一次检测及本地代理请求被冷却拦截，检测结果与请求日志均有 `notSent`，倒计时到期后消失。全程未调用付费服务。
- 旧远程 HTTP 网关配置：应用正常读入既有供应商，设置页显示明确拦截原因，改为 HTTPS 后可保存；实际 HTTP 转发拒绝由本地代理测试验证。
- 备份恢复交互：隔离应用数据目录将 backups 人为设为文件，实际 IPC 返回读取错误，页面固定显示原因/重试按钮并禁用列表操作。首轮重试发现插件链接导致列表统计失败；修正后重新打包、重新执行同一路径，恢复目录后点击重试，列表恢复并解除禁用。此验证没有创建、恢复或迁移真实账号备份。
- 视觉：已检查并发/冷却卡片、设置页旧网关提示、备份错误页、980×660 总览。冷却在本地计时，未新增供应商轮询。
- 产物：`release/1.2.1/Accio-BYOK-Setup-1.2.1.exe` 与 `Accio-BYOK-1.2.1-portable.exe`。安装器中的 app.asar 与 win-unpacked 一致；其 6 个构建文件与当前 out 逐文件相同，包内版本为 1.2.1。最终便携包已用于上述备份重试复验。校验值见同目录 `SHA256SUMS.txt`。
- 范围：最终指定快照对比为 28 个文件、469 行改动（+383/-86），supplied-numstat 闸门通过，无警告。只有局部修复、针对性断言及交付说明，无依赖或框架变动。原有关于加密请求头跨进程实测、真实 Electron 重定向的 1.2 未验证记录保留，本轮没有将它们冒充为已完成。

### 兼容限制

真实付费供应商、多轮长会话、实际覆盖安装和登录自启未实测。迁移遇到未知结构会停止；含符号链接的账号实际备份仍会拒绝，需要先核对链接内容与备份范围，不能按普通完整备份宣称成功。旧思考签名失效可能影响部分供应商的旧会话续接，可新建会话。请求成功率包含本地拦截，仍表示本地代理收到的请求结果。

以下保留 1.2 和 1.1 历史记录，其中的验证时间和限制不代表本轮重新实测。

## 1.2：中转接入、兼容与安全

2026-09-30。根据用户批准的“更新优化，补足漏洞和兼容，然后加强防封号之类的安全问题”执行。范围是接入入口、Responses 适配、已识别的请求与凭据边界；没有新增依赖、账户登录/轮换系统、代理伪装或外部发布。

### 决策与改动边界

- 接入入口：沿用现有预设和编辑器，增加 CPA、Sub2API、Grok2API、New API、通用中转站，原三个自定义入口合并展示，旧 preset ID 继续识别。旧 OpenAI 配置默认仍是 Chat，新配置可显式选择 Responses。
- 协议：在现有适配器接口内新增 Responses，不重写 Accio 转发层。成熟协议的局部应用，非算法研究。覆盖文本/图片、函数工具结果、加密思考续接、用量与终止；不完整响应不会释放工具调用，不静默忽略自定义停止序列。
- 请求边界：此前本地服务未检查网页来源，上游 fetch 未明确禁止跳转，也没有 429 冷却。局部补充来源与 Host 校验、JSON 类型校验、重定向拦截、4 并发限制、Retry-After 冷却；测试与模型读取复用同一出站保护。无自动重放、无账户切换。
- 凭据：此前自定义请求头以明文落盘，覆盖认证头时未处理大小写。现在复用现有 Windows 加密服务保存独立 encryptedHeaders 字段，在下次保存配置时迁移旧头；读取和编辑保持兼容，错误遮蔽已知凭据。1.1 无法读取新字段，降级边界已写入 README。
- 改动闸门：各模块均为已授权局部修复或新增功能，无结构重写。源文件与必要验证/示例控制在约 1,300 行改动以内；额外涉及 Anthropic/Gemini 的头合并和 SSE 边界，仍属于同一凭据/请求路径。禁止改动真实 Accio 安装、真实会话数据与依赖版本。变更前的 26 项检查通过，并保存源码副本作为回退点。

### 验证与交付

| 项目 | 证据与边界 |
|---|---|
| 定向检查 | 33/33 通过：包含旧有 26 项，以及加密请求头迁移、Responses 续接/截断、本地网页访问、真实本地重定向、冷却和并发释放等 7 项高风险回归检查 |
| 协议与界面 | Electron 中本地模拟网关完成带部署子路径的 Responses 地址整理、文本/工具/图片检测、启用、真实本地代理请求与用量展示；429 后再次检测由本地冷却拦截 |
| 旧配置 | 隔离复制旧版应用配置和配套 Local State，新版 1.2.0 成功读取原加密 Key 并调用本地模拟服务；旧明文请求头保存后为加密字段，文件中不再包含测试原值 |
| 视觉 | 检查五个新入口、浅色/深色、980×660 最小窗口及 125% 内容缩放；底部操作按钮保持可见，长表单滚动 |
| 类型与构建 | 类型检查和构建通过；保留原有超过 500 kB 的前端包体积提示，未扩展到性能重构 |
| 打包 | NSIS 安装包与便携包已生成，保存在 release/1.2.0；1.2 便携包完整界面走查通过（末次协议修正前），报告版本 1.2.0、旧 Key 调用成功，Responses 文本/工具/图片、启用、用量、冷却均通过。重新打包后的安装器内部 app.asar 与 win-unpacked 相同，其主进程/渲染脚本与最终源码构建逐文件哈希一致。SHA256SUMS.txt 提供最终可执行包校验值 |
| 未实测 | 不同 CPA/Sub2API/Grok2API/New API 实例的真实账户与渠道、付费上游、网关自身重试/换号策略、真实 Accio 长会话、覆盖安装与登录自启 |

追加证据：本机 Accio 0.33 的生成调用使用 `Content-Type: application/json`，请求头构造中无网页 Origin，与本次本地校验兼容；这属于源码核对。16 Mi 字符以上的单个 SSE 事件由隔离冒烟确认拒绝。最终隔离配置文件不含测试 Key 或两个测试请求头的明文原值。

额外准备的“重新启动打包版读取刚写入的加密请求头，并在 Electron 中验证 307 重定向”操作被自动审批审核拒绝，只返回 `blocked by policy`，未提供具体原因；没有换方式重试。新请求头已在当前运行中实际加密/解密，跨进程持久化逻辑有定向测试；重定向已通过真实本地 HTTP 的 Node fetch 检查，但上述两个追加的打包版实测保留为未验证。

最终核对官方协议时，将 Responses 的历史助手文本统一为官方支持的简写字符串消息，避免把不完整的输出对象作为下一轮输入；已有续接检查增加相应断言。这是一行请求序列化修正，完成后复验受影响协议、类型、构建并重新打包；界面与网络保护代码未变化，前述完整便携版界面走查发生在该修正之前。

项目没有 Git 仓库，技能的默认 HEAD 改动检查不适用；使用变更前源码副本对比并运行 supplied-numstat 范围检查。该结果是指定源码/文档快照范围，不冒充全仓 Git 检查；既有 mock 示例新增 Responses 分支单独审阅。没有新增依赖或变更真实用户数据。

账户是否允许第三方接入及是否受限由服务方决定。这里交付的是凭据、请求和客户端兼容保护，不把“测试通过”写成“保证不封号”。自动压缩仍沿用 1.1 的明确限制。

以下保留 1.1 阶段记录，避免把之前的验证误当作本轮重新实测。

## 1.1：可靠性与接入体验

2026-09-30。用户批准 A–E 阶段后实施，名称确定为 **Accio BYOK**。本轮目标是接入流程连续、状态可核对、失败可恢复；保留 Electron、React、Tailwind、Radix 及现有五个页面，没有新增依赖或外部服务。

## 交付状态

| 阶段 | 结果 | 验收边界 |
|---|---|---|
| A 可靠性 | 已实现配置损坏保护、解密失败提示、端口固定、操作互斥、真实接入状态、等待期限、会话提交前进程检查 | 配置、端口、协议、会话现有测试及隔离超时冒烟通过；未对真实 Accio 任务强制关闭或做故障注入 |
| B 接入体验 | 测试与启用一次提交，成功页保留启动入口；失败保留输入并固定显示结果；网络模式和地址统一提交 | 本地模拟供应商完成地址整理、旧 Key 读取、认证失败、测试启用、真实 HTTP 代理请求与用量展示 |
| C 用量和模型信息 | 费用区分未知、部分与零价；单价绑定模型；缓存按已报告范围统计；模型信息标来源和时间；工具、图片检测分别触发 | 本地协议和费用冒烟通过；检测只证明本次返回，不代表真实供应商完整 Agent 能力 |
| D 压缩专项 | 按停止条件收敛，未集成阈值适配 | 本机 Accio 0.33.0 源码显示实例创建时固定窗口，未找到可用热更新入口；不宣称原生自动压缩已适配 BYOK |
| E 改名与打包 | 统一为 Accio BYOK 1.1.0，保留旧安装和数据身份，提供 NSIS 安装包与便携包 | 旧 1.0 便携版生成的隔离加密配置已由新版读取；安装包实际覆盖安装及 Windows 登录后的自启尚未实测 |

## 已解决的主要问题

- 配置文件不存在才视为首次使用。损坏、权限或格式错误进入恢复状态，禁止覆盖保存和模型接入；显式重建先保存原文件副本。Key 解密失败单独提示，允许重新填写。
- 本次运行使用了备用端口后，“重启代理”固定实际端口；失败不会静默换口。修改端口前要求关闭 Accio，网络设置变更遇到进行中请求或检测会拒绝。
- 已选择模型、启动进程、代理收到请求、一次模型请求成功是不同事实。首页、侧栏、托盘按对应证据显示；空闲不再等同掉线，历史请求不代表当前启动周期已完成验证。
- 设置先校验和应用，成功后保存；失败尝试恢复原网络、端口与自启配置，恢复失败继续明确报告。恢复官方直连失败时保留代理。
- 会话恢复、迁移、备份与删除，以及相关配置和进程操作由主进程互斥。恢复和迁移在提交前重新检查 Accio；数据库准备失败停止写入，提交中出错报告部分完成及保护备份，不显示成功。
- BYOK 响应头等待默认 60 秒；有效上游事件空闲默认 180 秒，可在设置中调整为 30–3600 秒。工具参数流会推进计时，本地下行心跳不会。总时长不强制截断仍在持续输出的请求。
- 测试只保存成功时提交的那份配置。修改地址、Key、模型或参数会使旧结果不再适用；结果注明检测范围与时间。失败信息固定在表单按钮上方，长内容可滚动。
- 加载状态和用量失败会显示原因或重试入口，复制失败不会弹“已复制”。

## 用户路径

首次使用：添加供应商 → 填 Key 和模型 → 测试并启用 → 在成功页启动 Accio → 在 Accio 发一条消息 → 核对总览或用量中的实际模型与结果。

接入已运行的 Accio 会重启并中断任务；界面、托盘及快捷方式入口会提示。已经由本工具启动时，不因尚未收到请求而反复重启。供应商热切换应用于下一条请求，已有请求继续使用开始时的配置与价格。

默认检测为短文本，最多请求 1024 个输出 Token，不额外开启思考。可选工具检测只检查固定工具名与参数，不执行工具；图片检测只发送内置红色方块。每次单独触发并提示可能收费，检测费用不计入 Accio 请求统计。未后台遍历或自动重试付费模型。

请求详情中的“复制脱敏诊断”只包含版本、状态码、耗时、Token 和运行状态，不带 Key、请求头、地址、名称、错误原文或会话正文。另行开启的调试捕获仍可能含会话敏感内容。

## 模型信息与费用口径

官方明确资料、供应商元数据和用户填写分别标注来源和更新时间。自定义模型未确认的窗口、工具或图片能力保持未知；不凭模型名字推断支持。Gemini 的 inputTokenLimit 标为输入上限，不称作总上下文窗口。

已核对的 Claude 官方型号提供窗口、最大输出和参考价格；Anthropic 与 Gemini 可主动读取模型元数据，缓存 5 分钟、最多 20 项。OpenAI 兼容列表通常只有 ID，缺失能力允许依据供应商资料填写。资料支持不等于实测通过。

- [Claude 官方模型资料](https://platform.claude.com/docs/en/models/overview)
- [Anthropic 模型 API](https://platform.claude.com/docs/en/api/models/list)
- [Gemini 模型 API](https://ai.google.dev/api/models)

单价绑定具体默认模型并记录更新时间。切模型保留用户填过的值，但未经核对不会套到新模型；模型映射也不自动沿用默认模型价格。每条日志保留请求开始时的价格快照。

有用量和已知单价的部分才参与估价。未报告用量不当作零，明确填写零价可显示零费用；汇总同时显示完整计价覆盖数。缓存命中比例只统计实际报告缓存读取量的请求，不把其他请求当作零命中。用户取消与失败、成功分开统计。

## 压缩专项结论

授权范围为最多两种接入办法、一个有限原型、八类验收场景，不修改 Accio 安装文件、不引入摘要模型或收费调用；遇到约定停止条件即收敛。

只读核对本机 Accio 0.33.0 的 app.asar/out/main/gateway-worker.js：

1. 模型目录经 qq(model) 提供窗口元数据；本地模型快照存在进程内缓存。
2. AccioProvider（该构建符号 FDt）构造时优先取显式 contextWindow，其次调用 resolveContextWindow，之后存入 _contextWindow。
3. 在该构建中只找到一次 _contextWindow 赋值；公开 getter 返回存储值，未找到可用的运行中更新入口。主模型与自动整理用到的实例都在构造时传入窗口。

据此，改写元数据不足以证明运行中的旧会话会更新预算。已触及“旧会话固化阈值却无可用更新入口”的停止条件，未进入生产适配，也未运行需要该入口的八类真实压缩验收。这里是源码证据及其工程判断，不是压缩效果实测。

当前交付退路：显示窗口来源，切往较小或未知窗口时提醒，超限错误给出在 Accio 整理或新建会话的建议。没有“一键压缩”按钮，也没有后台截断历史、隐藏摘要调用或强制改写思考签名。

后续只有出现可核验的 Accio 配置或更新接口，才值得恢复专项；仍需证明压缩触发、工具多轮续接、思考历史、大小窗口切换、官方往返、未知窗口和接口失败路径，不能用目录修改成功代替效果验证。

## 改名兼容

- 可见品牌、窗口、托盘、通知、安装器与应用快捷方式统一为 Accio BYOK，版本 1.1.0。
- 继续使用原 %APPDATA%/Accio Switch 作为 userData 和 sessionData，保留 app.accio-switch、网络分区、IPC 和配置版本。没有搬动真实用户数据。
- 内部可执行文件保留 Accio Switch.exe，以维持已有自启和快捷方式目标；安装器显示新名称。electron-builder 的 appId 派生 GUID 保持一致，NSIS 的旧快捷方式读取与更名机制保持原样。
- 1.0 便携版在临时目录创建一份 DPAPI 加密配置，新版读取后成功向本地模拟接口请求。未复制或输出真实 Key。
- 现有真实安装没有被覆盖；NSIS 覆盖安装、桌面快捷方式点击和 Windows 重新登录后的自启仍属于未实测范围。

## 验证记录

本轮只使用本地模拟接口和合成材料，未调用付费模型、未重启真实 Accio、未恢复或迁移真实账户。

| 检查 | 结果 |
|---|---|
| 现有测试 | 26/26 通过；包括损坏配置、解密失败、固定端口、流式结束/取消/工具参数、备份保护及迁移 |
| 类型与构建 | npm run typecheck、npm run build 通过；保留现有渲染包大于 500 kB 的体积提示，未为此扩大到性能重构 |
| 请求等待 | 无响应头超时、只有心跳时空闲超时、持续工具参数流成功、客户端取消分别通过 |
| 费用 | 未知用量、部分单价、零价、取消计数和估价覆盖率的隔离冒烟通过 |
| Electron 界面 | 旧配置读取、地址整理、工具/图片检测、401 保留原配置、成功页、代理请求和用量展示通过 |
| 配置恢复界面 | 打包版加载损坏 JSON 后阻止接入与保存；显式重建保留原文副本，代理随后成功启动 |
| 打包 | NSIS 与便携包构建成功；安装器内 app.asar 与最终解包目录哈希一致，主进程及渲染脚本与当前构建一致；新便携版读取旧加密 Key 并完成本地调用 |
| 视觉 | 浅色/深色、980×660 最小窗口、125%/150% Web 内容缩放检查；修复了错误面板被底部按钮挡住的问题 |
| 尚未实测 | 真实供应商的工具与图像质量、真实长会话压缩、强制进程关闭/直连恢复故障、安装覆盖与开机自启 |

会话备份采用 SQLite 在线备份，但跨文件一致性只应在 Accio 已关闭时作为可靠恢复点；迁移仍可能出现部分提交，届时通过保护备份恢复，不承诺全目录事务。文件数校验也不替代内容级校验。

不宣称首次完成时间、缓存收益或成功率提升了某个百分比：本轮没有足够真实业务基线。达到上述交付边界后停止追加工程。

本轮产物保存在 release/1.1.0，SHA256SUMS.txt 提供两个可执行包的校验值。没有发布到外部平台或替换真实安装。
