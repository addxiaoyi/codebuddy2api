# Checklist

- [ ] 任务中心页面在 index.html 中渲染，包含任务列表与执行按钮
- [ ] /admin/api/tasks 端点返回任务调度表，含上次执行时间与下次执行时间
- [ ] 成长任务查询接口 /admin/api/accounts/{aid}/growth-tasks 返回任务列表
- [ ] 成长任务一键完成接口 /admin/api/accounts/{aid}/growth-tasks/complete 返回 17/18 完成状态
- [ ] 余额后台刷新在 lifespan 中每 10 分钟执行一次
- [ ] 余额刷新失败时账号自动标记冷却 5 分钟
- [ ] 配置热生效：修改 pool_settings 后无需重启即可生效
- [ ] 概览页面显示可用模型列表（模型名、上下文长度）
- [ ] 登录失败超过 8 次后 IP 锁定 10 分钟
- [ ] CSP 响应头包含 frame-ancestors 'none' 和 script-src 'self'
- [ ] 会话粘性优先使用 conversation_id，绑定过期时间 2 小时
- [ ] 全部测试通过（99/99）
- [ ] 手动验证任务中心功能正常
- [ ] 手动验证成长任务一键完成功能正常
- [ ] 手动验证余额后台刷新功能正常
- [ ] 手动验证登录失败锁定功能正常
