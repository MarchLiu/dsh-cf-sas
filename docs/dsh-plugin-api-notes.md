# DSH 插件 API 调研笔记（供 dsh-security-audit 插件实现参考）

调研对象：`/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/` checkout，
内部包位于 `node_modules/@deepseek-ai/`（源码为 `lib/*.js` 编译产物 + `lib/types/*.d.ts`）。
以下所有结论均给出文件路径与类型/代码摘录；未在源码中验证的点标注 **[未确认]**。

---

## 1. 自定义服务如何写

### 结论

一个插件包就是**一个普通 ESM 包**，其入口模块（`lib/index.js`）导出 cordis 插件约定的命名导出：

- `apply(ctx, config, ...)` — 插件主体（必需；也可以是类/函数，Loader 会 `unwrapExports` 归一化）；
- `name` — cordis 插件名（可选）；
- `inject` — 依赖的服务名字符串数组（可选，Loader 据此等待依赖）；
- `Config` — Standard Schema（实际用的是 `@deepseek-ai/schemastery`），激活前由 cordis 校验并填 default。

**不需要 TS 预编译**：Loader 只是 ESM `import` 模块并归一化导出形状（`cordis-plugin-loader/lib/types/index.d.ts` 中 `Loader.unwrapExports(exports: any): any`），包只要 `"type": "module"` + 合法的 ESM JS 入口即可。TS 只是包作者自己的开发体验（官方小包把 `.d.ts` 放 `lib/types/`）。

### 证据

- 配置校验走 Standard Schema：`cordis/lib/index.js`
  ```js
  function resolveConfig(runtime, config) {
      const result = runtime.Config["~standard"].validate(config);
      ...
  }
  ```
- 最小范例 `@deepseek-ai/dsh-skill-badge/lib/index.js`（纯 JS、只导出 name/inject/apply，另导出一个 provider 对象）：
  ```js
  const name = "skill-badge";
  const inject = ["skills"];
  function apply(ctx) {
      ctx.skills.registerProvider(() => provider);
  }
  export { apply, inject, name };
  ```
  对应类型 `dsh-skill-badge/lib/types/index.d.ts`：
  ```ts
  export declare const name = "skill-badge";
  export declare const inject: string[];
  export declare function apply(ctx: Context): void;
  ```
- 带配置与多服务注入的范例 `@deepseek-ai/dsh-tool-present/lib/index.js`：
  ```js
  const name = "tool-present";
  const Config = z.object({ maxFiles: z.number().default(8) });
  const inject = ["tools", "fs", "sessionProjections"];
  function apply(ctx, config) { ... ctx.tools.register(defineTool({...})) ... }
  ```
- 服务本身若要在 `ctx` 上暴露命名 API，可用 cordis 的 `Service` 基类（`cordis/lib/types/service.d.ts`）：
  ```ts
  export declare abstract class Service<out T = never> {
      constructor(ctx: Context, name: string);
      ...
  }
  ```
  实际上 DSH 内部服务多为此模式（如 `dsh-tools` 的 `export declare class ToolRuntime extends Service`，`dsh-jobs` 的 `abstract class JobRegistry extends Service`），并通过
  `declare module '@deepseek-ai/cordis' { interface Context { tools: ToolRuntime } }` 做类型增强。
  但插件如果只是注册工具/监听事件，不需要自定义 Service 类，`apply` 内直接操作 ctx 即可。

### 最小骨架（可编译运行）

```js
// lib/index.js  —  "type": "module"
import z from "@deepseek-ai/schemastery";

export const name = "my-plugin";
export const inject = ["logger"];          // 按需
export const Config = z.object({ enabled: z.boolean().default(true) });

export function apply(ctx, config) {
    const log = ctx.logger("my-plugin");
    log.info("started, enabled=%s", config.enabled);
    // 插件自身的清理：返回 disposer 或用 ctx.on('dispose') 语义
    // （cordis fiber 卸载时，apply 返回的 disposer 会被逆序调用；
    //   见 cordis/lib/types/fiber.d.ts 中 Effect/dispose 契约）
    return () => log.info("disposed");
}
```

注意：**不要自己 new 一个 `Service` 注册到 ctx 覆盖内置服务**；同 context 加载第二个同名服务会按 cordis 标准行为抛错（`dsh-jobs/lib/types/index.d.ts` 明说 "loading a second throws, which is cordis' standard duplicate-service behavior"）。

