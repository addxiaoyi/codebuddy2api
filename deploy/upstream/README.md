# 上游 workbuddy2api 的部署与配置

本目录只提供**配置示例与对接说明**，不包含上游本体。

## 为什么这里要单独说

本仓库的 `server/`（管理端 API）与 `web/`（面板）是**控制面**：账号管理、密钥、用量统计，
以及把请求按 OpenAI / Anthropic / Responses 协议转发出去。真正发往腾讯的流量由**上游
workbuddy2api** 承担，而它不在本仓库内。

管理端缺上游时不会崩，但会如实报出来——这些提示都是「上游没起来」，不是面板故障：

| 位置 | 表现 |
| --- | --- |
| 设置 → 上游配置 | 「未找到上游配置文件 `<WB_UPSTREAM_CONFIG>`」 |
| 设置 → 上游配置（模型列表卡片） | 「No model list yet — check that the upstream container is running」 |
| 概览 / 统计 | `/api/status`、`/api/stats/upstream` 返回 `ConnectError: All connection attempts failed` |
| 接口直调 | `GET /api/models` → 502，detail 里带同一条 ConnectError |

## 别把它和 `deploy/standalone/` 弄混

本仓库自己也有容器部署，但那是**另一个东西**：

| | 本仓库自带的转换器 | 管理端的「上游」 |
| --- | --- | --- |
| 部署文件 | `deploy/standalone/`、`deploy/one-click/`、`deploy/admin/` | 见下一节 |
| 容器名 | `codebuddy2openai`、`workbuddy-oneclick`（见各自的 compose） | `workbuddy2api`（`WB2API_CONTAINER` 默认值） |
| 端口 | 8787 | 7863（`WB2API_BASE` 默认值） |
| 入口 | `python3 -m core.converter`（standalone）/ `python3 -m admin.server`（one-click、admin） | 上游自己的入口 |
| 凭据目录 | `CODEBUDDY_AUTH_DIR`（如 `/data/auth`） | `WB_AUTH_DIR`（默认 `/opt/workbuddy2api/auths`） |

两者端口与凭据目录都不同，把 8787 那个当成上游填进 `WB2API_BASE`，管理端会一直连不上。

## 上游从哪来

默认仓库 slug 是 `Sliverkiss/workbuddy2api`（见 `server/services/updater.py` 的
`UPSTREAM_API_REPO`），可用环境变量 `WB_UPSTREAM_API_REPO` 覆盖，或用
`WB_UPSTREAM_REPO` 直接给一个仓库地址。

**部署上游请以它自己仓库的文档为准。** 本目录刻意不写 Dockerfile / compose：
上游的镜像名、端口映射、volume 布局都在其仓库里定义，这里凭猜写一份只会误导。
管理端对上游只做了两件事——按下面的路径读文件、按下面的接口发请求。

## 目录布局

管理端按这些默认路径找上游（都可用环境变量改）：

```
/opt/workbuddy2api/                 # WB_UPSTREAM_DIR
├── config.json                     # WB_UPSTREAM_CONFIG —— 面板「上游配置」页读写的就是它
├── auths/                          # WB_AUTH_DIR —— 账号凭据
│   ├── workbuddy-<uid>.json
│   └── workbuddy-<uid>.json.disabled   # 面板「临时禁用」改名的产物
├── data/
│   └── server.err.log              # WB2API_LOG_FILE —— 面板展示的上游日志
├── start-workbuddy2api.cmd         # WB2API_START_SCRIPT —— native 模式启动
└── stop-workbuddy2api.cmd          # WB2API_STOP_SCRIPT —— native 模式停止
```

账号文件的匹配宽度必须是 `workbuddy*.json`（上游 `auth.AuthFileGlob` 就是这个），
文件名换成别的，上游会加载不到。

## 环境变量（管理端侧）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `WB2API_BASE` | `http://127.0.0.1:7863` | 上游地址 |
| `WB2API_KEY` | 空 | 上游 API Key；留空则读 `config.json` 的 `api_key` |
| `WB2API_CONTAINER` | `workbuddy2api` | 上游容器名（docker 模式） |
| `WB2API_MODE` | `docker` | `docker` 或 `native` |
| `WB_UPSTREAM_CONFIG` | `/opt/workbuddy2api/config.json` | 上游配置文件 |
| `WB_UPSTREAM_DIR` | `config.json` 所在目录 | 上游目录 |
| `WB_AUTH_DIR` | `/opt/workbuddy2api/auths` | 账号凭据目录 |
| `WB2API_START_SCRIPT` | `<上游目录>/start-workbuddy2api.cmd` | native 启动脚本 |
| `WB2API_STOP_SCRIPT` | `<上游目录>/stop-workbuddy2api.cmd` | native 停止脚本 |
| `WB2API_LOG_FILE` | `<上游目录>/data/server.err.log` | 上游日志 |
| `WB_UPSTREAM_API_REPO` | `Sliverkiss/workbuddy2api` | 查询上游最新提交用 |
| `WB_UPSTREAM_REPO` | 空 | 覆盖上游仓库地址 |
| `WB_MANAGER_REPO` | `ithtelab/workbuddy-manager` | 查询管理端 Release 用 |

