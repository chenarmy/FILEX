# FILEX

FILEX 是一款面向开发者与运维人员的本地优先、跨平台远程工作台，目标是在一个高密度桌面界面中安全地完成 SSH 会话、SFTP 文件操作、服务器监控与 SSH 隧道管理。

当前仓库处于功能实现与验收阶段，主要代码切片已覆盖 SSH/PTY、SFTP 与持久传输、监控、隧道、备份诊断和 AI 解释/草稿。SSH 私钥、SSH Agent 认证及映射式 `ProxyJump` 已接入；Windows 密码认证真实流已通过主机信任、PTY、终端搜索、SFTP 目录和实时监控验收，私钥/Agent 实时流、隧道实机生命周期及跨平台验收仍未完成。现有 12 条常规浏览器 E2E 和 1 条按凭据启用的实时 SSH E2E 通过。2026-11-05 起，工作台已对齐 FileTerm 风格外壳（顶部会话标签栏、左侧主机监控侧栏、悬浮命令输入条、底部双栏文件浏览器）并新增跟随终端、chmod 权限编辑、多挂载点磁盘、Monaco 编辑器、命令片段分组与专注模式；FTP/FTPS 仍延期。详细状态见 [路线图](docs/ROADMAP.md) 和 [验证记录](docs/VERIFICATION.md)。

## 本地运行

```bash
pnpm install
pnpm dev
```

桌面开发模式：

```bash
pnpm tauri dev
```