---

## 2. 如何注册自定义 agent 工具

### 结论

- 服务是 `ctx.tools`（`@deepseek-ai/dsh-tools` 的 `ToolRuntime`，`Context.tools: ToolRuntime`）。
- 注册：`ctx.tools.register(definition): () => void`（`dsh-tools/lib/types/index.d.ts:601`）。
- 工具定义用 `defineTool(options): ToolDefinition`（`dsh-tools/lib/types/schema.d.ts:239`）构造，参数 schema 是 dsh 自有的 JSON-Schema 风格 DSL（`ParameterSchemaSpec`：隐式 open object 根，`required: true` 标在属性上）；**每个工具必须声明 `output`**（canonical JSON 输出 schema + `render(args, value): ContentBlock[]`）。

关键类型摘录（`dsh-tools/lib/types/index.d.ts`）：

```ts
export interface ToolDefinition extends ToolSchema {
    readonly output: ToolOutputDefinition;      // { schema: JsonSchemaNode; render(args, value): ContentBlock[] }
    execute(args: unknown, exec: ToolRunContext): Promise<unknown>;
    timeoutMs?: number;                          // 需工具自己 forward exec.signal
    isConcurrencySafe?(args: unknown): boolean;
    presentCall?(args: unknown): ToolCallView | undefined;
    presentResult?(args: unknown, result: ToolResult): ToolResultView | undefined;
}
export interface ToolRunContext extends ToolExecution {
    deferContext(context: UserMessage): void;   // 向 loop 递一条消息
    // ...exec.signal / exec.agent / exec.callId 等
}
```

`ToolOutputDefinition`（同文件）：
```ts
export interface ToolOutputDefinition {
    readonly schema: JsonSchemaNode;
    render(args: unknown, value: JsonValue): ContentBlock[];
    presentationMeta?(args: unknown, value: JsonValue): JsonValue;
}
```

### 范例：dsh-tool-present 的注册代码（摘录 `lib/index.js`）

```js
import { defineTool } from "@deepseek-ai/dsh-tools";

function apply(ctx, config) {
    ctx.tools.register(defineTool({
        name: "present",
        description: "Declare existing files accessible ...",
        parameters: {
            files: {
                type: "array", required: true,
                items: { type: "object", additionalProperties: false,
                    properties: {
                        path: { type: "string", required: true, description: "..." },
                        description: { type: "string" },
                    } },
            },
        },
        output: {
            schema: { type: "object", additionalProperties: false, properties: { ... } },
            render: (_args, value) => [{ type: "text", text: value.files.map(f => `Presented ${f.path}`).join("\n") }],
        },
        async execute(args, exec) {
            const cwd = exec.agent.session.header.cwd;   // 工具内拿 workspace
            ...
            return { turn, files };
        },
    }));
}
```

另有 `dsh-tool-goal`、`dsh-tool-cordis` 等同模式；`dsh-tool-subagent` 里还有 `inject: ["subagents", "jobs", ...]` 并在 apply 里组装工具的写法。工具与 UI 解耦的呈现用 `presentCall/presentResult`（纯函数，回放安全），自定义工具可以完全不写前端。

执行管线（拦截/审计点，对 dsh-security-audit 有用）：`tools/pre-execute`（waterfall，可 allow/deny/ask）、`tools/execute`（around）、`tools/post-execute`（可改/可 block）、`tools/result`（emit，观察终态）——均见 `dsh-tools/lib/types/index.d.ts` 的 `Events` 声明，且支持 `@deepseek-ai/dsh-scope` 的 agent 级 scope 过滤。

---

## 3. 如何程序化派生 subagent

### 结论

可以。服务为 `ctx.subagents`（`@deepseek-ai/dsh-subagent` 的 `SubagentRuntime extends TypertRemoteService`），插件 `inject: ["subagents"]` 后即可从代码派生。它是一个**命名 provider 注册表 + 能力校验启动 API**：

```ts
// dsh-subagent/lib/types/index.d.ts
export declare class SubagentRuntime extends TypertRemoteService {
    startContinuable(spec: ContinuableStartSpec): Promise<ContinuableStart>;
    sendMessage(sender: Agent, targetId: SessionId, content: ContentBlock[],
                options: SubagentSendMessageOptions): Promise<MessageId>;
    // 另有一次性 start（经 provider）：provider.start(request) -> SubagentRun
    // getProvider(name)、interrupt 等见同文件
}
```

