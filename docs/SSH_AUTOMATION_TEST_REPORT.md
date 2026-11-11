# FILEX SSH 全量自动化测试报告

测试日期：2026-11-11
仓库快照：`263a00b` 加当前待发布的 0.1.2 改动
测试主机：Windows x64，FILEX 0.1.2 Tauri 开发构建
远端目标：隔离测试环境中配置的 Linux / OpenSSH 7.4 主机

## 结论

本轮在可用环境中完成了 SSH 主链路、保存资料认证、跳板路由、PTY、SFTP、持久传输、校验、目录比较、监控、三类隧道、隧道规则、终端日志、异常认证和断线重连的自动化验证。

共执行：

- 前端单元测试 50 项，全部通过。
- 浏览器工作台 E2E 15 项，全部通过。
- 真实 WebView2 SSH 冒烟 1 项，通过 9 个阶段。
- Rust 工作区测试 30 项，全部通过。
- 扩展 Tauri/SSH 现场审计 33 项，32 项通过、0 项断言失败、1 项因远端 `ps` 兼容性阻塞。

质量门禁全部通过。当前唯一阻塞是繁忙 Linux 主机上的进程列表/终止能力：产品安全地拒绝过期快照，但在该目标上无法选中并终止审计临时进程。该项属于兼容性与功能可用性缺口，不是主机密钥或凭据安全绕过。

所有密码、凭据引用和私钥内容均未写入报告、日志或普通配置。远端测试写入限定在唯一 `/tmp/filex-audit-*` 目录，测试进程、隧道、资料、日志和临时文件已清理。

## 自动化门禁

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 前端单元测试 | `pnpm test` | 14 个文件、50 个测试通过 |
| TypeScript | `pnpm typecheck` | 通过 |
| ESLint | `pnpm lint` | 通过，0 warning |
| 生产构建 | `pnpm build` | 通过；Monaco/main 大块警告仍存在 |
| 版本一致性 | `pnpm version:check` | 0.1.1 全部一致 |
| 浏览器 E2E | `pnpm exec playwright test e2e/workbench.spec.ts` | 15/15 通过 |
| 真实 SSH E2E | `pnpm test:live-ssh`，连接独立 WebView2 CDP | 1/1 通过 |
| Rust 格式 | `cargo fmt --all -- --check` | 通过 |
| Rust 工作区测试 | `cargo test --workspace --locked` | 30/30 通过 |
| Rust Clippy | `cargo clippy --workspace --all-targets -- -D warnings` | 通过，0 warning |

真实 SSH E2E 实际通过阶段为：工作台可见、快速连接提交、密码提交、SSH 连接、终端标记搜索、无障碍终端树、SFTP 列表、监控采样及运行时诊断。运行时记录到 0 个页面错误、0 个控制台错误、0 个失败请求；字体、固定面板和监控宽度检查通过。

## SSH 功能覆盖

| 领域 | 自动化场景 | 结果 |
| --- | --- | --- |
| 主机信任 | 未知密钥确认、可信密钥连接、伪造指纹判定为 `changed` | 通过 |
| Known Hosts | 从远端真实主机公钥生成 `known_hosts`，预览并导入，结果 `unchanged=1` | 通过 |
| 快速连接 | 临时资料、密码认证、关闭/清理，不落普通配置 | 通过 |
| 保存资料 | 创建密码资料、凭据引用、连接、重复、更新、删除 | 通过 |
| 密码失败 | 错误密码返回 `SSH_AUTHENTICATION_REJECTED` | 通过 |
| 私钥失败 | 缺失私钥文件返回 `SSH_PRIVATE_KEY_FILE_UNAVAILABLE` | 通过 |
| SSH Agent 失败 | 无可用 Agent 返回 `SSH_AGENT_UNAVAILABLE` | 通过 |
| ProxyJump | 保存跳板资料并通过远端 `127.0.0.1:22` 建立多跳会话和 SFTP | 通过 |
| PTY | 100×30 resize、唯一命令输入/输出、终端搜索、无障碍树 | 通过 |
| 生命周期 | 远端 `exit` 后识别关闭，重新探测主机密钥并重连 | 通过 |
| SFTP 浏览 | 根目录、临时目录、远端目录列表和错误路径边界 | 通过 |
| SFTP 编辑 | UTF-8 预览、原子保存、修订号更新、旧修订返回 `SFTP_PREVIEW_CONFLICT` | 通过 |
| SFTP 文件操作 | chmod、重命名、移动、复制、符号链接识别/删除 | 通过 |
| SFTP 目录操作 | 递归目录复制；拒绝直接删除非空目录 | 通过 |
| 传输队列 | 排队、暂停、恢复、完成；文件与递归目录上传/下载 | 通过 |
| 复制取消 | 大文件远端复制请求取消，不残留目标文件 | 通过 |
| 校验 | 本地/远端流式 SHA-256 一致性与字节数比较 | 通过 |
| 目录同步预览 | 有界只读 local/remote 元数据差异预览 | 通过 |
| 系统监控 | 实时主机、CPU、内存、磁盘和挂载采集 | 通过 |
| 网络监控 | 10 个接口、34 个端点、55 条路由 | 通过 |
| 进程监控 | 100 行有界快照及安全字段解析 | 部分阻塞，见缺陷 |
| 本地隧道 | 真实监听、SSH banner 转发、停止监听 | 通过 |
| SOCKS 隧道 | 动态 SOCKS5 CONNECT 到远端 SSH，握手和 banner 成功 | 通过 |
| 远端隧道 | 远端连接经 SSH 回桥到本地 TCP 服务，收到测试载荷 | 通过 |
| 隧道规则 | SQLite CRUD、回环自动启动、停止和规则删除 | 通过 |
| 终端日志 | 禁用门禁、启用、写入、停止、文件内容和字节数检查 | 通过 |

