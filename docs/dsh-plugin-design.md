# dsh-security-audit — DSH Plugin 设计文档

将 cloudflare/security-audit-skill 从"prompt 技能 + 手工沙箱"升级为自治编排的
DSH plugin。设计来源于 hypatia 首次全量审计（run-1）的实践经验。

## 0. 已对齐的决策

| 决策点 | 结论 |
|--------|------|
| 插件形态 | DSH plugin，提供 tools + 面板 UI + 报告渲染 |
| 编排智能 | 引擎通过 **subagent** 执行各阶段读码/判断工作，会话内零逐步交互 |
| UX 目标 | 一句话发起 → 面板看进度 → 结束收报告 |
| 远程主机 | 用户自备 Linux，插件只做 SSH 编排；缺依赖时结构化请求授权安装 |
| 执行位置 | v2 起允许本地 + 远程**混合调度** |
| 沙箱镜像 | 首次使用优先拉取预构建镜像，失败则本地构建并缓存 |
| 上游 skill | **打包进插件**（vendored），不依赖用户 clone |
| 代码出域 | **全局开关**（面板可改），关闭时禁止远程执行位置 |
| 上游兼容 | 产物契约（findings.json / coverage-ledger.json / validator）与上游完全一致 |

## 1. 架构总览

```
┌────────────────────── dsh-security-audit plugin ──────────────────────┐
│                                                                       │
│  Tools 层          audit_start / audit_status / audit_approve /       │
│                    audit_cancel / audit_report                        │
│       │                                                               │
│  编排引擎（宿主侧自治体）                                              │
│    ├─ 六阶段状态机（recon → hunt → validate → output → verify → report)│
│    ├─ ledger 状态机（唯一写者；每次变更自动跑上游 validator）           │
│    ├─ 预算闸门（critic/验证预留，超限 → incomplete，硬性不变量）        │
│    ├─ agent 生命周期策略（timeout → steer → interrupt → fresh retry）  │
│    └─ probe 协议（探测 → 缺口清单 → 逐项请求授权 → 修复 → 重探）        │
│       │                                                               │
│  SandboxDriver 抽象                                                   │
│    ├─ DockerDriver（macOS / Windows，严格配置）                        │
│    ├─ GVisorDriver（Linux，runsc；不可用时回退 runc 并如实声明）        │
│    └─ RemoteSSHDriver（v1.5：远端 docker 或 runsc）                    │
│       │                                                               │
│  UI 层                                                                │
│    ├─ 面板三视图：进度总览 / ledger 表格 / findings 列表               │
│    └─ 报告三形态：findings 卡片 + 独立 HTML 报告 + md/json 产物        │
│                                                                       │
│  vendored：skills/security-audit/（上游规程 md + report-schema +       │
│            两个零依赖 validator，原样打包，只读引用）                  │
└───────────────────────────────────────────────────────────────────────┘
```

原则：**skill 的六阶段流程留在 prompt（vendored md 原样保留），plugin 把"状态、
契约、沙箱"三样 prompt 管不住的东西变成代码。**

## 2. 与上游 skill 的关系

- vendored 副本随插件分发，开箱即用；运行时规程（hunter/verifier/critic
  prompt 模板）从 vendored md 组装，不 fork、不改写。
- 上游更新 = 更新 vendored 目录，编排层代码不动。
- 上游 validator（`validate-findings.cjs`、`validate-coverage-ledger.cjs`）
  是引擎每次状态变更后的自检：校验失败在面板显示为红色错误态（引擎 bug），
  绝不静默重试。
- 产物目录结构与上游契约一致：第三方拿到 run 目录可直接用上游 validator 校验。

## 3. 沙箱抽象层

### 3.1 Driver 接口

```ts
interface SandboxDriver {
  probe(): CapabilityReport;
  // 逐项检查：网络隔离 / scratch 写入 / 资源限制 / wall-clock /
  // 目标所需工具链（rust / node / python / …）
  run(req: ExecRequest): Promise<ExecResult>;
  // ExecRequest: image, cmd, targetMount(ro), scratch(rw),
  //   network: none | loopback | proxy-allowlist,
  //   limits: { cpu, mem, pids, wallClock, fsize }
  promote(files: Allowlist): Artifact[];
  // SKILL.md 的 10 步 race-safe 晋升程序 100% 代码化：
  // no-follow 逐组件、fstat、link count==1、字节上限、独占创建叶子
}
```

### 3.2 后端矩阵

| 平台 | 后端 | 说明 |
|------|------|------|
| macOS | Docker Desktop 严格配置（`--network none` / `--read-only` / tmpfs scratch / 资源 + timeout） | 即 hypatia 审计已验证的 security-audit-sandbox 配置 |
| Windows | Docker Desktop（WSL2 后端） | 大仓库先拷入 WSL 卷，避免 NTFS→9P bind mount 性能问题 |
| Linux | gVisor `runsc` 首选；不可用回退严格配置 runc，capability report 如实记录降级 | |
| 远程 Linux | SSH + 远端 docker/runsc | v1.5；受全局出域开关约束 |