请求/结果类型（`dsh-subagent/lib/types/types.d.ts`）：

```ts
export interface ContinuableStartSpec {
    readonly provider: string;              // 如 "spawn" / "fork"
    readonly label: string;                 // 子代理短描述
    readonly request: Omit<SubagentStartRequest, 'label' | 'signal' | 'outputSchema'>;
    readonly signal: AbortSignal;
}
export interface ContinuableStart {
    readonly childId: SessionId;            // 持久 child session id
    readonly messageId: MessageId;
}
export interface SubagentStartRequest {
    readonly label?: string;
    readonly prompt: ContentBlock[];        // 子代理首条 user 消息
    // agentOptions / outputSchema / maxDepth / toolFilter / persona / model ...
}
```

事件：`subagent/start`、`subagent/end`（`SubagentRunInfo` / `SubagentRunEndInfo`，scope 按 delegating parent 过滤）。

`@deepseek-ai/dsh-tool-subagent` 的调用方式（`lib/index.js`，摘录）：

```js
const inject = ["subagents", "jobs", ...];
...
subagentId: (await runtimeCtx.subagents.startContinuable({ ... })),   // continuable 后台
...
done: settleStart(runtimeCtx.subagents.start(config.provider, {...})), // one-shot 经 jobs 包裹
...
return settleForegroundRun(await runtimeCtx.subagents.start(config.provider, {...}));
```

provider 名来自 base patch（`dsh-base/cordis.patch.yml`）：
`subagent-spawn-in-process` → `providerName: spawn`，`subagent-fork-in-process` → `providerName: fork`。

**注意**：`sendMessage` 的 sender 必须是"精确的 live Agent"（用于授权/邻接校验）；普通插件服务（非 agent 上下文）走 `startContinuable` 派生后台 child 最直接。**[未确认]**：从无 agent 归属的插件 ctx 调 `startContinuable` 时 continuation manager 是否要求 owner 上下文——实现时需以 `dsh-subagent-spawn-in-process` / continuation manager 源码为准。

---

## 4. 面板 / UI 更新

### 结论

