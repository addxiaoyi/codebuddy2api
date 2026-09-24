# Tasks

- [ ] Task 1: 创建任务中心页面 (Task Center Page)
  - [ ] SubTask 1.1: 在 index.html 中新增任务中心页面 section
  - [ ] SubTask 1.2: 在 server.py 中新增 /admin/api/tasks 端点，返回任务调度表
  - [ ] SubTask 1.3: 在 app.js 中新增任务中心页面渲染与交互逻辑
  - [ ] SubTask 1.4: 在 style.css 中新增任务中心样式

- [ ] Task 2: 实现成长任务查询与一键完成
  - [ ] SubTask 2.1: 在 pool.py 中新增 growth_tasks() 方法，查询成长任务列表
  - [ ] SubTask 2.2: 在 server.py 中新增 /admin/api/accounts/{aid}/growth-tasks 和 /admin/api/accounts/{aid}/growth-tasks/complete 端点
  - [ ] SubTask 2.3: 在 app.js 中新增成长任务面板与一键完成按钮
  - [ ] SubTask 2.4: 跳过不可完成的任务（如邀请好友）

- [ ] Task 3: 实现余额后台定时刷新
  - [ ] SubTask 3.1: 在 pool.py 中新增 balance_refresh() 方法，调用 credits() 刷新余额
  - [ ] SubTask 3.2: 在 server.py lifespan 中新增定时任务，每 10 分钟刷新一次可用账号余额
  - [ ] SubTask 3.3: 在 app.js 中增加余额刷新状态指示器（上次刷新时间、是否正在刷新）
  - [ ] SubTask 3.4: 余额刷新失败时自动标记账号冷却 5 分钟

- [ ] Task 4: 实现配置热生效
  - [ ] SubTask 4.1: 在 server.py 中验证 pool_settings 端点已支持 PUT/PATCH，无需重启
  - [ ] SubTask 4.2: 确认 state.json 写入后下次 tick 立即使用新配置
  - [ ] SubTask 4.3: 在前端设置页面增加保存成功提示

- [ ] Task 5: 实现模型能力透出
  - [ ] SubTask 5.1: 在 server.py 的 overview 端点中增加 models 字段，包含模型名、上下文长度、特性列表
  - [ ] SubTask 5.2: 在 app.js 的 dashboard 页面增加模型信息展示区域
  - [ ] SubTask 5.3: 在 style.css 中增加模型卡片样式

- [ ] Task 6: 增强登录安全防护
  - [ ] SubTask 6.1: 在 server.py login 端点中增加失败尝试计数，超过 8 次锁定 10 分钟
  - [ ] SubTask 6.2: 在 server.py 中增加 IP 白名单配置（可选）
  - [ ] SubTask 6.3: 在 app.js 登录页面增加失败提示和锁定倒计时

- [ ] Task 7: CSP 安全加固
  - [ ] SubTask 7.1: 在 AdminMiddleware 的 secure_send 中完善 CSP 响应头
  - [ ] SubTask 7.2: 移除内联事件处理器，改用 addEventListener
  - [ ] SubTask 7.3: 增加 frame-ancestors 'none' 防止点击劫持

- [ ] Task 8: 会话粘性增强
  - [ ] SubTask 8.1: 在 pool.py select() 方法中优先使用 conversation_id 绑定
  - [ ] SubTask 8.2: 在 request_affinity() 中优先从 body 中提取 conversation_id
  - [ ] SubTask 8.3: 在 app.js 中确保每次请求携带 conversation_id
  - [ ] SubTask 8.4: 会话绑定过期时间从 86400 秒调整为 7200 秒（2小时）

- [ ] Task 9: 测试与验证
  - [ ] SubTask 9.1: 运行全部测试，确保 99 个测试通过
  - [ ] SubTask 9.2: 手动验证任务中心、成长任务、余额刷新功能
  - [ ] SubTask 9.3: 验证登录失败锁定机制
  - [ ] SubTask 9.4: 验证 CSP 头在浏览器开发者工具中正确显示
