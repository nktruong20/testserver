'use strict';

/**
 * VN Stocks Chat + News — Full Backend (All-protected APIs)
 * ---------------------------------------------------------
 * - Auth (JWT)  → /api/auth/register + /api/auth/login (public), /api/auth/profile (protected)
 * - Watchlist   → REST CRUD + Socket.IO push + CRON refresh (protected)
 * - Stocks      → VPS + VNDirect + vnstock-js (protected)
 * - News        → Google News RSS → JSON (image enrichment) (protected)
 * - AI Chat     → /api/chat/query (OpenAI Responses + Tool Calling) (protected)
 * - Security    → helmet, CORS, rate limit, IPv4-first DNS
 *
 * ENV required:
 *  - PORT=3000
 *  - DB_URL=mongodb+srv://...
 *  - JWT_SECRET=your_jwt_secret
 *  - OPENAI_API_KEY=sk-...
 *  - CORS_ORIGINS=https://your-frontend.app,https://another.app (optional, default "*")
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');
const http = require('http');
const { Server } = require('socket.io');
const cron = require('node-cron');
const https = require('https');
const axios = require('axios');
const axiosRetry = require('axios-retry').default;
const { exponentialDelay } = require('axios-retry');
const vnstock = require('vnstock-js');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const cheerio = require('cheerio');
const dns = require('dns');
const OpenAI = require('openai');

// Prefer IPv4 to avoid some VPS endpoints failing behind IPv6
try {
  dns.setDefaultResultOrder?.('ipv4first');
} catch {}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Axios harden + retries
axiosRetry(axios, { retries: 2, retryDelay: exponentialDelay });

// Reuse agents for better perf
const httpAgent = new (require('http').Agent)({ keepAlive: true, maxSockets: 50 });
const httpsAgent = new (require('https').Agent)({ keepAlive: true, maxSockets: 50 });
axios.defaults.httpAgent = httpAgent;
axios.defaults.httpsAgent = httpsAgent;
axios.defaults.headers.common['User-Agent'] = 'vn-stocks-chat-backend/1.0 (+node)';

// =============================
// 1) MONGODB CONNECT
mongoose.set('debug', true); // log mọi query

async function connectDB() {
  try {
    await mongoose.connect(process.env.DB_URL, { autoIndex: false, maxPoolSize: 10 });
    console.log('✅ MongoDB connected');
    console.log('DB_URL =', process.env.DB_URL);
    console.log('DB host/name =', mongoose.connection.host, mongoose.connection.name);
  } catch (err) {
    console.error('❌ MongoDB connection error:', err.message);
    process.exit(1);
  }
}


process.on('SIGINT', async () => {
  try {
    await mongoose.connection.close();
  } finally {
    process.exit(0);
  }
});

// =============================
// 2) COMMON UTILS
// =============================
const TZ = 'Asia/Bangkok'; // UTC+7

const fmtISO = (d) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d); // YYYY-MM-DD
const fmtVI = (d) =>
  new Intl.DateTimeFormat('vi-VN', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d); // dd/MM/yyyy

function ymd(date = new Date(), tz = TZ) {
  return fmtISO(new Date(date));
}
function dmy(date = new Date(), tz = TZ) {
  return fmtVI(new Date(date));
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

// Chuẩn hoá record “hàng ngày”
function normalizeDailyRecord(d, code) {
  return {
    symbol: code,
    date: d?.tradingDate ?? d?.date ?? null,
    open: d?.openPrice ?? d?.open ?? null,
    close: d?.closePrice ?? d?.close ?? d?.lastPrice ?? null,
    high: d?.highestPrice ?? d?.highPrice ?? d?.high ?? null,
    low: d?.lowestPrice ?? d?.lowPrice ?? d?.low ?? null,
    change: d?.priceChange ?? d?.change ?? null,
    percentChange: d?.pctChange ?? d?.percentChange ?? null,
    volume: d?.totalMatchVolume ?? d?.volume ?? null,
    value: d?.totalMatchValue ?? d?.value ?? null
  };
}

// VPS helpers (thử 2 định dạng ngày)
async function fetchHistoryOneDayVPS(code, dateObj) {
  const d1 = ymd(dateObj, TZ);
  const d2 = dmy(dateObj, TZ);
  const tryUrls = [
    `https://bgapidatafeed.vps.com.vn/gethistoryprice/${code}?fromDate=${d1}&toDate=${d1}`,
    `https://bgapidatafeed.vps.com.vn/gethistoryprice/${code}?fromDate=${d2}&toDate=${d2}`
  ];
  for (const url of tryUrls) {
    try {
      const { data } = await axios.get(url, { timeout: 10000 });
      if (Array.isArray(data) && data.length > 0) return data;
    } catch {
      // try next url
    }
  }
  return [];
}

async function fetchHistoryRangeVPS(code, startDate, endDate) {
  const s1 = ymd(startDate, TZ),
    e1 = ymd(endDate, TZ);
  const s2 = dmy(startDate, TZ),
    e2 = dmy(endDate, TZ);
  const tryUrls = [
    `https://bgapidatafeed.vps.com.vn/gethistoryprice/${code}?fromDate=${s1}&toDate=${e1}`,
    `https://bgapidatafeed.vps.com.vn/gethistoryprice/${code}?fromDate=${s2}&toDate=${e2}`
  ];
  for (const url of tryUrls) {
    try {
      const { data } = await axios.get(url, { timeout: 12000 });
      if (Array.isArray(data) && data.length > 0) return data;
    } catch {
      // try next url
    }
  }
  return [];
}

// VNDirect DChart fallback (resolution D)
async function fetchRangeVNDirectDchart(code, startDate, endDate) {
  try {
    const from = Math.floor(new Date(startDate).getTime() / 1000);
    const to = Math.floor(new Date(endDate).getTime() / 1000);
    const url = `https://dchart-api.vndirect.com.vn/dchart/history?symbol=${encodeURIComponent(
      code
    )}&resolution=D&from=${from}&to=${to}`;
    const { data } = await axios.get(url, { timeout: 12000 });
    // Data shape: { s: 'ok', t: [], c: [], o: [], h: [], l: [], v: [] }
    if (!data || data.s !== 'ok' || !Array.isArray(data.t) || !data.t.length) return [];
    const out = data.t.map((ts, i) => ({
      tradingDate: new Date(ts * 1000).toISOString().slice(0, 10),
      openPrice: data.o?.[i] ?? null,
      closePrice: data.c?.[i] ?? null,
      highestPrice: data.h?.[i] ?? null,
      lowestPrice: data.l?.[i] ?? null,
      totalMatchVolume: data.v?.[i] ?? null
    }));
    return out;
  } catch {
    return [];
  }
}

// =============================
// 3) MONGOOSE MODELS
// =============================
const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: [true, 'Tên không được bỏ trống'] },
    email: { type: String, required: [true, 'Email không được bỏ trống'], unique: true, index: true },
    password: { type: String, required: [true, 'Mật khẩu không được bỏ trống'] }
  },
  { timestamps: true }
);
const User = mongoose.model('User', userSchema);

const watchlistSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'User', index: true },
    symbol: { type: String, required: [true, 'Mã cổ phiếu không được bỏ trống'], uppercase: true, trim: true },
    buyPrice: { type: Number, required: [true, 'Giá mua không được bỏ trống'] },
    note: { type: String }
  },
  { timestamps: true }
);
const Watchlist = mongoose.model('Watchlist', watchlistSchema);

const chatMessageSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  conversationId: { type: String, required: true, index: true }, // Thêm dòng này!
  symbol: { type: String },
  from: { type: String, enum: ['user', 'bot'], required: true },
  text: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});


// chỉ rõ collection = 'chatmessages'
const ChatMessage = mongoose.model('ChatMessage', chatMessageSchema, 'chatmessages');

// =============================
// 4) AUTH MIDDLEWARE + CONTROLLER
// =============================
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ success: false, message: 'Không có token' });
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    res.status(403).json({ success: false, message: 'Token không hợp lệ' });
  }
}

const authController = {
  register: async (req, res) => {
    try {
      const { name, email, password } = req.body;
      if (!name || !email || !password) {
        return res.status(400).json({ success: false, message: 'Tên, email và mật khẩu là bắt buộc' });
      }
      const exist = await User.findOne({ email });
      if (exist) return res.status(400).json({ success: false, message: 'Email đã tồn tại' });

      const hashedPassword = await bcrypt.hash(password, 10);
      const newUser = await User.create({ name, email, password: hashedPassword });
      res.json({
        success: true,
        message: 'Đăng ký thành công',
        user: { id: newUser._id, name: newUser.name, email: newUser.email }
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },

  login: async (req, res) => {
    try {
      const { email, password } = req.body;
      if (!email || !password) return res.status(400).json({ success: false, message: 'Email và mật khẩu là bắt buộc' });
      const user = await User.findOne({ email });
      if (!user) return res.status(400).json({ success: false, message: 'Email không tồn tại' });

      const match = await bcrypt.compare(password, user.password);
      if (!match) return res.status(400).json({ success: false, message: 'Mật khẩu không đúng' });

      const token = jwt.sign({ id: user._id, email: user.email, name: user.name }, process.env.JWT_SECRET, {
        expiresIn: '1d'
      });
      res.json({ success: true, message: 'Đăng nhập thành công', token, user: { id: user._id, name: user.name, email: user.email } });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
};

// =============================
// 5) STOCKS CONTROLLER (VPS/VNDirect/vnstock)
// =============================
const stocksController = {
  // Giao dịch theo thời gian (VPS streaming-ish)
  getStockTrades: (req, res) => {
    const symbol = req.params.symbol.toUpperCase();
    const url = `https://bgapidatafeed.vps.com.vn/getliststocktrade/${symbol}`;

    // Enforce IPv4 for this endpoint
    https
      .get(url, { family: 4, headers: { 'User-Agent': axios.defaults.headers.common['User-Agent'] } }, (resp) => {
        let data = '';
        resp.on('data', (chunk) => (data += chunk));
        resp.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (!Array.isArray(json) || json.length === 0) {
              return res.status(404).json({ success: false, message: 'Không có dữ liệu giao dịch' });
            }
            res.json({
              success: true,
              symbol,
              trades: json.map((t) => ({
                time: t.time,
                lastPrice: t.lastPrice,
                lastVol: t.lastVol,
                totalVol: t.totalVol
              }))
            });
          } catch (e) {
            res.status(500).json({ success: false, error: 'Không parse được JSON', raw: data });
          }
        });
      })
      .on('error', (err) => {
        res.status(500).json({ success: false, error: err.message });
      });
  },

  // Lấy dữ liệu cơ bản của nhiều mã (VPS)
  getStocksData: async (req, res) => {
    try {
      const codes = req.query.codes;
      if (!codes) return res.status(400).json({ success: false, message: 'Vui lòng nhập mã, ví dụ ?codes=FPT,ACB' });
      const codeList = codes.split(',').map((code) => code.trim().toUpperCase());
      const results = [];
      for (const code of codeList) {
        const url = `https://bgapidatafeed.vps.com.vn/getliststockdata/${code}`;
        const response = await axios.get(url, { timeout: 10000 });
        if (response.data && response.data.length > 0) results.push(response.data[0]);
      }
      res.json({ success: true, total: results.length, data: results });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  },

  // Lịch sử/quote (vnstock-js) — tiện cho debug
  getStockHistory: async (req, res) => {
    const symbol = req.params.symbol.toUpperCase();
    try {
      const result = await vnstock.stock.quote({ ticker: symbol, start: '2025-01-01' });
      res.json({ success: true, symbol, quote: result });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  },

  // Top gainers/losers (vnstock-js)
  getTopGainers: async (_req, res) => {
    try {
      const data = await vnstock.stock.topGainers();
      res.json({ success: true, data });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  },
  getTopLosers: async (_req, res) => {
    try {
      const data = await vnstock.stock.topLosers();
      res.json({ success: true, data });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  },

  // Search nhanh (VPS + vnstock hỗ trợ tính hôm qua sơ bộ)
  searchStock: async (req, res) => {
    try {
      const symbol = (req.query.symbol || '').toUpperCase();
      if (!symbol) return res.status(400).json({ success: false, message: 'Vui lòng nhập mã chứng khoán' });

      const url = `https://bgapidatafeed.vps.com.vn/getliststockdata/${symbol}`;
      const response = await axios.get(url, { timeout: 10000 });
      if (!response.data || response.data.length === 0) {
        return res.status(404).json({ success: false, message: 'Không tìm thấy dữ liệu cho mã này' });
      }

      let yesterdayPrice = null;
      try {
        const history = await vnstock.stock.quote({ ticker: symbol, start: '2025-01-01', limit: 2 });
        yesterdayPrice = Array.isArray(history) && history.length >= 2 ? history[1]?.close ?? null : response.data[0].lastPrice ?? null;
      } catch {
        yesterdayPrice = response.data[0].lastPrice ?? null;
      }

      res.json({
        success: true,
        data: { symbol, currentPrice: response.data[0].lastPrice, yesterdayPrice, ...response.data[0] }
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
};

// =============================
// 6) NEWS HELPERS + CONTROLLER (Google News RSS → JSON)
// =============================
function stripHtml(html = '') {
  try {
    return html.replace(/<\/?[^>]+(>|$)/g, '').replace(/\s+/g, ' ').trim();
  } catch {
    return html;
  }
}

function normalizeNewsLink(link = '') {
  try {
    const url = new URL(link);
    const orig = url.searchParams.get('url');
    return orig || link;
  } catch {
    return link;
  }
}

function buildGoogleNewsUrl(q, { hl = 'vi', gl = 'VN', range } = {}) {
  const ceid = `${gl}:${hl}`;
  const qs = range ? `${q} when:${range}` : q; // 1d, 7d, 30d
  return `https://news.google.com/rss/search?q=${encodeURIComponent(qs)}&hl=${hl}&gl=${gl}&ceid=${ceid}`;
}

async function fetchRssXml(q, opts = {}) {
  const url = buildGoogleNewsUrl(q, opts);
  const { data: xml } = await axios.get(url, { headers: { Accept: 'application/rss+xml' }, timeout: 10000 });
  return xml;
}

function parseGoogleNewsRss(xml) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const get = (tag) => {
      const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\/${tag}>`, 'i');
      const mm = block.match(re);
      return mm ? stripHtml(mm[1].replace(/<!\[CDATA\[|\]\]>/g, '')) : '';
    };
    const title = get('title');
    const linkRaw = get('link');
    const link = normalizeNewsLink(linkRaw);
    const pubDate = get('pubDate');
    const description = get('description');
    const srcName = get('source');
    const srcUrlMatch = block.match(/<source[^>]*url="([^"]+)"/i);
    const sourceUrl = srcUrlMatch ? srcUrlMatch[1] : '';
    let imageUrl = '';
    const mediaContent = block.match(/<media:content[^>]*url="([^"]+)"/i);
    const mediaThumb = block.match(/<media:thumbnail[^>]*url="([^"]+)"/i);
    const enclosure = block.match(/<enclosure[^>]*url="([^"]+)"/i);
    imageUrl = (mediaContent && mediaContent[1]) || (mediaThumb && mediaThumb[1]) || (enclosure && enclosure[1]) || '';
    items.push({ title, link, pubDate, description, source: { name: srcName, url: sourceUrl }, imageUrl });
  }
  return items;
}

async function fetchArticleImage(url) {
  try {
    const { data: html } = await axios.get(url, {
      headers: { 'User-Agent': axios.defaults.headers.common['User-Agent'] },
      timeout: 8000,
      maxRedirects: 5,
      validateStatus: (s) => s >= 200 && s < 400
    });
    const $ = cheerio.load(html);
    return (
      $('meta[property="og:image"]').attr('content') ||
      $('meta[name="twitter:image"]').attr('content') ||
      $('img').first().attr('src') ||
      null
    );
  } catch {
    return null;
  }
}

async function enrichImages(items, concurrency = 5) {
  const out = [...items];
  let i = 0;
  async function worker() {
    while (i < out.length) {
      const idx = i++;
      const it = out[idx];
      if (!it?.link) continue;
      if (!it.imageUrl) {
        const img = await fetchArticleImage(it.link);
        if (img) out[idx].imageUrl = img;
      }
    }
  }
  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);
  return out;
}

const newsController = {
  proxyXml: async (req, res) => {
    try {
      const symbol = req.params.symbol;
      const q = symbol ? `${symbol} chứng khoán` : req.query.q || '';
      if (!q) return res.status(400).send('<error>Thiếu tham số q hoặc symbol</error>');
      const hl = req.query.hl || 'vi';
      const gl = req.query.gl || 'VN';
      const range = req.query.range; // 1d, 7d, 30d
      const xml = await fetchRssXml(q, { hl, gl, range });
      res.set('Content-Type', 'application/xml; charset=utf-8');
      res.send(xml);
    } catch (err) {
      res.status(500).send(`<error>${stripHtml(err.message)}</error>`);
    }
  },

  parsedJson: async (req, res) => {
    try {
      const symbol = req.params.symbol;
      const q = symbol ? `${symbol} chứng khoán` : req.query.q || '';
      if (!q) return res.status(400).json({ success: false, message: 'Thiếu tham số q hoặc symbol' });
      const hl = req.query.hl || 'vi';
      const gl = req.query.gl || 'VN';
      const range = req.query.range;
      const limit = Math.max(1, Math.min(Number(req.query.limit) || 30, 50));

      const xml = await fetchRssXml(q, { hl, gl, range });
      let items = parseGoogleNewsRss(xml);

      // khử trùng lặp theo link
      const map = new Map();
      for (const it of items) {
        if (!it?.link) continue;
        const key = it.link;
        if (!map.has(key)) map.set(key, it);
      }
      items = Array.from(map.values());

      items = await enrichImages(items, 5);
      items = items.slice(0, limit);

      res.json({ success: true, query: q, params: { hl, gl, range, limit }, total: items.length, items });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
};

// =============================
// 7) STOCK INFO (Cho AI Chat + FE)
// =============================
const stockInfoController = {
  // HÔM NAY
  getToday: async (req, res) => {
    try {
      const { symbol } = req.body;
      if (!symbol) return res.status(400).json({ success: false, message: 'Thiếu mã (symbol)' });
      const code = symbol.toUpperCase();
      const url = `https://bgapidatafeed.vps.com.vn/getliststockdata/${code}`;
      const { data } = await axios.get(url, { timeout: 10000 });
      const d = Array.isArray(data) ? data[0] : null;
      if (!d) return res.status(404).json({ success: false, message: `Không có dữ liệu cho ${code}` });
      const todayStr = ymd(new Date(), TZ);
      const out = {
        symbol: code,
        date: todayStr,
        open: d.openPrice ?? null,
        close: d.closePrice ?? d.lastPrice ?? null,
        high: d.highestPrice ?? null,
        low: d.lowestPrice ?? null,
        change: d.change ?? null,
        percentChange: d.percentChange ?? null,
        volume: d.totalMatchVolume ?? null,
        value: d.totalMatchValue ?? null,
        referencePrice: d.referencePrice ?? d.basicPrice ?? null
      };
      return res.json({ success: true, data: out });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  },

  // HÔM QUA (tự lùi phiên gần nhất). VPS → DChart → vnstock-js
  getYesterday: async (req, res) => {
    try {
      const { symbol } = req.body;
      if (!symbol) return res.status(400).json({ success: false, message: 'Thiếu mã (symbol)' });
      const code = symbol.toUpperCase();

      // 1) VPS theo từng ngày lùi lại
      let d = addDays(new Date(), -1);
      let found = null;
      for (let i = 0; i < 7; i++) {
        const rows = await fetchHistoryOneDayVPS(code, d);
        if (rows.length) {
          found = normalizeDailyRecord(rows[0], code);
          break;
        }
        d = addDays(d, -1);
      }

      // 2) Fallback VNDirect DChart (lấy 14 ngày gần đây rồi chọn < today)
      if (!found) {
        const start = addDays(new Date(), -14);
        const end = new Date();
        const rows = await fetchRangeVNDirectDchart(code, start, end);
        const todayStr = ymd(new Date(), TZ);
        const pick = [...rows]
          .reverse()
          .find((r) => (r.tradingDate || r.date || '').slice(0, 10) < todayStr);
        if (pick) found = normalizeDailyRecord(pick, code);
      }

      // 3) Fallback cuối: vnstock-js
      if (!found) {
        try {
          const start = ymd(addDays(new Date(), -14), TZ);
          const quotes = await vnstock.stock.quote({ ticker: code, start, limit: 20 });
          const todayStr = ymd(new Date(), TZ);
          const pick = quotes.find((q) => (q.tradingDate || q.date || q.time || '').slice(0, 10) < todayStr);
          if (pick) {
            found = normalizeDailyRecord(
              {
                tradingDate: pick.tradingDate || pick.date || pick.time,
                openPrice: pick.open,
                closePrice: pick.close,
                highestPrice: pick.high,
                lowestPrice: pick.low,
                totalMatchVolume: pick.volume,
                totalMatchValue: pick.value,
                priceChange: pick.change,
                pctChange: pick.percentChange
              },
              code
            );
          }
        } catch {}
      }

      // Luôn 200 để FE không coi là lỗi mạng
      if (!found) {
        return res.json({ success: true, data: null, message: `Không có phiên gần đây cho ${code}` });
      }
      return res.json({ success: true, data: found });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  },

  // N ngày gần đây (VPS → DChart → vnstock-js)
  getRange: async (req, res) => {
    try {
      const { symbol, days } = req.body;
      if (!symbol || !days) return res.status(400).json({ success: false, message: 'Thiếu symbol hoặc days' });

      const code = symbol.toUpperCase();
      const endDate = new Date();
      const startDate = addDays(new Date(), -(Number(days) - 1));

      // 1) VPS
      let data = await fetchHistoryRangeVPS(code, startDate, endDate);

      // 2) VNDirect DChart fallback
      if (!Array.isArray(data) || data.length === 0) {
        data = await fetchRangeVNDirectDchart(code, startDate, endDate);
      }

      // 3) vnstock-js fallback
      if (!Array.isArray(data) || data.length === 0) {
        try {
          const start = ymd(startDate, TZ);
          const quotes = await vnstock.stock.quote({ ticker: code, start, limit: days + 10 });
          data = (quotes || []).map((q) => ({
            tradingDate: q.tradingDate || q.date || q.time,
            openPrice: q.open,
            closePrice: q.close,
            highestPrice: q.high,
            lowestPrice: q.low,
            totalMatchVolume: q.volume,
            totalMatchValue: q.value,
            priceChange: q.change,
            pctChange: q.percentChange
          }));
        } catch {
          data = [];
        }
      }

      const rows = (data || [])
        .map((d) => normalizeDailyRecord(d, code))
        .filter((r) => !!r.date)
        .sort((a, b) => new Date(a.date) - new Date(b.date));

      return res.json({ success: true, data: rows });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  },

  // THEO NGÀY CỤ THỂ
  getByDate: async (req, res) => {
    try {
      const { symbol, date } = req.body;
      if (!symbol || !date) return res.status(400).json({ success: false, message: 'Thiếu symbol hoặc date (YYYY-MM-DD)' });
      const code = symbol.toUpperCase();

      // VPS trước (YYYY-MM-DD)
      let url = `https://bgapidatafeed.vps.com.vn/gethistoryprice/${code}?fromDate=${date}&toDate=${date}`;
      let outRows = [];
      try {
        const { data } = await axios.get(url, { timeout: 10000 });
        if (Array.isArray(data) && data.length > 0) outRows = data;
      } catch {}

      // Nếu rỗng: thử DD/MM/YYYY
      if (!outRows.length) {
        const parts = date.split('-');
        const ddmmyyyy = `${parts[2]}/${parts[1]}/${parts[0]}`;
        url = `https://bgapidatafeed.vps.com.vn/gethistoryprice/${code}?fromDate=${ddmmyyyy}&toDate=${ddmmyyyy}`;
        try {
          const { data } = await axios.get(url, { timeout: 10000 });
          if (Array.isArray(data) && data.length > 0) outRows = data;
        } catch {}
      }

      // fallback DChart
      if (!outRows.length) {
        const d = new Date(date);
        const rows = await fetchRangeVNDirectDchart(code, addDays(d, -1), addDays(d, 1));
        const pick = rows.find((r) => (r.tradingDate || r.date || '').slice(0, 10) === date);
        if (pick) outRows = [pick];
      }

      if (!outRows.length) return res.status(404).json({ success: false, message: `Không có dữ liệu ${code} ngày ${date}` });

      const out = normalizeDailyRecord(outRows[0], code);
      return res.json({ success: true, data: out });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  }
};

// =============================
// 8) APP + SERVER + SOCKET.IO
// =============================
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', credentials: true } });

// DB connect
connectDB();

// Security & common middlewares
app.use(helmet());
const allowedOrigins = (process.env.CORS_ORIGINS || '*')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error('Not allowed by CORS'));
    },
    credentials: true
  })
);

app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 1000,
    standardHeaders: true,
    legacyHeaders: false
  })
);
app.use(morgan('dev'));
app.use(express.json({ limit: '1mb' }));

// =============================
// 9) WATCHLIST: fetch + socket push + controller
// =============================
async function fetchPriceAxios(symbol) {
  const url = `https://api-finfo.vndirect.com.vn/v4/effective_secinfo?q=code:${symbol}`;
  const { data } = await axios.get(url, {
    timeout: 10000,
    headers: {
      Accept: 'application/json'
    }
  });
  if (!data?.data?.length) return null;
  const stock = data.data[0];
  return {
    symbol: stock.code,
    basicPrice: stock.basicPrice, // tham chiếu (hôm qua)
    ceilPrice: stock.ceilPrice,
    floorPrice: stock.floorPrice,
    matchPrice: stock.matchPrice, // giá khớp hiện tại
    tradingDate: stock.tradingDate
  };
}

let updating = false;
async function updateWatchlist() {
  if (updating) return;
  updating = true;
  try {
    const users = await Watchlist.distinct('userId');
    for (const userId of users) {
      const items = await Watchlist.find({ userId });
      const enrichedItems = [];
      for (const item of items) {
        try {
          const data = await fetchPriceAxios(item.symbol);
          if (data) {
            const yesterdayPrice = Number((data.basicPrice || 0).toFixed(2));
            const currentPrice = Number((data.matchPrice || 0).toFixed(2));
            const buyPrice = Number((item.buyPrice || 0).toFixed(2));
            const buyPriceYesterdayDiff =
              yesterdayPrice !== 0 ? (((currentPrice - yesterdayPrice) / yesterdayPrice) * 100).toFixed(2) : '0';
            const buyPriceDiff = buyPrice !== 0 ? (((currentPrice - buyPrice) / buyPrice) * 100).toFixed(2) : '0';
            enrichedItems.push({
              _id: item._id,
              symbol: item.symbol,
              buyPrice,
              yesterdayPrice,
              currentPrice,
              buyPriceYesterdayDiff: `${buyPriceYesterdayDiff}%`,
              buyPriceDiff: `${buyPriceDiff}%`,
              note: item.note,
              tradingDate: data.tradingDate
            });
          } else {
            enrichedItems.push({
              _id: item._id,
              symbol: item.symbol,
              buyPrice: Number((item.buyPrice || 0).toFixed(2)),
              yesterdayPrice: 0,
              currentPrice: 0,
              buyPriceYesterdayDiff: '0%',
              buyPriceDiff: '0%',
              note: item.note,
              tradingDate: null
            });
          }
        } catch (_error) {
          enrichedItems.push({
            _id: item._id,
            symbol: item.symbol,
            buyPrice: Number((item.buyPrice || 0).toFixed(2)),
            yesterdayPrice: 0,
            currentPrice: 0,
            buyPriceYesterdayDiff: '0%',
            buyPriceDiff: '0%',
            note: item.note,
            tradingDate: null
          });
        }
      }
      io.to(userId.toString()).emit('watchlistUpdate', { success: true, total: enrichedItems.length, data: enrichedItems });
    }
    console.log('Watchlist cập nhật:', new Date().toLocaleString('vi-VN', { timeZone: TZ }));
  } catch (err) {
    console.error('Lỗi cập nhật watchlist:', err.message);
  } finally {
    updating = false;
  }
}

// Socket.IO với JWT handshake
io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.split(' ')[1];
    if (!token) return next(new Error('No token'));
    const user = jwt.verify(token, process.env.JWT_SECRET);
    socket.user = user;
    next();
  } catch (e) {
    next(e);
  }
});

io.on('connection', (socket) => {
  try {
    if (socket.user?.id) socket.join(socket.user.id.toString());
    console.log('Client connected:', socket.id, 'user:', socket.user?.id);
  } catch {}
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Lên lịch cập nhật watchlist mỗi 5 phút
cron.schedule('*/5 * * * *', () => {
  console.log('Bắt đầu cập nhật watchlist...');
  updateWatchlist();
});