质量检查：

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm test:live-ssh
pnpm build
cargo fmt --all -- --check
cargo check --workspace
cargo test --workspace
```

实时 SSH E2E 只在显式提供 `SSH_TEST_HOST` 和 `SSH_TEST_PASSWORD` 时运行；可选 `SSH_TEST_USER`、`SSH_TEST_PORT`，默认使用 `root:22`。测试需要先以本机 WebView2 调试端口启动 Tauri 开发实例。凭据只进入进程环境，不会写入仓库、日志或普通配置。

## 发布与更新

稳定版本通过 `vMAJOR.MINOR.PATCH` Tag 触发发布。版本必须与 `package.json`、Cargo workspace、Tauri 配置和 `Cargo.lock` 一致，`CHANGELOG.md` 必须包含同版本非空说明。

工作流先生成 Windows、macOS 和 Linux 草稿，使用 Tauri 私钥签名安装包与更新产物。正式发布前会验证完整资产集、`latest.json`、平台 URL、Minisign 签名及签名内版本；只有全部通过后 GitHub 才转为 Latest，随后镜像到 CNB。客户端稳定通道优先使用 GitHub；连接失败、非 2xx 或无法解析清单时继续尝试 CNB，成功解析后的清单仍必须通过签名校验，且不会降级为未签名更新。

首次发布的密钥、Actions Secret/Variable、CNB 权限和验收步骤见 [发布与更新运行手册](docs/RELEASE_AND_UPDATES.md)。

## 设计文档

- [产品设计](docs/PRODUCT_DESIGN.md)
- [UI 与交互设计](docs/UX_DESIGN.md)
- [应用架构](docs/ARCHITECTURE.md)
- [AI 助手设计](docs/AI_ASSISTANT_DESIGN.md)
- [发布与更新运行手册](docs/RELEASE_AND_UPDATES.md)
- [交付路线图](docs/ROADMAP.md)
- [第三方声明](THIRD_PARTY_NOTICES.md)

## 设计基线

仓库内置 [gitbx-software-design](skills/gitbx-software-design/SKILL.md) 技能包，用于继承 GITBX 的非业务设计语言、桌面工作台体验、架构边界与质量标准，同时确保 FILEX 不复制 GITBX 的 Git 业务，也不照搬 FinalShell 的品牌或实现。

## 当前范围

首个可用版本聚焦：

- SSH 连接、主机指纹验证、密码、私钥与 SSH Agent 认证，以及映射到已保存直连资料的 `ProxyJump` 路由。
- 多标签 PTY 终端。
- 与会话绑定的 SFTP 文件浏览及后台传输队列。
- 无代理安装的基础服务器资源监控。
- 本地、远程与动态 SSH 端口转发。
- 本地连接配置、系统凭据引用、快捷命令和布局偏好。
- AI 助手：解释已选上下文，支持用户选择本地文本/配置文件（限 12 KiB，发送前尝试脱敏），并生成命令与变更计划草稿；当前不提供工具执行。

RDP、Telnet、云同步、商业加速、批量广播命令与插件市场不进入首版。AI 工具执行仍需完成单独的安全策略与验收后再设计。

## 已实现能力

- 高密度工作台（FileTerm 风格外壳：顶部会话标签栏、可折叠连接栏、主机监控侧栏、终端、悬浮命令输入条、底部双栏文件浏览器、可折叠会话详情、任务抽屉与状态栏；支持专注模式一键收起）。
- Windows 无边框窗口外壳：页面加载完成后再显示，避免黑色空白启动帧；顶部栏可拖动，并提供最小化、最大化/还原和关闭三个按钮。
- 单实例运行：重复打开 FILEX 时只唤醒并聚焦已运行窗口，不创建第二个应用实例。
- 连接列表支持单击选中、双击连接、Enter 连接；Recent 列表仍保持单击连接。
- 上传或下载完成后会自动刷新受影响的本地/远端当前目录；批量完成事件会合并刷新，避免重复加载。
- 默认 14 px 界面字号，内置 HarmonyOS Sans SC Regular/Bold 与许可证，并保留跨平台中文回退字体。
- 悬浮命令输入条（Enter 发送、Shift+Enter 换行、内存态历史）；远端文件支持 chmod 权限编辑与 uid/gid 所有者列、OSC 7 跟随终端、大型目录虚拟滚动，以及 Monaco 编辑器面板（远程/本地文本、语法高亮、查找替换）。
- 深色/浅色/跟随系统主题、中文/英文、界面字号、终端字号等安全设置持久化。
- 连接资料的类型化创建、编辑、复制、删除、校验、搜索、分组、选择和本地持久化。
- Tauri 桌面端使用带版本迁移与事务的 SQLite 资料仓储，应用重启后数据仍然存在。
- 系统凭据库适配器支持 Windows Credential Manager、macOS Keychain 与 Linux Secret Service 状态探测；不提供明文回退。
- 默认 `~/.ssh/config` 的可选择预览导入，支持 HostName、User、Port、IdentityFile 与 ProxyJump，并显式提示模式 Host 和不支持指令。
- 追加式主机信任台账以及未知、可信、指纹已变更三态判定；新指纹不会静默覆盖旧指纹。
- Tauri 命令只经过类型化 API facade；Vue 组件不直接调用 IPC。
- Rust contracts/core/storage/credentials crate、结构化错误、短生命周期秘密租约和无明文凭据的资料模型。
- 基于 `russh` 的主机指纹探测、严格信任判定、密码/私钥/SSH Agent 认证、会话状态机和同一资料重连。私钥口令仅存于系统凭据库；SSH Agent 不向远端转发，`ProxyJump` 仅接受显式映射到已保存直连资料的有界路由。
- 基于 xterm.js 的多标签 PTY、二进制输入输出、窗口尺寸同步、远端关闭和有界滚动缓冲。
- 基于 `russh-sftp` 的远端目录浏览、流式上传/下载、冲突策略、取消/重试、临时文件提交和重启恢复。
- 有界只读系统指标采集，以及带非回环暴露确认的本地、远程和动态 SSH 端口转发。
- 可选 OpenAI 兼容 AI 助手，内置 OpenAI、DeepSeek、Gemini、Kimi、Qwen、智谱、MiniMax、OpenRouter、Ollama 与自定义服务预设；支持独立对话菜单、模型切换、Markdown 回复、上下文抽屉和 360 px 可调面板。API 密钥保存在系统凭据库，解释、命令和变更计划草稿不接入终端执行；用户选择的文本文件仅在本机临时读取，内容不写入聊天历史。
- 分隔面板拖拽、快捷键、脱敏事件控制台、SQLite 备份恢复、隐私受限的诊断导出、带进度与可取消下载的签名更新器、版本/Changelog 发布门禁、跨平台构建及 GitHub/CNB 镜像工作流。实际签名发布与跨平台更新安装验收仍需完成安全配置和发布环境验收。

