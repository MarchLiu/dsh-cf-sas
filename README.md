# dsh-security-audit

[![Publish to npm](https://github.com/MarchLiu/dsh-cf-sas/actions/workflows/publish.yml/badge.svg)](https://github.com/MarchLiu/dsh-cf-sas/actions/workflows/publish.yml)
[![npm version](https://img.shields.io/npm/v/dsh-security-audit.svg)](https://www.npmjs.com/package/dsh-security-audit)

将 [cloudflare/security-audit-skill](https://github.com/cloudflare/security-audit-skill) 从
"prompt 技能 + 手工沙箱"升级为自治编排的 **DSH plugin**。

UX 目标：**一句话发起 → 面板看进度 → 结束收报告。**

设计文档见 [docs/dsh-plugin-design.md](docs/dsh-plugin-design.md)（已对齐的全部决策记录），
DSH 插件 API 调研笔记见 [docs/dsh-plugin-api-notes.md](docs/dsh-plugin-api-notes.md)。

## 目录

```
dsh-cf-sas/
├── package.json            # dsh.bundle 声明
├── cordis.patch.yml        # 插件服务插入层
├── src/                    # 引擎、SandboxDriver、tools、面板渲染（源码）
├── lib/                    # 编译产物（插件实际加载的入口）
├── vendor/skills/security-audit/   # 上游 skill 原样 vendored（只读规程源 + validator）
├── assets/sandbox/         # 沙箱镜像与执行脚本（hypatia run-1 已验证的严格配置）
├── assets/install-scripts/ # probe 缺口的声明式安装脚本（可审计）
└── docs/
```

## 版本切分

| 版本 | 范围 |
|------|------|
| v1 | 本地 Docker (mac/win) + Linux gVisor/runc 自动选择；单执行位置；probe→授权→修复；ledger/validator/晋升全代码化；面板三视图 + 报告三形态；subagent 编排引擎 |
| v1.5 | 远程 SSH 执行位置（用户自备主机）；git bundle 传输；全局出域开关生效 |
| v2 | 混合调度（unit 级能力匹配派发）；远端容器池并行；增量审计向导 |

## 原则

- 上游 skill 原样 vendored、只读引用；产物契约与上游完全兼容。
- 沙箱缺席是正常路径不是错误路径：控制不齐 → 相关检查降级 needs_validation。
- 白名单产物晋升，永不裸拷贝（SKILL.md 的 10 步 race-safe 晋升 100% 代码化）。
- 预算是硬闸门；SKILL.md 纪律翻译为引擎不变量，违反即 bug。
