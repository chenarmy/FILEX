# FILEX

FILEX 是一款面向开发者与运维人员的本地优先、跨平台远程工作台，目标是在一个高密度桌面界面中安全地完成 SSH 会话、SFTP 文件操作、服务器监控与 SSH 隧道管理。

当前仓库处于功能实现与验收阶段，主要代码切片已覆盖 SSH/PTY、SFTP 与持久传输、监控、隧道、备份诊断和 AI 解释/草稿。SSH 私钥认证及远程、动态转发已接入；SSH Agent 与 `ProxyJump` 尚不支持。E2E、实时主机和跨平台验收尚未完成，签名发布所需环境变量也尚未配置。详细状态见 [路线图](docs/ROADMAP.md) 和 [验证记录](docs/VERIFICATION.md)。

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
pnpm build
cargo fmt --all -- --check
cargo check --workspace
cargo test --workspace
```

## 设计文档

- [产品设计](docs/PRODUCT_DESIGN.md)
- [UI 与交互设计](docs/UX_DESIGN.md)
- [应用架构](docs/ARCHITECTURE.md)
- [AI 助手设计](docs/AI_ASSISTANT_DESIGN.md)
- [交付路线图](docs/ROADMAP.md)

## 设计基线

仓库内置 [gitbx-software-design](skills/gitbx-software-design/SKILL.md) 技能包，用于继承 GITBX 的非业务设计语言、桌面工作台体验、架构边界与质量标准，同时确保 FILEX 不复制 GITBX 的 Git 业务，也不照搬 FinalShell 的品牌或实现。

## 当前范围

首个可用版本聚焦：

- SSH 连接、主机指纹验证、密码与私钥认证；SSH Agent 尚不支持。
- 多标签 PTY 终端。
- 与会话绑定的 SFTP 文件浏览及后台传输队列。
- 无代理安装的基础服务器资源监控。
- 本地、远程与动态 SSH 端口转发。
- 本地连接配置、系统凭据引用、快捷命令和布局偏好。
- AI 助手：解释已选上下文，支持用户选择本地文本/配置文件（限 12 KiB，发送前尝试脱敏），并生成命令与变更计划草稿；当前不提供工具执行。

RDP、Telnet、云同步、商业加速、批量广播命令与插件市场不进入首版。AI 工具执行仍需完成单独的安全策略与验收后再设计。

## 已实现能力

- 高密度三栏工作台、真实 PTY 终端、文件/监控/会话检查器、任务抽屉与状态栏。
- 深色/浅色/跟随系统主题、中文/英文、界面字号、终端字号等安全设置持久化。
- 连接资料的类型化创建、编辑、复制、删除、校验、搜索、分组、选择和本地持久化。
- Tauri 桌面端使用带版本迁移与事务的 SQLite 资料仓储，应用重启后数据仍然存在。
- 系统凭据库适配器支持 Windows Credential Manager、macOS Keychain 与 Linux Secret Service 状态探测；不提供明文回退。
- 默认 `~/.ssh/config` 的可选择预览导入，支持 HostName、User、Port、IdentityFile 与 ProxyJump，并显式提示模式 Host 和不支持指令。
- 追加式主机信任台账以及未知、可信、指纹已变更三态判定；新指纹不会静默覆盖旧指纹。
- Tauri 命令只经过类型化 API facade；Vue 组件不直接调用 IPC。
- Rust contracts/core/storage/credentials crate、结构化错误、短生命周期秘密租约和无明文凭据的资料模型。
- 基于 `russh` 的主机指纹探测、严格信任判定、密码/私钥认证、会话状态机和同一资料重连。私钥口令仅存于系统凭据库；SSH Agent 与 `ProxyJump` 在运行前明确拒绝。
- 基于 xterm.js 的多标签 PTY、二进制输入输出、窗口尺寸同步、远端关闭和有界滚动缓冲。
- 基于 `russh-sftp` 的远端目录浏览、流式上传/下载、冲突策略、取消/重试、临时文件提交和重启恢复。
- 有界只读系统指标采集，以及带非回环暴露确认的本地、远程和动态 SSH 端口转发。
- 可选 OpenAI 兼容 AI 助手，API 密钥保存在系统凭据库；解释、命令和变更计划草稿不接入终端执行。用户选择的文本文件仅在本机临时读取，内容不写入聊天历史。
- 分隔面板拖拽、快捷键、脱敏事件控制台、SQLite 备份恢复、隐私受限的诊断导出、更新器与 CI/E2E/安装包工作流源码。签名发布及运行验收仍待配置环境后完成。

