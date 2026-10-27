# 页面巡检服务（Page Audit Service）

一个基于 **Node.js + Express + Playwright** 的批量页面质量巡检服务：提交一批 URL，后台逐页用真实浏览器打开，采集结构与质量指标，输出可排序的结果表和可存档的 HTML 报告。

面向的场景很具体：官网 / 落地页数量多、改动频繁，靠人工逐页看「有没有漏 meta description、图片有没有 alt、手机上会不会横向滚动、控制台有没有报错」不现实，而且每次都会漏项。

---

## 技术栈

| 层 | 选型 |
| --- | --- |
| 运行时 | Node.js 22（ESM） |
| 服务层 | Express 4 |
| 浏览器自动化 | Playwright（playwright-core + 本机 Chrome 内核） |
| 前端 | 原生 HTML + CSS + JavaScript（无框架，单文件） |
| 测试 | 自建断言脚本 + 两个极端样本页 |

---

## 目录结构

```
page-audit-service/
├── server.js            # Express 服务层：任务提交、进度轮询、HTML 报告生成
├── auditor.js           # 巡检核心：浏览器管理、并发控制、单页指标采集、评分
├── public/index.html    # 前端界面（单文件，无构建步骤）
├── test/
│   ├── self-test.js     # 28 项回归断言
│   └── fixtures/        # bad.html（每项都做错）/ good.html（每项都做对）
└── screenshots/         # 界面与报告截图
```

---

## 快速开始

```bash
npm install
npm start                 # 默认 http://localhost:3001
node test/self-test.js    # 跑回归断言
```

---

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/audit` | 提交任务，body `{ urls, concurrency }`，返回 `{ jobId }` |
| GET | `/api/jobs/:id` | 查询进度（不返回明细，避免轮询时反复传大对象） |
| GET | `/api/jobs/:id/result` | 取完整结果 JSON |
| GET | `/api/jobs/:id/report` | 服务端渲染的 HTML 报告，可直接存档或转发 |

---

## 采集项

**结构与 SEO**：title、meta description、canonical、lang、H1/H2/H3/H4 数量、H1 原文

**可访问性**：图片总数与缺 alt 数量、懒加载图片数

**链接与表单**：内链/外链数量、`target=_blank` 缺 `rel=noopener` 的数量、表单数与字段数、缺 `name` 属性的字段数

**体验与性能**：DOM 节点数、TTFB、DOMContentLoaded、load 事件、传输体积、请求数

**运行时质量**：控制台 error 数量（取前 5 条原文）、失败请求（取前 5 条）

**响应式**：桌面视口与 375px 移动视口各测一次横向溢出

---

## 四个关键设计决策

### 1. 任务化提交，而不是同步返回

一次巡检 20 个页面、并发 3、单页最长 30 秒，接口会挂 3 分钟以上，必然被网关或浏览器超时掐断。所以拆成 `POST 提交拿 jobId` → `GET 轮询进度`。轮询接口只回进度不回明细，避免每 900ms 传一次几百 KB 的 JSON。

### 2. 自实现信号量控并发，不引第三方库

这条链路唯一需要调的参数就是并发数。太高会被目标站点限流甚至封 IP，太低则批量任务时间不可接受。信号量只有 20 行，自己写比引 `p-limit` 更可控，也省一个依赖。

### 3. 浏览器实例复用，每页独立 Context

启动 Chromium 约 700ms，逐页启停会把总耗时放大一个数量级，所以浏览器全局单例。但每页开独立 `BrowserContext`，避免 cookie / localStorage / 缓存跨页污染，否则后一个页面的指标会被前一个页面的登录态影响。

### 4. 单页失败必须隔离

`try/catch` 包住每一页，导航失败只把该页标记为 `ok:false` 并附上错误原因，整批任务永远能正常收尾。否则一个坏链接会让 20 个页面的结果全部丢失。

---

## 踩过的坑

**Playwright 与浏览器内核版本不一致，会让每个操作慢 8 倍，而且不报错。**

最初用 `playwright-core` + 本机缓存里的旧版 Chromium（build 1234，而该版 playwright 需要 1248）。功能全部正常，但单页耗时 20 秒；换成系统安装的正式版 Chrome 后降到 2.4 秒，同一份代码、同一个页面。

因为 CDP 协议走兼容分支时不会抛错，只会退化成大量内部重试，所以这类问题用「功能是否正常」判断不出来，只能靠**分段计时**定位：

```
launch      683ms
newContext   22ms
newPage     395ms
goto(dcl)   723ms
networkidle 779ms
evaluate     18ms
```

现在内核按「协议兼容性优先」排序：系统 Chrome → 系统 Edge → playwright 缓存内核。

---

## 评分模型

100 分起扣，权重按「对真实业务的影响」排，不按「好不好改」排：

| 扣分项 | 权重 |
| --- | --- |
| HTTP ≥ 400 | -40 |
| 缺 title / 缺 H1 | -12 各 |
| H1 重复多个 | -8 |
| 移动端横向溢出 | -10 |
| 缺 meta description | -6 |
| 图片缺 alt | 每张 -3，上限 -15 |
| 表单字段缺 name | 每个 -2，上限 -8 |
| 外链缺 noopener | 每个 -2，上限 -8 |
| 控制台报错 | 每条 -3，上限 -12 |
| 加载 > 3s | -6 |

---

## 测试

`test/self-test.js` 用两个极端样本把每条检测逼出来：

- `bad.html`：故意不写 title 和 meta description、写两个 H1、3 张图里 2 张缺 alt、2 个表单字段都没 name、外链缺 noopener、固定 1200px 盒子制造移动端溢出、`console.error` 抛一条错。
- `good.html`：每项都写对。

**28 项断言全部通过**。跑法：

```bash
node test/self-test.js
```

第一次跑时 `bad.html` 拿了 65 分（应低于 60），暴露两个问题：图片缺 alt 单张只扣 2 分太轻、表单缺 name 只进问题清单却没参与扣分。修正权重后降到 49 分，`good.html` 保持 100 分。

---

## 实测数据

本机跑 4 个页面（含一个 15,186 个 DOM 节点、776 张图、2.7MB 的线上单页应用）：

| 页面 | 分数 | 加载 | 检出问题 |
| --- | --- | --- | --- |
| 官网前台原型 | 84 | 1.7s | 缺 meta description；H1 重复 3 个；1 个表单字段缺 name |
| 后台管理原型 | 73 | 1.1s | 缺 meta description；缺 H1；3 个字段缺 name；1 条控制台报错 |
| 顶部导航原型 | 88 | 3.4s | 缺 meta description |
| 线上单页应用 | 68 | 18.3s | 缺 H1；6 个字段缺 name；2 条控制台报错；加载偏慢 |

---

## 可继续做的方向

- 结果落库（现在存进程内存，重启即清空），支持历史对比与趋势
- 定时任务：每天固定时间跑一轮，只在分数下降时告警
- 接入 Lighthouse / axe-core，补性能与可访问性的深度检测
- 多视口截图存档，作为改版前后的视觉对比证据
