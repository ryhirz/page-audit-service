/**
 * server.js —— Express 服务层
 *
 * 为什么用「提交任务 + 轮询」而不是同步返回：
 * 一次巡检 20 个页面，单页最慢 30 秒、并发 3，接口会挂 3 分钟以上。
 * 同步接口必然被网关超时掐断，所以拆成 POST 提交拿 jobId → GET 轮询进度。
 */
import express from 'express';
import { randomUUID } from 'node:crypto';
import { auditBatch, closeBrowser } from './auditor.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json({ limit: '256kb' }));
app.use(express.static('public'));

/** 任务表：进程内存存储，够单机内部工具用；重启即清空 */
const jobs = new Map();
/** 任务保留时长：2 小时后清理，避免长时间运行内存只涨不降 */
const JOB_TTL = 2 * 60 * 60 * 1000;

function pruneJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > JOB_TTL) jobs.delete(id);
  }
}

/** 把用户输入的文本行归一化成合法 URL，顺手去掉重复项 */
function normalizeUrls(input) {
  const raw = Array.isArray(input) ? input : String(input || '').split(/[\n,\s]+/);
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    let u = String(item).trim();
    if (!u) continue;
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    try {
      const parsed = new URL(u);
      // 允许内网/本机地址：localhost 与 IP 字面量都不含点号规则，但同样需要支持
      const host = parsed.hostname;
      const isLocal = host === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
      if (!host.includes('.') && !isLocal) continue;
      const key = parsed.href.replace(/\/$/, '');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(parsed.href);
    } catch {
      /* 非法地址直接跳过，不中断整批 */
    }
  }
  return out;
}

app.post('/api/audit', (req, res) => {
  pruneJobs();
  const urls = normalizeUrls(req.body?.urls);
  if (urls.length === 0) {
    return res.status(400).json({ error: '没有解析到合法地址' });
  }
  if (urls.length > 30) {
    return res.status(400).json({ error: `单批最多 30 个地址，当前 ${urls.length} 个` });
  }

  const id = randomUUID();
  const job = {
    id,
    createdAt: Date.now(),
    status: 'running',
    total: urls.length,
    done: 0,
    urls,
    results: [],
    errors: [],
  };
  jobs.set(id, job);

  // 不 await：接口立刻返回 jobId，巡检在后台跑
  auditBatch(urls, {
    concurrency: Math.min(4, Math.max(1, Number(req.body?.concurrency) || 3)),
    timeout: 30000,
    onProgress: ({ done, total, url, ok }) => {
      job.done = done;
      job.total = total;
      if (!ok) job.errors.push(url);
    },
  })
    .then((results) => {
      job.results = results;
      job.status = 'done';
      job.finishedAt = Date.now();
    })
    .catch((err) => {
      job.status = 'failed';
      job.error = err.message;
    });

  res.json({ jobId: id, total: urls.length });
});

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: '任务不存在或已过期' });
  // results 可能很大，轮询阶段不返回明细，只给进度
  const { results, ...meta } = job;
  res.json({ ...meta, resultCount: results.length, preview: results.slice(0, 0) });
});

app.get('/api/jobs/:id/result', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: '任务不存在或已过期' });
  res.json(job);
});

app.get('/api/jobs/:id/report', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).send('任务不存在或已过期');
  res.type('html').send(renderReport(job));
});

/** 生成可单独存档的 HTML 报告，样式内联，直接发给人看 */
function renderReport(job) {
  const ok = job.results.filter((r) => r.ok);
  const rows = job.results
    .map((r) => {
      if (!r.ok) {
        return `<tr class="bad"><td>${esc(r.url)}</td><td colspan="6">${esc(r.error || '失败')}</td></tr>`;
      }
      const cls = r.score >= 85 ? 'good' : r.score >= 70 ? 'warn' : 'bad';
      return `<tr class="${cls}">
        <td class="u">${esc(r.url)}</td>
        <td>${r.status}</td>
        <td><b>${r.score}</b></td>
        <td>${r.loadMs}ms</td>
        <td>${r.imgMissingAlt}/${r.imgTotal}</td>
        <td>${r.mobileOverflow ? '有' : '无'}</td>
        <td class="iss">${r.issues.length ? esc(r.issues.join('；')) : '—'}</td>
      </tr>`;
    })
    .join('');
  const avg = ok.length ? Math.round(ok.reduce((s, r) => s + r.score, 0) / ok.length) : 0;
  const withIssues = ok.filter((r) => r.issues.length > 0).length;

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>页面巡检报告 · ${job.id.slice(0, 8)}</title><style>
body{font-family:"Microsoft YaHei",sans-serif;max-width:1100px;margin:36px auto;padding:0 20px;color:#1d1d1f}
h1{font-size:22px;margin-bottom:4px}.meta{color:#6e6e73;font-size:13px;margin-bottom:20px}
.kpi{display:flex;gap:14px;margin-bottom:22px}
.kpi div{flex:1;border:1px solid #e5e5ea;border-radius:8px;padding:12px 14px}
.kpi b{display:block;font-size:24px;color:#007AFF}
.kpi span{font-size:12px;color:#6e6e73}
table{width:100%;border-collapse:collapse;font-size:12.5px}
th,td{border-bottom:1px solid #f2f2f7;padding:8px 6px;text-align:left;vertical-align:top}
th{background:#fafafa;font-weight:600;font-size:12px}
td.u{max-width:260px;word-break:break-all;font-size:11.5px;color:#3a3a3c}
td.iss{font-size:11.5px;color:#c0392b}
tr.good b{color:#1a7f37}tr.warn b{color:#b26a00}tr.bad b{color:#c0392b}
</style></head><body>
<h1>页面巡检报告</h1>
<div class="meta">任务 ${job.id} ｜ ${new Date(job.createdAt).toLocaleString('zh-CN')} ｜ 共 ${job.total} 个页面</div>
<div class="kpi">
  <div><b>${avg}</b><span>平均健康分</span></div>
  <div><b>${withIssues}</b><span>存在问题的页面</span></div>
  <div><b>${job.errors.length}</b><span>抓取失败</span></div>
</div>
<table><thead><tr><th>地址</th><th>状态</th><th>分数</th><th>加载</th><th>缺alt</th><th>移动溢出</th><th>问题</th></tr></thead>
<tbody>${rows}</tbody></table>
</body></html>`;
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

app.use((err, req, res, next) => {
  console.error('[error]', err.message);
  res.status(500).json({ error: err.message });
});

const server = app.listen(PORT, () => {
  console.log(`页面巡检服务已启动：http://localhost:${PORT}`);
});

// 优雅退出：先关浏览器再关服务，否则 Chromium 子进程会残留
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await closeBrowser();
    server.close(() => process.exit(0));
  });
}