## 主要发现

### P2：繁忙 Linux 主机上的进程拾取与终止不可用

现场测试目标返回 100 条有界进程快照，但进程 CPU、CPU 时间和 RSS 均为空；目标的 `ps` 实现没有按产品预期的 `-o pcpu/time/rss` 输出这些字段。远端实际存在审计启动的 CPU 夹具进程，却未进入快照。

对该 PID 调用终止命令时，产品返回 `PROCESS_SNAPSHOT_STALE` 并未误杀其他进程，说明安全门禁有效。但用户在该环境中无法通过 UI 选中并终止相关进程。即使 `ps` 兼容，当前“按 CPU 排序后截取前 100 项”的策略也会使低 CPU 进程在繁忙主机上无法被选取。

建议后续增加 Linux `/proc` 兼容采集器，或为已确认的目标 PID 提供独立、短时、可复核的身份探测；仍需保留 PID、启动时间和进程名三元校验，不能直接按 PID 发送信号。

### P3：真实 SSH E2E 的启动条件不够健壮

当 `SSH_TEST_HOST` 和密码存在、但 WebView2 CDP 未开放时，`pnpm test:e2e` 会失败，而不是明确跳过或给出启动提示。环境变量还存在 `SSH_TEST-USERNAME` 与测试代码读取的 `SSH_TEST_USER` 命名不一致的问题。

本轮通过独立应用标识 `dev.filex.workbench.e2e` 和 CDP 端口启动隔离实例后，真实 SSH E2E 稳定通过。建议单独定义“CDP live”配置并显式检查 `/json/version`，避免默认质量门禁依赖环境变量偶然状态。

## 未覆盖范围

- 私钥成功认证和 SSH Agent 成功认证未执行；没有为测试主机临时安装授权公钥，只验证了安全失败路径。
- 跨平台远端未执行：本轮实际目标为 Linux，未覆盖 Windows 远端语义、macOS 网络/进程采集和不同 OpenSSH 版本矩阵。
- 原生文件选择器、OS 默认应用外部打开、SFTP 变更确认弹窗的视觉交互未纳入现场 CDP 审计；底层 Tauri command 和主要浏览器 fixture 已覆盖。
- 传输的“活动流中途暂停/取消”仅覆盖排队暂停恢复及远端复制取消；大文件断网续传和跨重启恢复仍需专门故障注入。

## 证据

- 实时终端搜索：[live-ssh-terminal-search-1280x800.png](../test-results/live-ssh-terminal-search-1280x800.png)
- 连接、SFTP 与监控：[live-ssh-connected-files-monitor-1280x800.png](../test-results/live-ssh-connected-files-monitor-1280x800.png)

![FILEX real SSH terminal, SFTP and monitor](../test-results/live-ssh-connected-files-monitor-1280x800.png)

截图同时展示了目标进程栏的 CPU/内存为空，可作为进程探针兼容性问题的直接证据。
