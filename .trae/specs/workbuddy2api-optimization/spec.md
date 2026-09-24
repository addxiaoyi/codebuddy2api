# WorkBuddy2API 面板优化 Spec

## Why

当前面板已支持 CN/INTL 双版本登录、账号池轮转、签到、余额查询及基础会话粘性。但与上游 `workbuddy2api-panel` 项目相比，管理后台在**任务中心**、**余额后台刷新**、**配置热更新**、**安全加固**等方面存在缺口。这些缺口会直接影响运维效率（频繁人工刷新余额）、用户体验（无法批量签到、缺少模型能力透出）和安全性（登录错误尝试无上限、缺少 CSP 沙箱）。本优化旨在将上游项目的关键能力引入本地，同时保持现有 CN/INTL 双版本架构不变。

## What Changes

- **任务中心**：新增任务调度表，支持签到、旅行、活动、保活等周期性任务的手动触发与状态查看
- **成长任务一键完成**：新增成长任务查询与一键完成接口，自动完成 17/18 个成长任务
- **余额后台刷新**：增加定时余额刷新机制，每 10 分钟自动刷新账号积分，避免手动查询
- **配置热生效**：支持 `pool` 设置的热更新，无需重启即可生效
- **模型能力透出**：在概览页面显示当前账号可用的模型列表
- **登录安全防护**：增加登录失败次数限制与 IP 锁定，防止暴力破解
- **CSP 安全加固**：完善管理后台的 CSP 响应头，限制内联脚本执行
- **会话粘性增强**：优化会话绑定策略，优先使用 conversation_id，降低账号切换频率

## Impact
- Affected specs: admin 管理后台, pool 账号池, server API 层, static 前端
- Affected code: `admin/server.py`, `admin/pool.py`, `admin/static/app.js`, `admin/static/index.html`, `admin/static/style.css`

## ADDED Requirements

### Requirement: 任务中心
The system SHALL provide a task scheduling table that supports periodic tasks (签到, 旅行, 活动, 保活) with manual trigger and status viewing.

#### Scenario: 管理员触发周期性任务
- **WHEN** user clicks "执行" button in task center
- **THEN** system executes the corresponding task for all enabled accounts
- **AND** shows execution result (success/failure count, duration)

#### Scenario: 查看任务状态
- **WHEN** user opens task center page
- **THEN** system displays last execution time, status, and next scheduled run for each task

### Requirement: 成长任务一键完成
The system SHALL provide growth task query and one-click completion, automatically completing 17/18 growth tasks.

#### Scenario: 查询成长任务
- **WHEN** user opens growth task panel for an account
- **THEN** system fetches growth task list from upstream
- **AND** displays task name, status, and completion reward

#### Scenario: 一键完成成长任务
- **WHEN** user clicks "一键完成" button
- **THEN** system executes all completable growth tasks in order
- **AND** shows completion progress (17/18 completed)
- **AND** skips uncompletable tasks (e.g.邀请好友)

### Requirement: 余额后台刷新
The system SHALL refresh account credits every 10 minutes in the background.

#### Scenario: 后台自动刷新余额
- **WHEN** 10 minutes have passed since last refresh
- **AND** account is in available/cooling state
- **THEN** system fetches latest credit balance from upstream
- **AND** updates the credit display in UI without user action

#### Scenario: 余额刷新失败处理
- **WHEN** credit refresh fails with 401/403
- **THEN** system marks account as cooling for 5 minutes
- **AND** logs error to account status

### Requirement: 配置热生效
The system SHALL apply pool configuration changes immediately without server restart.

#### Scenario: 更新签到时间
- **WHEN** user changes auto checkin time in settings
- **THEN** system writes to state.json immediately
- **AND** next tick uses the new value
- **AND** user sees "设置已保存" confirmation

### Requirement: 模型能力透出
The system SHALL display available models for the active account in the overview.

#### Scenario: 查看可用模型
- **WHEN** user opens dashboard
- **THEN** system shows model list from active account
- **AND** displays model name, context length, and supported features

## MODIFIED Requirements

### Requirement: 账号池轮转模式
[Complete modified requirement]
The `operate` method in `pool.py` SHALL detect account version from the auth domain and route billing requests to the correct CN or INTL endpoint. Previously, only CN billing was supported; now both cn.codebuddy.cn and workbuddy.ai billing endpoints are supported via `BILLING_CN` and `BILLING_INTL` constants.

#### Scenario: 国际版账号签到
- **WHEN** a workbuddy.ai account performs checkin
- **THEN** system uses `https://api.workbuddy.ai/v2/billing/meter/` for billing requests
- **AND** uses INTL headers (Origin: workbuddy.ai, Referer: workbuddy.ai/)

### Requirement: OAuth 登录流程
[Complete modified requirement]
The `oauth/start` endpoint SHALL accept a `version` parameter ("cn" or "intl") to generate the correct OAuth link. Previously, only CN login was supported.

#### Scenario: 生成国际版登录链接
- **WHEN** user selects "国际版" and clicks "生成登录链接"
- **THEN** system sends POST to `/admin/api/oauth/start` with `version: "intl"`
- **AND** backend uses `copilot.workbuddy.ai` as the base URL
- **AND** user receives workbuddy.ai OAuth link

### Requirement: 账号凭据格式
[Complete modified requirement]
Account credentials SHALL include a `version` field ("cn" or "intl") to track which platform the account belongs to. This version is exposed in `account_rows()` and used for routing decisions.

## REMOVED Requirements

### Requirement: 硬编码的国内版限制
**Reason**: The previous code had a hardcoded check that rejected workbuddy.ai accounts. This limitation is now removed.
**Migration**: International accounts that were previously blocked are now fully supported. Existing CN accounts continue to work as before.
