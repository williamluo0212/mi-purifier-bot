#!/usr/bin/env node
/**
 * 小米全球空气净化器缺货巡检 → 飞书群机器人
 *
 * 用法：
 *   node mi-purifier-bot.js            正式巡检并发送到飞书
 *   node mi-purifier-bot.js --dry-run  只打印结果，不发飞书（调试用）
 *   node mi-purifier-bot.js --only=uk,de  只巡检指定国家（调试用）
 *
 * 密钥：
 *   飞书群 → 设置 → 群机器人 → 添加自定义机器人，拿到 webhook。
 *   本地跑：写进 config.local.json 的 "feishu_webhook" 字段（已在 .gitignore）。
 *   GitHub 上跑：仓库 Settings → Secrets → 新建 FEISHU_WEBHOOK，workflow 注入成环境变量。
 *
 * 数据来源：小米各地官网（mi.com）自身的商品接口。
 * 巡检范围：只看「空气净化器」品类（整机），不含滤芯等配件。
 * 缺货判定：商品列表接口里 has_store 字段，1=有货，0=缺货。
 */

const fs = require('fs');
const path = require('path');

const DRY_RUN = process.argv.includes('--dry-run');
const ROOT = __dirname;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const HTTP_TIMEOUT = 15000;

// ---------------------------------------------------------------------------
// 1. 读配置
// ---------------------------------------------------------------------------

function loadSecrets() {
  let fileCfg = {};
  const cfgPath = path.join(ROOT, 'config.local.json');
  if (fs.existsSync(cfgPath)) {
    try {
      fileCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    } catch (e) {
      console.error('【错误】config.local.json 不是合法 JSON：' + e.message);
      process.exit(1);
    }
  }
  // 环境变量优先（GitHub Secrets 注入），其次读本地文件
  const webhook = process.env.FEISHU_WEBHOOK || fileCfg.feishu_webhook || '';
  return { webhook };
}

function loadCountries() {
  const p = path.join(ROOT, 'countries.json');
  if (!fs.existsSync(p)) {
    console.error('【错误】找不到 countries.json，它应该和本脚本在同一目录。');
    process.exit(1);
  }
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.error('【错误】countries.json 不是合法 JSON：' + e.message);
    process.exit(1);
  }
}

// 只巡检指定国家（调试用）：node mi-purifier-bot.js --only=uk,de
function parseOnlyArg() {
  const m = process.argv.find((a) => a.startsWith('--only='));
  if (!m) return null;
  return new Set(m.slice('--only='.length).split(',').filter(Boolean).map((s) => s.trim().toLowerCase()));
}

// ---------------------------------------------------------------------------
// 2. HTTP
// ---------------------------------------------------------------------------

async function getJson(url, timeoutMs = HTTP_TIMEOUT) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const body = await res.json().catch(() => ({}));
  if (body.errno !== 0) throw new Error('errno=' + body.errno + ' ' + (body.errmsg || ''));
  return body.data || {};
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 带重试的请求：网络抖动/超时时隔 1 秒重试，最多 tries 次（默认 2 次 = 失败后重试 1 次）
async function getJsonRetry(url, tries = 2, timeoutMs = HTTP_TIMEOUT) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await getJson(url, timeoutMs);
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await sleep(1000);
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// 3. 分类 & 商品
// ---------------------------------------------------------------------------

// 在分类树里找 category_tag === "air-purifier" 的 cat_id（各国 id 不同，不能写死）
function findAirPurifierCatId(navData) {
  let found = null;
  (function walk(list) {
    for (const c of list || []) {
      if (c.category_tag === 'air-purifier') {
        found = c.cat_id;
        return;
      }
      if (c.children) walk(c.children);
      if (found != null) return;
    }
  })(navData && navData.children ? navData.children : [navData]);
  return found;
}

// 只推送空气净化器主机本身：官网会把少量滤芯/滤芯套装/净水器混进 air-purifier 品类，
// 按商品名剔除这些非主机商品（Filter/Filtre/Фильтр/滤芯/Faucet Water Purifier 等）
function isAccessoryName(name) {
  return /filt|фильтр|滤|faucet|water purifier/i.test(name || '');
}

// 捆绑套装（如「净化器 + 吸尘器」「净化器 + 风扇」）链接到 /product/bundle/，不是主机单品。
// 套装缺货不代表主机缺货，主机单品另行统计，故剔除。
function isBundleProduct(p) {
  return (p.link || '').includes('/bundle/');
}