- `dsh-ui` 围栏与 `panel:true` 的渲染**在浏览器端**：web 前端（`@deepseek-ai/dsh-web-frontend`，`dist/assets/index-*.js` 编译产物）解析 assistant 消息里的 dsh-ui 围栏并渲染；`panel:true` 把卡片渲染进会话面板 dock。
- 引擎侧驱动面板的**唯一一等通道是 agent 的 assistant 消息**：即面板内容由 agent 回复中的 ```dsh-ui 围栏驱动，交互（`[genui-action]`）再回到模型形成回合。宿主服务没有公开的"直接 push 面板内容到浏览器"API。
- 浏览器看到消息的实时性来自 session follow 流（`@deepseek-ai/dsh-api-session-controller` 的 `SessionFollowFrame`：`"Complete opening window followed by ordered durable events"`），即浏览器订阅 session 日志事件；任何 append 进 session 的 durable 事件都会到达浏览器，但**渲染成面板卡片的路径是前端对消息围栏的解析**，不是通用 push。
- 宿主侧确有的推送类机制（均不是"面板内容"）：
  - `@deepseek-ai/dsh-webhook` + `dsh-webhook-github`：`WebhookRuntime.register(rule)` / `dispatch(delivery)`，唯一内置 action 是**创建并 prompt 一个根 Session**（`dsh-webhook/lib/types/types.d.ts:31` "The sole runtime action: create and prompt one root Session"）——即外部事件可以触发新会话、由 agent 消息间接出面板。
  - `@deepseek-ai/dsh-client-connection`：宿主可注册自定义 HTTP/RPC 路由（`HostConnectionService.register(route: ConnectionFetchRoute)`，`lib/types/rpc.d.ts:97`），浏览器端可调用——但要消费它必须有浏览器端代码。
- 浏览器端代码 = **client module**：包在 package.json 声明 `"dsh": { "client": { "platform": "web", "inject": [...] } }`（`dsh-package-manifest/lib/types/types.d.ts` 的 `DshClientManifest`），导出 `lib/client.js`，由 `dsh-client-modules` 扫进 `window.__DSH_BOOT__` 编入前端。范例见 `dsh-client-ui-cordis`（cordis 动态插件定义卡片，配 `dsh-tool-cordis` 服务端工具行）。**这条路就需要写前端**。

### 对 dsh-security-audit 的建议

不写前端的话：把审计结论作为工具结果/`deferContext` 注入 agent，或直接由 agent 在回复里发 `panel:true` 的 dsh-ui 围栏。要"无 agent 参与的常驻面板"，**当前版本未开放**（除非写 client module）。

---

## 5. 跨会话持久状态、路径与服务生命周期

### DSH_HOME / workspace

- patch 层可用 `!!js` 表达式调 launcher 提供的 helper：`dsh-base/cordis.patch.yml` 中
  `root: !!js dshHomePath('sessions')`、`root: !!js dshHomePath('storages')`。
- 运行时：`@deepseek-ai/dsh-home-paths` 导出 `resolveDshHome(configured?, env?)`（优先级：显式配置 > `$DSH_HOME` > `~/.dsh`）与 `dshHomePath(...segments)`。
- workspace（会话工作目录）：来自 session header —— `exec.agent.session.header.cwd`（见 dsh-tool-present 的用法），文件操作走注入的 `fs` 服务（`@deepseek-ai/dsh-fs`，受 sandbox 约束）。

### 持久状态

- `ctx.storage` / `storage-domain`：durable KV（base patch 挂 `dsh-storage` + `dsh-storage-json`，root `$DSH_HOME/storages`），插件可 inject 使用。
- 事件追加：`session.append("deliverables/presented", {...})`（dsh-tool-present 用法）写 durable session 日志。

### 后台长任务

- 首选 `ctx.jobs`（`@deepseek-ai/dsh-jobs` 的抽象 `JobRegistry`；web/base 组合挂 `@deepseek-ai/dsh-jobs-local`）。核心 API：
  ```ts
  abstract start(spec: JobStart): JobId;
  abstract list(caller?: Agent): JobSnapshot[];
  abstract get(id: JobId, caller?: Agent): JobSnapshot;
  abstract read(id: JobId, caller?: Agent): JobRead;
  abstract kill(id: JobId, caller?: Agent, reason?: string): 'requested' | 'already-finished';
  ```
  语义要点（摘自其 doc）：job 注册**比生产者 fiber 更长寿**；owner/service dispose 会取消在跑的工作；`start` 在没有 job controller 服务 owner 时拒绝。dsh-tool-subagent 的后台模式就是 `jobs.start({...})`。
- 自己 `setInterval` 也可以，但要返回 disposer 清理（cordis fiber 卸载时逆序执行，见 `cordis/lib/types/fiber.d.ts`）。定时任务官方做法是 `@deepseek-ai/cordis-plugin-timer`（base patch 里 `id: timer`）。
- **禁用行不能靠 config**：base patch 注释明确 "config cannot disable a row"（telemetry 行），停用要走 launcher patch 层。

---

## 6. 安装与热载

### 结论 / 流程

1. **安装**：`dsh plugin --profile web add <pkg>`。它其实是**转发 pnpm 到 profile 目录** `$DSH_HOME/profiles/<name>`（`dsh/lib/bin.js:105-110`："manage a profile's plugins by forwarding the remaining arguments to pnpm in the profile directory"），成功后 reconcile：把带 `dsh.bundle.patch` 的包写进 profile `package.json` 的 `dsh.profile.bundles`。本地开发用 `dsh plugin --profile web add .` —— CLI 会把相对路径锚定为绝对路径（`anchorPathSpec`，防 `add .` 自链接 profile；`dsh/lib/plugin-Ddi42qoW.js:77-96`）。git-hosted 包需按提示在 `pnpm-workspace.yaml` 的 `allowBuilds` 放行 prepare 脚本。
2. **生效进程**：web profile 的 bundles 是 `["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]`（`dsh-app-boot/lib/index.js:333-336`）——插件加进**宿主 web server 进程**（Node 进程内的 cordis 树，与 HTTP server / agent 同进程），不是浏览器。组合顺序：各 bundle patch 按 `dsh.profile.bundles` 顺序 insert/改写行（last write wins per row），再叠 profile 自己的 `cordis.patch.yml`，再叠 `--patch` overlay（`dsh-app-boot/lib/types/profile.d.ts` 头注释）。
3. **热载**：两层，含义不同——
   - **profile 的用户 patch 文件热载**：web 模板 `patchReload: "live"`（同上 336 行；`ProfilePatchReload = 'live' | 'startup'`，`dsh-package-manifest/lib/types/types.d.ts`）。**live 重载的是 patch 配置**（entry 树重建、插件按 patch 变化 apply/dispose），不是你的 JS 文件。
   - **插件代码热载**：`patchReload: live` "config watching uses the launcher's watch-only fallback and does not require this row"（`dsh-base/cordis.patch.yml` hmr 行注释）；真正的模块级 HMR 是 `@deepseek-ai/cordis-plugin-hmr`，base 里默认 `disabled: true`。**因此默认情况下改 `lib/index.js` 不会自动重载——需要重启 `dsh --profile web`**；patch 文件（如 profile 的 `cordis.patch.yml`）改动则 live 生效。**[未确认]**：开启 hmr row 后对 out-of-tree 包源码的实时重载范围，未逐一验证。

### 最小可安装插件（完整文件清单）

```
my-dsh-plugin/
├── package.json
├── cordis.patch.yml
└── lib/
    └── index.js
```

**package.json**
```json
{
  "name": "@you/dsh-my-plugin",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./package.json": "./package.json"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.2",
    "@deepseek-ai/dsh-tools": "^0.1.5-rc.2",
    "@deepseek-ai/schemastery": "^3.18.2"
  }
}
```
版本号以目标安装的 dsh 版本为准（本 checkout 为 `0.1.5-rc.2`；cordis 为 `^4.0.2`，见各内置包 peerDependencies）。

**cordis.patch.yml**（bundle patch；insert 进各服务包/空 profile 根）
```yaml
- insert:
    - id: my-plugin
      name: '@you/dsh-my-plugin'
      inject: [tools]
      config:
        someOption: hello
```
patch 行语法（`cordis-plugin-include/lib/types/index.d.ts` 的 `PatchOptions`）：
```ts
export interface PatchOptions {
    id?: string; insert?: EntryOptions[]; name?: string; config?: any;
    group?: boolean | null; disabled?: boolean | null;
    inject?: any; intercept?: any; isolate?: any;
}
export interface EntryOptions {   // cordis-plugin-loader/lib/types/config/entry.d.ts
    id: string; name: string; config?: any;
    group?: boolean | null; disabled?: boolean | null; inject?: Inject | null;
}
```
行语义（`dsh-base/cordis.patch.yml` 头注释）：`- id: x / config: ...` 形式是**整体替换**该行的 config（不 merge）；patch 匹配不到已有行就 warn 并跳过。

**lib/index.js**（注册一个示例工具 + 使用 DSH_HOME）
```js
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";

export const name = "my-plugin";
export const inject = ["tools"];
export const Config = z.object({ someOption: z.string().default("hello") });

export function apply(ctx, config) {
    ctx.tools.register(defineTool({
        name: "my_ping",
        description: "Example tool that echoes a message.",
        parameters: {
            message: { type: "string", required: true, description: "Text to echo" },
        },
        output: {
            schema: { type: "object", additionalProperties: false,
                properties: { echo: { type: "string", required: true } } },
            render: (_a, v) => [{ type: "text", text: v.echo }],
        },
        async execute(args, exec) {
            const cwd = exec.agent?.session?.header?.cwd;   // workspace 路径
            return { echo: `${config.someOption}:${args.message}@${cwd ?? dshHomePath()}` };
        },
    }));
}
```

**安装并验证**
```bash
cd my-dsh-plugin
dsh plugin --profile web add .            # pnpm 安装 + 写入 dsh.profile.bundles
dsh --profile web --dump-config           # 检查组合后的 entry 树里有 my-plugin 行
# 重启 dsh --profile web（默认无模块 HMR）
```

---

## 附：dsh-security-audit 实现要点速记

- 审计拦截：订阅 `tools/pre-execute` / `tools/post-execute` / `tools/result`（支持 agent scope），比包工具更贴合"审计"语义。
- 需要落盘报告：`ctx.storage`（KV）或直接写 workspace（受 sandbox policy 约束，`workspaceRoot: !!js process.cwd()`）。
- 需要后台扫描：`ctx.jobs.start(...)`。
- 需要 UI：工具结果 + agent 回复围栏（panel:true）；client module 路线成本高，暂不建议。
