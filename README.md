# FILEX

FILEX 是一款面向开发者与运维人员的本地优先、跨平台远程工作台，目标是在一个高密度桌面界面中安全地完成 SSH 会话、SFTP 文件操作、服务器监控与 SSH 隧道管理。

当前仓库已进入 **Phase 1 工程基础阶段**。仓库包含可运行的 Vue 3 工作台、Tauri 2 桌面壳、类型化连接资料纵向切片，以及 Rust contracts/core 边界。SSH、主机指纹和凭据库仍按路线图在后续切片接入；当前版本不会伪装发起真实远程连接。

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

- SSH 连接、主机指纹验证、密码/私钥/SSH Agent 认证。
- 多标签终端和可选分屏。
- 与会话绑定的 SFTP 文件浏览及后台传输队列。
- 无代理安装的基础服务器资源监控。
- 本地、远程与动态 SSH 端口转发。
- 本地连接配置、凭据引用、快捷命令和布局偏好。
- 安全基础完成后的 AI 助手：错误解释、上下文总结、命令草稿和经策略确认的类型化工具。

RDP、Telnet、云同步、商业加速、批量广播命令与插件市场不进入首版。AI 助手已纳入 Phase 6，但在 SSH、凭据、主机信任和操作确认边界完成前不会开放执行能力。

## 已实现的工程基础

- 高密度三栏工作台、终端占位表面、文件/监控/会话检查器、任务抽屉与状态栏。
- 深色/浅色/跟随系统主题、中文/英文、界面字号、终端字号等安全设置持久化。
- 连接资料的类型化创建、校验、搜索、分组、选择和浏览器本地持久化。
- Tauri 命令只经过类型化 API facade；Vue 组件不直接调用 IPC。
- Rust contracts/core crate、结构化错误和无明文凭据的资料模型。