// Controller cho watchlist (REST)
const watchlistController = {
  addStock: async (req, res) => {
    try {
      const { symbol, buyPrice, note } = req.body;
      if (!symbol) return res.status(400).json({ success: false, message: 'Vui lòng nhập mã cổ phiếu' });

      const existed = await Watchlist.findOne({ userId: req.user.id, symbol: symbol.toUpperCase() });
      if (existed) return res.status(400).json({ success: false, message: 'Mã cổ phiếu này đã có trong danh sách theo dõi' });

      const newItem = await Watchlist.create({
        userId: req.user.id,
        symbol: symbol.toUpperCase(),
        buyPrice: Number(buyPrice || 0),
        note
      });
      await updateWatchlist();
      res.json({
        success: true,
        message: 'Thêm thành công',
        data: { ...newItem._doc, buyPrice: Number((newItem.buyPrice || 0).toFixed(2)) }
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  },

  getWatchlist: async (req, res) => {
    try {
      const items = await Watchlist.find({ userId: req.user.id });
      const enrichedItems = [];
      for (const item of items) {
        try {
          const data = await fetchPriceAxios(item.symbol);
          if (data) {
            const yesterdayPrice = Number((data.basicPrice || 0).toFixed(2));
            const currentPrice = Number((data.matchPrice || 0).toFixed(2));
            const buyPrice = Number((item.buyPrice || 0).toFixed(2));
            const buyPriceYesterdayDiff =
              yesterdayPrice !== 0 ? (((currentPrice - yesterdayPrice) / yesterdayPrice) * 100).toFixed(2) : '0';
            const buyPriceDiff = buyPrice !== 0 ? (((currentPrice - buyPrice) / buyPrice) * 100).toFixed(2) : '0';
            enrichedItems.push({
              _id: item._id,
              symbol: item.symbol,
              buyPrice,
              yesterdayPrice,
              currentPrice,
              buyPriceYesterdayDiff: `${buyPriceYesterdayDiff}%`,
              buyPriceDiff: `${buyPriceDiff}%`,
              note: item.note,
              tradingDate: data.tradingDate
            });
          } else {
            enrichedItems.push({
              _id: item._id,
              symbol: item.symbol,
              buyPrice: Number((item.buyPrice || 0).toFixed(2)),
              yesterdayPrice: 0,
              currentPrice: 0,
              buyPriceYesterdayDiff: '0%',
              buyPriceDiff: '0%',
              note: item.note,
              tradingDate: null
            });
          }
        } catch (_error) {
          enrichedItems.push({
            _id: item._id,
            symbol: item.symbol,
            buyPrice: Number((item.buyPrice || 0).toFixed(2)),
            yesterdayPrice: 0,
            currentPrice: 0,
            buyPriceYesterdayDiff: '0%',
            buyPriceDiff: '0%',
            note: item.note,
            tradingDate: null
          });
        }
      }
      res.json({ success: true, total: enrichedItems.length, data: enrichedItems });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  },

  updateStock: async (req, res) => {
    try {
      const { id } = req.params;
      const { symbol, buyPrice, note } = req.body;
      const item = await Watchlist.findOneAndUpdate(
        { _id: id, userId: req.user.id },
        { symbol: symbol.toUpperCase(), buyPrice: Number(buyPrice || 0), note },
        { new: true }
      );
      if (!item) return res.status(404).json({ success: false, message: 'Không tìm thấy mục theo dõi' });
      await updateWatchlist();
      res.json({ success: true, message: 'Cập nhật thành công', data: { ...item._doc, buyPrice: Number((item.buyPrice || 0).toFixed(2)) } });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  },

  deleteStock: async (req, res) => {
    try {
      const { id } = req.params;
      const deleted = await Watchlist.findOneAndDelete({ _id: id, userId: req.user.id });
      if (!deleted) return res.status(404).json({ success: false, message: 'Không tìm thấy mục theo dõi' });
      await updateWatchlist();
      res.json({ success: true, message: 'Xóa thành công' });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  }
};

// =============================
// 10) AI CHAT: tools + endpoint (PROTECTED)
// =============================
const chatRouter = express.Router();

const aiTools = [
  {
    type: 'function',
    function: {
      name: 'getToday',
      description: 'Lấy thông tin cổ phiếu trong NGÀY HÔM NAY (múi giờ VN).',
      parameters: { type: 'object', properties: { symbol: { type: 'string', description: 'Ví dụ: FPT, VNM' } }, required: ['symbol'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'getYesterday',
      description: 'Lấy thông tin cổ phiếu NGÀY HÔM QUA (tự lùi đến phiên gần nhất nếu nghỉ).',
      parameters: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'getByDate',
      description: 'Lấy thông tin cổ phiếu theo ngày cụ thể (YYYY-MM-DD).',
      parameters: {
        type: 'object',
        properties: { symbol: { type: 'string' }, date: { type: 'string', description: 'YYYY-MM-DD' } },
        required: ['symbol', 'date']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'getRange',
      description: 'Lấy lịch sử giá trong N ngày gần đây.',
      parameters: {
        type: 'object',
        properties: { symbol: { type: 'string' }, days: { type: 'integer', description: 'Ví dụ 7 hoặc 30' } },
        required: ['symbol', 'days']
      }
    }
  }
];

const SYSTEM_PROMPT = `Bạn là trợ lý tài chính tiếng Việt cho thị trường chứng khoán Việt Nam.
Múi giờ: Asia/Bangkok.
Nhiệm vụ: hiểu câu hỏi tự nhiên như "FPT hôm nay", "VNM hôm qua", "FPT 7 ngày", "FPT ngày 2025-08-15".
- Luôn normalize mã về UPPERCASE.
- Khi có thể, GỌI ĐÚNG TOOL với tham số JSON (symbol, date, days).
- Trả lời ngắn gọn, liệt kê số chính: đóng cửa, +/- %, cao/thấp, khối lượng nếu có.
- Nếu thiếu symbol hoặc ngày, hãy hỏi lại NGẮN GỌN.
- Luôn kết thúc bằng JSON tóm tắt (một dòng) dạng: {"symbol":"FPT","date":"YYYY-MM-DD","close":...,"pct":...,"high":...,"low":...,"volume":...}`;

// Tiền xử lý regex đơn giản
function preparseVN(q) {
  const text = q.trim();
  const up = text.toUpperCase();
  const m = up.match(/\b([A-Z]{3,4})\b/); // FPT, VNM, HPG...
  const symbol = m ? m[1] : null;

  let intent = null;
  if (/HÔM\s*NAY/i.test(text)) intent = { name: 'getToday', args: { symbol } };
  else if (/HÔM\s*QUA/i.test(text)) intent = { name: 'getYesterday', args: { symbol } };
  else if (/\b(\d+)\s*(NGÀY|DAY|D)\b/i.test(text)) {
    const days = Number(text.match(/\b(\d+)\s*(NGÀY|DAY|D)\b/i)[1]);
    intent = { name: 'getRange', args: { symbol, days } };
  } else if (/\d{4}-\d{2}-\d{2}/.test(text)) {
    const date = text.match(/\d{4}-\d{2}-\d{2}/)[0];
    intent = { name: 'getByDate', args: { symbol, date } };
  }
  return symbol && intent ? intent : null;
}

const toolMap = {
  getToday: stockInfoController.getToday,
  getYesterday: stockInfoController.getYesterday,
  getByDate: stockInfoController.getByDate,
  getRange: stockInfoController.getRange
};
function buildStockReportPrompt({ code, today, avgVolume10d, RSI }) {
  return `
Dưới đây là dữ liệu cổ phiếu ${code} hôm nay:

- Giá tham chiếu: ${today.referencePrice}
- Giá mở cửa: ${today.open}
- Cao nhất: ${today.high}
- Thấp nhất: ${today.low}
- Giá đóng cửa: ${today.close} (${today.change} | ${today.percentChange}%)
- Biên độ dao động: ${today.low} – ${today.high}
- Khối lượng: ${today.volume}
- Khối lượng trung bình 10 phiên: ${avgVolume10d?.toFixed(0)}
- RSI(14): ${RSI || "N/A"}

Hãy viết báo cáo chi tiết bằng tiếng Việt theo cấu trúc:
1. Giá giao dịch.
2. Thanh khoản & khối lượng so với trung bình.
3. Biến động so với tham chiếu.
4. Phân tích kỹ thuật (RSI, tín hiệu mua/bán).
5. Dự báo/khuyến nghị (3–5 câu).
`;
}


// BẮT BUỘC TOKEN CHO CHAT QUERY
chatRouter.post('/query', authMiddleware, async (req, res) => {
  try {
    const userQuery = (req.body?.query || req.body?.text || '').trim();
    if (!userQuery) return res.status(400).json({ success: false, message: 'Thiếu query' });

    // ===== PATCH: BÁO CÁO CHI TIẾT =====
    const baoCaoChiTietMatch = userQuery.match(/báo\s*cáo\s*chi\s*tiết.*\b([A-Z]{2,5})\b.*hôm\s*nay/i);
    if (baoCaoChiTietMatch) {
      const code = baoCaoChiTietMatch[1].toUpperCase();

      // 1. Lấy dữ liệu giá hôm nay
      const fakeReqToday = { body: { symbol: code }, headers: req.headers, user: req.user };
      const fakeResToday = {
        _payload: null,
        status(c) { this._status = c; return this; },
        json(o) { this._payload = o; }
      };
      await stockInfoController.getToday(fakeReqToday, fakeResToday);
      const today = fakeResToday._payload?.data;
      if (!today) return res.json({ success: false, message: `Không có dữ liệu hôm nay cho ${code}` });

      // 2. Lấy lịch sử 10 phiên gần nhất
      const fakeReqRange = { body: { symbol: code, days: 10 }, headers: req.headers, user: req.user };
      const fakeResRange = {
        _payload: null,
        status(c) { this._status = c; return this; },
        json(o) { this._payload = o; }
      };
      await stockInfoController.getRange(fakeReqRange, fakeResRange);
      const rows = fakeResRange._payload?.data || [];
      const avgVolume10d =
        rows.length > 0
          ? rows.reduce((sum, r) => sum + (Number(r.volume) || 0), 0) / rows.length
          : 0;

      // 3. Tính RSI(14)
      function calcRSI(data, period = 14) {
        if (data.length < period + 1) return null;
        let gains = 0, losses = 0;
        for (let i = 1; i <= period; ++i) {
          const change = (data[i].close || 0) - (data[i - 1].close || 0);
          if (change > 0) gains += change;
          else losses -= change;
        }
        if (gains + losses === 0) return null;
        const rs = gains / (losses || 1);
        return (100 - 100 / (1 + rs)).toFixed(2);
      }
      const RSI = calcRSI(rows.slice(-15));

      // 4. Build prompt & call OpenAI
      const prompt = buildStockReportPrompt({ code, today, avgVolume10d, RSI });

      const gptRes = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'Bạn là chuyên gia chứng khoán Việt Nam.' },
          { role: 'user', content: prompt }
        ],
        max_tokens: 600,
        temperature: 0.55,
      });

      const answer = gptRes.choices?.[0]?.message?.content?.trim();

      const conversationId = req.body.conversationId || 'default';
      await ChatMessage.create({ userId: req.user.id, conversationId, from: 'user', text: userQuery });
      await ChatMessage.create({ userId: req.user.id, conversationId, from: 'bot', text: answer });

      return res.json({ success: true, answer, prompt });
    }
    // ===== END PATCH: BÁO CÁO CHI TIẾT =====

    // ======= Fallback: intent tool nhanh =======
    const fallback = preparseVN(userQuery);
    if (fallback && fallback.args.symbol) {
      const fakeReq = { body: fallback.args, headers: req.headers, user: req.user };
      const fakeRes = {
        _payload: null,
        status(c) { this._status = c; return this; },
        json(o) { this._payload = o; }
      };
      await toolMap[fallback.name](fakeReq, fakeRes);
      const payload = fakeRes._payload || { success: false };
      const conversationId = req.body.conversationId || 'default';
      await ChatMessage.create({ userId: req.user.id, conversationId, from: 'user', text: userQuery });
      await ChatMessage.create({ userId: req.user.id, conversationId, from: 'bot', text: JSON.stringify(payload) });

      return res.json(payload);
    }

    // ======= AI chọn tool =======
    const first = await openai.responses.create({
      model: 'gpt-4o-mini',
      input: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userQuery }
      ],
      tools: aiTools
    });

    const segments = Array.isArray(first.output) ? first.output : [];
    const toolCalls = segments.filter((seg) => seg.type === 'tool_call' && seg.tool_call).map((seg) => seg.tool_call);

    // Không gọi tool → trả text luôn
    if (!toolCalls.length) {
      const conversationId = req.body.conversationId || 'default';
      await ChatMessage.create({ userId: req.user.id, conversationId, from: 'user', text: userQuery });
      await ChatMessage.create({ userId: req.user.id, conversationId, from: 'bot', text: first.output_text });

      return res.json({ success: true, answer: first.output_text });
    }

    // Thực thi tool và gom output
    const toolOutputs = [];
    for (const call of toolCalls) {
      const { name, arguments: args, id } = call;
      const handler = toolMap[name];
      if (!handler) continue;
      const fakeReq = { body: args, headers: req.headers, user: req.user };
      const fakeRes = {
        _payload: null,
        status(code) { this._status = code; return this; },
        json(obj) { this._payload = obj; }
      };
      await handler(fakeReq, fakeRes);
      const result = fakeRes._payload || { success: false, message: 'No payload' };
      toolOutputs.push({ tool_call_id: id, output: JSON.stringify(result) });
    }

    // Model đọc lại tool_outputs
    const second = await openai.responses.create({
      model: 'gpt-4o-mini',
      input: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userQuery }
      ],
      tools: aiTools,
      tool_outputs: toolOutputs
    });

    const answer = second.output_text;

    const conversationId = req.body.conversationId || 'default';
    await ChatMessage.create({ userId: req.user.id, conversationId, from: 'user', text: userQuery });
    await ChatMessage.create({ userId: req.user.id, conversationId, from: 'bot', text: answer });

    const debug = req.query.debug === '1';
    return res.json(
      debug
        ? { success: true, answer, tool_outputs: toolOutputs, openai_ids: { first: first.id, second: second.id } }
        : { success: true, answer }
    );
  } catch (err) {
    console.error('AI chat error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});



// /api/chat/history
chatRouter.get('/history', authMiddleware, async (req, res) => {
  try {
    const messages = await ChatMessage.find({ userId: req.user.id }).sort({ createdAt: 1 });
    // Group theo conversationId
    const grouped = {};
    for (const m of messages) {
      const cid = m.conversationId || 'default';
      if (!grouped[cid]) grouped[cid] = [];
      grouped[cid].push(m);
    }
    // Dạng [{ conversationId, messages, title }]
    const conversations = Object.entries(grouped).map(([cid, msgs]) => ({
      conversationId: cid,
      messages: msgs,
      title: msgs[0]?.text?.slice(0, 40) || 'Đoạn chat'
    }));
    res.json({ success: true, conversations });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});


// =============================
// 11) ROUTERS
// =============================
const stockInfoRouter = express.Router();
stockInfoRouter.post('/', authMiddleware, stockInfoController.getToday);
stockInfoRouter.post('/yesterday', authMiddleware, stockInfoController.getYesterday);
stockInfoRouter.post('/by-date', authMiddleware, stockInfoController.getByDate);
stockInfoRouter.post('/range', authMiddleware, stockInfoController.getRange);

const authRouter = express.Router();
authRouter.post('/register', authController.register);
authRouter.post('/login', authController.login);
authRouter.get('/profile', authMiddleware, (req, res) => {
  res.json({ success: true, user: req.user });
});

const stocksRouter = express.Router();
stocksRouter.get('/', stocksController.getStocksData);
stocksRouter.get('/trades/:symbol', stocksController.getStockTrades);
stocksRouter.get('/search', stocksController.searchStock);
stocksRouter.get('/history/:symbol', stocksController.getStockHistory);
stocksRouter.get('/top-gainers', stocksController.getTopGainers);
stocksRouter.get('/top-losers', stocksController.getTopLosers);

const newsRouter = express.Router();
// JSON đặt trước để không bị ":symbol" nuốt
newsRouter.get('/json', newsController.parsedJson); // /api/news/json?q=...
newsRouter.get('/json/:symbol', newsController.parsedJson); // /api/news/json/HPG?range=7d
// XML sau
newsRouter.get('/', newsController.proxyXml); // /api/news?q=HPG
newsRouter.get('/:symbol', newsController.proxyXml); // /api/news/HPG?range=1d

const watchlistRouter = express.Router();
watchlistRouter.post('/', authMiddleware, watchlistController.addStock);
watchlistRouter.get('/', authMiddleware, watchlistController.getWatchlist);
watchlistRouter.put('/:id', authMiddleware, watchlistController.updateStock);
watchlistRouter.delete('/:id', authMiddleware, watchlistController.deleteStock);

// =============================
// 12) MOUNT ROUTERS + STATIC + HEALTH
//  → TOÀN BỘ API (trừ /api/auth/register, /api/auth/login) đều cần token
// =============================
app.use('/api/auth', authRouter);

// Bảo vệ toàn bộ nhóm còn lại
app.use('/api/stocks', authMiddleware, stocksRouter);
app.use('/api/news', authMiddleware, newsRouter);
app.use('/api/watchlist', authMiddleware, watchlistRouter);
app.use('/api/stock-info', authMiddleware, stockInfoRouter);
app.use('/api/chat', authMiddleware, chatRouter);

// static
app.use(express.static('public'));

// health
app.get('/', (_req, res) => {
  res.json({ message: 'API is running 🚀' });
});
app.get('/api/chat/_debug', authMiddleware, async (req, res) => {
  try {
    const last = await ChatMessage.find({ userId: req.user.id })
      .sort({ createdAt: -1 })
      .limit(10);
    res.json({
      db: {
        url: process.env.DB_URL,
        host: mongoose.connection.host,
        name: mongoose.connection.name,
      },
      count: last.length,
      last,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// =============================
// 13) START SERVER
// =============================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