`WB_AUTH_DIR` 与上游自己声明的 `auth_dir` 若不一致，面板「上游配置」页会顶出黄色提示
（`upstream_auth_dir`），这是刻意设计：两个目录不一致时账号会「面板里看得到、上游却不加载」。

## 部署步骤

1. **部署上游本体** —— 按上游仓库的文档走（docker 或 Windows native）。
2. **放配置文件** —— 用本目录的示例起步：

   ```bash
   mkdir -p /opt/workbuddy2api/auths
   cp deploy/upstream/config.example.json /opt/workbuddy2api/config.json
   ```

   至少要确认三项：`listen`、`api_key`、`auth_dir`。
3. **对齐管理端环境变量** —— 尤其是 `WB_AUTH_DIR`、`WB2API_BASE`、`WB2API_KEY`。
4. **自检**：

   ```bash
   curl -H "Authorization: Bearer <api_key>" http://127.0.0.1:7863/status
   curl -H "Authorization: Bearer <api_key>" http://127.0.0.1:7863/v1/models
   ```
5. **登录账号** —— 在面板「账号」页完成 OAuth 登录，凭据落到 `auths/`。

## 管理端会调用上游的哪些接口

| 接口 | 用途 |
| --- | --- |
| `GET /status` | 账号池状态（概览页） |
| `GET /v1/models` | 模型列表（再按密钥的版本与模型白名单裁剪） |
| `GET /v1/stats` | 上游进程侧的累计用量 |
| `POST /admin/accounts/{uid}/{action}` | 账号临时停用 / 启用（需 `admin.enabled=true`） |
| `/v1/chat/completions`、`/v1/responses`、`/v1/messages` | 协议转发（OpenAI / Codex CLI / Anthropic） |

鉴权头是 `Authorization: Bearer <api_key>`，取值顺序：`WB2API_KEY` → `config.json` 的 `api_key`
（见 `server/config.py` 的 `upstream_api_key()`）。

## 面板能改哪些段

写入白名单（与下发白名单是同一份，`server/services/wb2api.py` 的 `_EDITABLE_SECTIONS`）：

```
schedule  pool  cooldown  features  session_sticky  prompt  server  upstream  global  admin
```

其余顶层键（`api_key`、`auth_dir`、`state_file` 等）**不下发到界面、也不接受界面写入**——
它们是凭据与部署路径。敏感项只以掩码回传：`api_key`、`upstash.token`、`upstream.device_token`。

`config.json` 不存在时，保存接口返回 **409** 而不是凭空创建文件（避免把空配置写回真实路径）。

## 保存后如何生效

上游只在**启动时**读 `config.json`。所以管理端保存上游配置后会请求一次重载
（`reload.request_restart()`），短时间内多次改动合并成一次重启。

能不能自动重启，判据是**实际能否跑通 `docker info`**（宿主装了 docker，或容器挂了
`/var/run/docker.sock`），而不是「在不在容器里」。不能时保存响应里带 `reload_hint`，
面板会提示去宿主机执行：

```bash
cd <上游目录> && docker compose up -d --build
```

`WB2API_MODE=native` 时改走 start/stop 脚本；Windows 原生部署不支持网页一键更新。

## 常见故障

| 现象 | 原因与处理 |
| --- | --- |
| 「未找到上游配置文件 …」 | 上游没部署，或 `WB_UPSTREAM_CONFIG` 指向了别处。面板显示的就是它实际读的路径，对一下即知。 |
| 模型列表为空 / `GET /api/models` 502 | 上游没运行，或 `auths/` 里没有已登录账号。上游自 2026-09-15 起**删除了静态兜底模型表**，改为纯动态——取不到就是空列表，不是面板少显示。 |
| 改了配置但行为没变 | 见上一节：上游只在启动时读配置。 |
| 「临时停用」行为不符合预期 | 取决于 `admin.enabled`：开启 = 只摘掉转发流量（签到 / 保活照常）；未开启 = 改文件名，账号完全退出账号池、任务一并停止。开启后需重启上游生效，且上游要求 `api_key` 非空。 |
| 保存配置报 409 | `config.json` 不存在。先按上面的步骤放好文件。 |

## 关于示例文件里的取值

- 各段的键与默认值取自面板的字段定义（`web/app/(main)/settings/page.tsx` 里的
  `*_FIELDS`），与面板上「恢复默认」的取值一致，可直接当成一份可用的起步配置。
- `api_key` 留空，**上线前务必填一个非空值**（如 `openssl rand -hex 32`）。
- `listen` 写 `":7863"`，与管理端 `WB2API_BASE` 的默认端口一致；面板显示时会前缀
  `127.0.0.1`，所以这里不要写成 `127.0.0.1:7863`。
- `server.max_body_mb` 只对**旧版**上游生效（上游 9d1a21b 起已移除该配置）。
- `upstream.*` 里的 `device_token` 不在示例中：它属敏感凭据，面板只回传掩码，
  请直接在上游的 `config.json` 里维护。