async function checkCountry(c) {
  const base = 'https://' + c.domain;
  try {
    // ① 分类树
    const nav = await getJsonRetry(base + '/v2/item/category/nav');
    const catId = findAirPurifierCatId(nav);
    if (catId == null) {
      return { ...c, status: 'no-category', total: 0, outOfStock: [], note: '无空气净化器品类' };
    }

    // ② 该品类商品：优先用 search/product-list（全量列表）。
    //    注意区分「接口失败」和「确实没商品」——失败时不能装作查询成功，否则会误报 🟢/⚪。
    let products = [];
    let searchOk = false;
    let source = 'search';
    try {
      const data = await getJsonRetry(
        base + '/search/product-list?cat_id=' + encodeURIComponent(catId) +
          '&page_index=0&page_size=100&type=2&version=v4&cacheable=1'
      );
      const dp = (data && data.data_provider) || {};
      const list = (dp.data && dp.data.product_list) || [];
      searchOk = true; // 接口正常应答（哪怕列表为空）
      products = list.map((x) => {
        const p = x.product || {};
        return {
          name: p.name || '(未命名)',
          has_store: p.has_store,
          is_sale: p.is_sale,
          price: p.show_sales_price || '',
          link: p.item_link || '',
        };
      });
    } catch (e) {
      searchOk = false;
    }

    // ③ 回退：个别小市场 search 索引为空，品类导航精选接口有几款精选（非全量）。
    //    回退数据标 source:'featured'，看板上提示「仅精选 N 款」，不冒充全量。
    if (products.length === 0) {
      try {
        const navProducts = await getJsonRetry(
          base + '/v2/cms/category/navigation/products?cate_id=' + encodeURIComponent(catId)
        );
        const plist = (navProducts && navProducts.products) || [];
        products = plist.map((p) => ({
          name: p.name || '(未命名)',
          has_store: p.isOutOfStock ? 0 : 1,
          is_sale: p.isOutOfStock ? 0 : 1,
          price: '',
          link: '',
        }));
        if (products.length > 0) source = 'featured';
      } catch (e) {
        // 回退也失败：只有主接口曾经成功时才能断言「无商品」，否则算查询失败
        if (!searchOk) {
          return { ...c, status: 'error', total: 0, outOfStock: [], error: 'search 与回退接口均失败' };
        }
      }
    }

    if (products.length === 0 && !searchOk) {
      // 全量接口失败、回退也没拿到东西 → 无法判断，报查询失败（⚫），不报假的有货/无货
      return { ...c, status: 'error', total: 0, outOfStock: [], error: 'search 接口失败且回退无数据' };
    }

    // ④ 只保留空气净化器主机本身：滤芯、滤芯套装（如「4 Lite + Filter」）、
    //    捆绑套装（如「净化器 + 吸尘器」）、净水器等剔除
    products = products.filter((p) => !isAccessoryName(p.name) && !isBundleProduct(p));

    const outOfStock = products.filter((p) => p.has_store !== 1);
    return { ...c, status: 'ok', total: products.length, outOfStock, source };
  } catch (e) {
    return { ...c, status: 'error', total: 0, outOfStock: [], error: e.message };
  }
}

// ---------------------------------------------------------------------------
// 4. 北京时间 & 飞书卡片
// ---------------------------------------------------------------------------

function beijingDateStr() {
  const now = new Date();
  const bj = new Date(now.getTime() + (now.getTimezoneOffset() + 480) * 60000);
  const y = bj.getFullYear();
  const m = String(bj.getMonth() + 1).padStart(2, '0');
  const d = String(bj.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// 缺货率：缺货主机数 / 上架主机数（%），四舍五入
function rateStr(r) {
  const rate = r.total ? Math.round((r.outOfStock.length * 100) / r.total) : 0;
  return `缺货率 ${rate}%（${r.outOfStock.length}/${r.total} 款）`;
}

// TOP3 缺货国家：按缺货款数降序，款数相同则缺货率高者优先
function top3Oos(results) {
  return results
    .filter((r) => r.status === 'ok' && r.outOfStock.length > 0)
    .sort((a, b) =>
      b.outOfStock.length - a.outOfStock.length ||
      b.outOfStock.length / (b.total || 1) - a.outOfStock.length / (a.total || 1) ||
      a.name.localeCompare(b.name)
    )
    .slice(0, 3);
}

function buildPlainText(results, dateStr) {
  const cfg = loadCountries();
  const lines = [`🌬️ 小米空净米网缺货日报 · ${dateStr}`, ''];
  const top = top3Oos(results);
  lines.push(top.length
    ? `TOP3 缺货国家（按品类数量）：${top.map((r) => `${r.name} ${r.outOfStock.length} 款`).join(' · ')}`
    : 'TOP3 缺货国家（按品类数量）：今日无缺货 🎉');
  lines.push('');

  for (const region of (cfg.regions_order || [])) {
    const inRegion = results.filter((r) => r.region === region);
    if (!inRegion.length) continue;
    lines.push(`【${region}】`);
    for (const r of inRegion) {
      const feat = r.source === 'featured' ? `（仅精选 ${r.total} 款）` : '';
      if (r.status === 'no-category') {
        lines.push(`  ⚪ ${r.name} · 无净化器品类`);
      } else if (r.status === 'error') {
        lines.push(`  ⚫ ${r.name} · 查询失败`);
      } else if (r.outOfStock.length > 0) {
        lines.push(`  🔴 ${r.name} · ${rateStr(r)}${feat}`);
        for (const p of r.outOfStock) lines.push(`      - ${p.name}`);
      } else if (r.total === 0) {
        lines.push(`  ⚪ ${r.name} · 无商品`);
      } else {
        lines.push(`  🟢 ${r.name} · ${rateStr(r)}${feat}`);
      }
    }
    lines.push('');
  }
  lines.push('数据来源：小米各地官网（mi.com）· 空气净化器主机每日巡检');
  return lines.join('\n');
}

function buildCard(results, dateStr) {
  const cfg = loadCountries();
  const elements = [];
  const md = (content) => ({ tag: 'div', text: { tag: 'lark_md', content } });

  // 开头：TOP3 缺货品类数量国家
  const top = top3Oos(results);
  elements.push(md(top.length
    ? `**TOP3 缺货国家（按品类数量）**：${top.map((r) => `**${r.name}** ${r.outOfStock.length} 款`).join(' · ')}`
    : '**TOP3 缺货国家（按品类数量）**：今日无缺货 🎉'));
  elements.push({ tag: 'hr' });

  for (const region of (cfg.regions_order || [])) {
    const inRegion = results.filter((r) => r.region === region);
    if (!inRegion.length) continue;
    elements.push(md(`**【${region}】**`));
    for (const r of inRegion) {
      const feat = r.source === 'featured' ? `（仅精选 ${r.total} 款）` : '';
      if (r.status === 'no-category') {
        elements.push(md(`⚪ ${r.name} · 无净化器品类`));
      } else if (r.status === 'error') {
        elements.push(md(`⚫ ${r.name} · 查询失败`));
      } else if (r.outOfStock.length > 0) {
        const names = r.outOfStock.map((p) => `　　- ${p.name}`).join('\n');
        elements.push(md(`🔴 **${r.name}** · ${rateStr(r)}${feat}\n${names}`));
      } else if (r.total === 0) {
        elements.push(md(`⚪ ${r.name} · 无商品`));
      } else {
        elements.push(md(`🟢 ${r.name} · ${rateStr(r)}${feat}`));
      }
    }
    elements.push({ tag: 'hr' });
  }

  elements.push({
    tag: 'note',
    elements: [{ tag: 'plain_text', content: '数据来源：小米各地官网（mi.com）· 空气净化器主机每日巡检' }],
  });

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `🌬️ 小米空净米网缺货日报 · ${dateStr}` },
      template: 'blue',
    },
    elements,
  };
}