### 3.3 镜像策略

首次使用某工具链变体时：尝试拉取预构建镜像 → 失败则本地构建（分层
Dockerfile：base + rust/python/node 工具链层）并缓存。镜像内容清单（层 +
安装的工具版本）写入 run-metadata——安全工具的沙箱镜像本身应可审计。

### 3.4 probe → 授权 → 修复协议

环境缺口（daemon 未启动、缺 runsc、缺 cargo、远端缺依赖）统一收敛为一个
交互模式：probe 产出**结构化缺口清单** → 每项附带插件自带的声明式安装脚本
（可审计，不允许 agent 现场发挥 shell）→ 用户面板审批 → 执行 → 重探。
沙箱缺席本身不是错误路径：任何控制不齐，相关检查降级 `needs_validation`，
与上游纪律一致。

## 4. 编排引擎

### 4.1 生命周期

`audit_start(target, {profile, budget, scope})` → 返回 `run_id` 并立即结束；
引擎作为宿主侧后台自治体推进六阶段，全程通过 subagent 执行读码与判断工作。
每个 agent 返回 = "落盘 → 归并 ledger → validator → 推进"的事务式更新；
**状态持久化在输出目录**（run-metadata.json / coverage-ledger.json /
findings.json 本就是持久格式），DSH 重启后引擎从磁盘重建并续跑。

### 4.2 用户交互收敛为三类审批（面板推送）

1. 缺依赖安装（probe 协议产出）；
2. 远程/出域授权（全局开关关闭时的远程请求直接拒绝）;
3. 预算超额续期。

其余（波次调度、critic 裁决簿记、降级判定、重试）引擎自治。
SKILL.md 的纪律（scoped 必须声明部分覆盖、预算不足即 incomplete 等）
翻译为引擎不变量，违反即 bug。

### 4.3 Agent 生命周期策略（源自 run-1 教训）

```
agent_timeout → steer（收敛指令）→ interrupt → fresh retry（全新 agent，
不喂前驱不完整结果，保留原 blocker 记录）× max=1 → 判定并落账
```

hypatia run-1 中 critic 卡死、verifier-3 两轮不收敛最终换 verifier-3b 的
现场决策，固化为该可配置策略。

### 4.4 混合调度（v2）

- 编排器只在宿主一处；远程仅是执行位置，远端容器永不接触共享运行文件。
- 代码一致性：本地工作树打 git bundle（以 source_ref 锚定）推远端，两端
  commit hash 一致；agent 只声明"针对 ref X 的 unit Y"。
- unit 派发带能力要求（capability matching）：需要更严隔离/特定工具链的
  unit 只派给满足条件的位置，不满足则排队或降级 needs_validation。
- 每条 observed evidence 记录 `execution_location`，confirmed 项在报告中
  注明验证所在的沙箱类型。

## 5. UI 与报告

### 5.1 面板三视图

1. **进度总览**：六阶段 pipeline + 当前波次 + 活跃 agent 状态；
2. **ledger 表格**：unit × 状态（planned/assigned/covered/candidate/
   deferred/…）× 指纹，可筛选；
3. **findings 列表**：三态 badge + severity + 展开源码追踪链与复现命令。

审批请求（依赖/出域/预算）以面板卡片形式出现并就地批准/拒绝。

### 5.2 报告三形态

- 面板 findings 卡片（交互）；
- 独立 **HTML 报告**（可交付给不使用 DSH 的读者）；
- md/json 产物照旧落盘（REPORT.md / FINDINGS-DETAIL.md /
  NEEDS-VALIDATION.md / findings.json / coverage-ledger.json），
  与上游契约完全兼容。

report 是渲染层不是文件层：从 findings + ledger 直接生成 UI/HTML，
md 为导出物——从根上消除"prose 与 JSON 不一致"（上游反模式 #10）。

## 6. 版本切分

| 版本 | 范围 |
|------|------|
| v1 | 本地 Docker (mac/win) + Linux gVisor/runc 自动选择；单执行位置；probe→授权→修复；ledger/validator/晋升全代码化；面板三视图 + findings UI report + HTML 报告；subagent 编排引擎 |
| v1.5 | 远程 SSH 执行位置（用户自备主机 + 依赖请求式安装）；git bundle 传输；全局出域开关生效 |
| v2 | 混合调度（unit 级能力匹配派发）；远端容器池并行；增量审计向导（复用 prior ledger 的 UI 流程） |

## 7. 未决风险 / 待查证

- DSH plugin 是否支持插件拥有自己的后台 subagent 池并驱动面板实时更新
  （阻塞 v1 骨架，动手前必须查证；若面板只能轮询，则引擎以轮询间隔渲染）。
- 国内网络下拉取预构建镜像的可达性：本地构建回退路径必须始终可用。
- Windows WSL2 路径/性能细节需实测。
- 远端安装脚本需要按发行版（apt/dnf/pacman）分支，脚本集随插件版本更新。
