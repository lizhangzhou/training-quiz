# 培训刷题助手（账号云同步 + 访客本地版）

这是一个 React + Vite + Cloudflare Workers + D1 的独立刷题网站项目。

## 题库内容

项目已将用户提供的三份题库整理为统一结构，共 **491 道题、31 个分类**：

- 教师题库：324 道；
- 负责人题库：149 道；
- 法治企业建设与合规管理专题补充题库：18 道。

题型包括：

- 单选题：303 道；
- 多选题：97 道；
- 判断题：91 道。

题库文件位于：

```text
src/questions.json
```

各分类名称保留“教师题库｜”“负责人题库｜”“法治专题｜”前缀，便于在题库筛选和练习设置中区分来源。

## 已保留的功能

- 账号注册和登录；
- D1 云端同步学习记录；
- 访客模式，数据仅保存在当前浏览器；
- 5 位字母数字图形验证码；
- 顺序练习、智能抽题、错题优先、收藏优先；
- 错题本、收藏夹、学习记录、完整题库；
- 模拟考试默认按“判断题 → 单选题 → 多选题”排列；
- 模拟考试默认按 3:4:3 比例抽题；
- 手机端验证码和顶部导航适配。

## 创建独立 D1 数据库

这个项目不能直接使用旧网站的 D1 数据库，否则两个网站的账号和学习数据会混在一起。

先安装依赖并登录 Cloudflare：

```bash
npm install
npx wrangler login
```

创建新数据库：

```bash
npx wrangler d1 create training-quiz-db
```

命令会返回新的 `database_id`。打开 `wrangler.jsonc`，把：

```json
"database_id": "00000000-0000-0000-0000-000000000000"
```

替换成刚刚创建的真实 ID。

## 本地运行

```bash
npm run db:migrate:local
npm run dev
```

## 部署

```bash
npm run typecheck
npm run build
npm run deploy
```

`npm run deploy` 会依次构建前端、执行远端 D1 迁移并部署 Worker。

通过 Cloudflare Builds 部署时，Deploy command 设置为：

```bash
npm run deploy
```

## 数据与安全

- 密码采用 PBKDF2-HMAC-SHA-256 和独立随机盐保存，不保存明文密码；
- 登录会话使用 `HttpOnly + Secure + SameSite=Lax` Cookie；
- 图形验证码在 Worker 端生成和校验，5 分钟过期且只能提交一次；
- 访客数据与账号云端数据相互隔离；
- 本项目使用独立的 LocalStorage 键名和独立会话 Cookie，不会与旧安规网站冲突。