// ---------------------------------------------------------------------------
// 5. 发到飞书自定义机器人
// ---------------------------------------------------------------------------

async function sendToFeishu(webhook, card) {
  if (!webhook) {
    throw new Error('未配置 feishu_webhook，无法发送');
  }
  const res = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ msg_type: 'interactive', card }),
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.json().catch(() => ({}));
  // 飞书成功返回 {code:0,...}；旧版是 {StatusCode:0,...}
  if (body.code !== 0 && body.StatusCode !== 0) {
    throw new Error(`飞书返回错误 code=${body.code} msg=${body.msg || body.StatusMessage || JSON.stringify(body)}`);
  }
  return body;
}

// ---------------------------------------------------------------------------
// 6. 主流程
// ---------------------------------------------------------------------------

async function main() {
  const cfg = loadCountries();
  let countries = cfg.countries || [];
  const only = parseOnlyArg();
  if (only) countries = countries.filter((c) => only.has(c.cc));
  if (only && countries.length === 0) {
    console.error('【错误】--only 没有匹配到任何国家，可用的国家代码：' + (cfg.countries || []).map((c) => c.cc).join(', '));
    process.exit(1);
  }

  console.log(`开始巡检 ${countries.length} 个国家...`);

  const results = [];
  for (const c of countries) {
    process.stdout.write(`  ${c.name} (${c.cc}) ... `);
    const r = await checkCountry(c);
    if (r.status === 'ok') {
      console.log(`共 ${r.total} 款，缺货 ${r.outOfStock.length} 款`);
    } else if (r.status === 'no-category') {
      console.log('无净化器品类');
    } else {
      console.log(`失败 — ${r.error || '未知错误'}`);
    }
    results.push(r);
    await sleep(100); // 礼貌间隔
  }

  const okList = results.filter((r) => r.status === 'ok');
  const oosList = okList.filter((r) => r.outOfStock.length > 0);
  console.log(`\n巡检完成：${results.length} 国，有品类 ${okList.length}，缺货 ${oosList.length} 国\n`);

  const dateStr = beijingDateStr();
  console.log('———————————— 消息预览（纯文本近似，实际是蓝色卡片）————————————');
  console.log(buildPlainText(results, dateStr));
  console.log('————————————————————————————————————\n');

  if (DRY_RUN) {
    console.log('【dry-run】没有发送到飞书。去掉 --dry-run 即可真正发送。');
    return;
  }

  const { webhook } = loadSecrets();
  if (!webhook) {
    console.error('【错误】没有配置 feishu_webhook，消息已生成但发不出去。');
    console.error('  按 README 在飞书里建群机器人，把 webhook 地址填进 config.local.json 或 FEISHU_WEBHOOK 环境变量。');
    process.exit(1);
  }

  const card = buildCard(results, dateStr);
  await sendToFeishu(webhook, card);
  console.log('【成功】已发送到飞书群（卡片）。');
}

main().catch((e) => {
  console.error('【未捕获错误】' + (e && e.stack ? e.stack : e));
  process.exit(1);
});

