require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'db.json');
const TEMPLATE_FILE = path.join(__dirname, 'db.template.json');

// 访问密码配置
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || '';
const PASSWORD_HASH = ACCESS_PASSWORD ? crypto.createHash('sha256').update(ACCESS_PASSWORD).digest('hex') : '';

// 远程配置URL
const REMOTE_DB_URL = process.env.REMOTE_DB_URL || '';

// 远程配置缓存
let remoteDbCache = null;
let remoteDbLastFetch = 0;
const REMOTE_DB_CACHE_TTL = 5 * 60 * 1000; // 5分钟缓存

// 缓存配置
const CACHE_TYPE = process.env.CACHE_TYPE || 'json'; // json, sqlite, memory, none
const SEARCH_CACHE_JSON = path.join(__dirname, 'cache_search.json');
const DETAIL_CACHE_JSON = path.join(__dirname, 'cache_detail.json');
const CACHE_DB_FILE = path.join(__dirname, 'cache.db');

console.log(`[System] Cache Type: ${CACHE_TYPE}`);

// 初始化数据库文件
if (!fs.existsSync(DATA_FILE)) {
    if (fs.existsSync(TEMPLATE_FILE)) {
        fs.copyFileSync(TEMPLATE_FILE, DATA_FILE);
        console.log('[Init] 已从模板创建 db.json');
    } else {
        const initialData = { sites: [] };
        fs.writeFileSync(DATA_FILE, JSON.stringify(initialData, null, 2));
        console.log('[Init] 已创建默认 db.json');
    }
}

// ========== 缓存抽象层 ==========
class CacheManager {
    constructor(type) {
        this.type = type;
        this.store = {}; // Memory store
        this.jsonStore = { search: {}, detail: {} }; // JSON Store

        // Init
        if (this.type === 'sqlite') {
            this.initSQLite();
        } else if (this.type === 'json') {
            this.initJSON();
        }
    }

    initSQLite() {
        try {
            const Database = require('better-sqlite3');
            this.db = new Database(CACHE_DB_FILE);
            this.db.pragma('journal_mode = WAL');
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS search_cache (
                    keyword TEXT PRIMARY KEY, data TEXT NOT NULL, ttl INTEGER DEFAULT 0, created_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS detail_cache (
                    cache_key TEXT PRIMARY KEY, data TEXT NOT NULL, created_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_search_created ON search_cache(created_at);
            `);
            console.log('[Cache] SQLite initialized');
        } catch (e) {
            console.error('[Cache] Failed to load better-sqlite3. Fallback to memory cache.', e.message);
            this.type = 'memory';
        }
    }

    initJSON() {
        try {
            if (fs.existsSync(SEARCH_CACHE_JSON)) this.jsonStore.search = JSON.parse(fs.readFileSync(SEARCH_CACHE_JSON, 'utf8'));
            if (fs.existsSync(DETAIL_CACHE_JSON)) this.jsonStore.detail = JSON.parse(fs.readFileSync(DETAIL_CACHE_JSON, 'utf8'));
            console.log(`[Cache] JSON loaded (Search: ${Object.keys(this.jsonStore.search).length}, Detail: ${Object.keys(this.jsonStore.detail).length})`);
        } catch (e) { console.error('[Cache] JSON load error', e); }
    }

    saveJSON(type) {
        try {
            // 简单的 LRU 清理：超过数量限制删最旧的
            const MAX_ENTRIES = type === 'search' ? 300 : 500;
            const file = type === 'search' ? SEARCH_CACHE_JSON : DETAIL_CACHE_JSON;
            const data = this.jsonStore[type];

            const keys = Object.keys(data);
            if (keys.length > MAX_ENTRIES) {
                const sorted = keys.map(k => ({ k, ts: data[k].ts || 0 })).sort((a, b) => a.ts - b.ts);
                sorted.slice(0, keys.length - MAX_ENTRIES).forEach(i => delete data[i.k]);
            }
            fs.writeFileSync(file, JSON.stringify(data), 'utf8');
        } catch (e) { }
    }

    // --- Search Cache Interface ---
    getSearch(keyword) {
        if (this.type === 'none') return null;
        const key = keyword.toLowerCase();

        if (this.type === 'sqlite') {
            const row = this.db.prepare('SELECT data, ttl, created_at FROM search_cache WHERE keyword = ?').get(key);
            if (!row) return null;
            if (row.ttl > 0 && (Date.now() - row.created_at > row.ttl * 1000)) return null;
            return { data: JSON.parse(row.data), ttl: row.ttl, ts: row.created_at };
        }

        let item = this.type === 'json' ? this.jsonStore.search[key] : this.store[`s_${key}`];
        if (!item) return null;

        // 兼容旧数组格式
        if (Array.isArray(item)) item = { data: item, ttl: 0, ts: 0 };

        if (item.ttl > 0 && item.ts && (Date.now() - item.ts > item.ttl * 1000)) {
            if (this.type === 'json') delete this.jsonStore.search[key];
            else delete this.store[`s_${key}`];
            return null;
        }
        return item;
    }

    setSearch(keyword, data, ttl = 0) {
        if (this.type === 'none') return;
        const key = keyword.toLowerCase();
        const now = Date.now();

        if (this.type === 'sqlite') {
            this.db.prepare('INSERT OR REPLACE INTO search_cache (keyword, data, ttl, created_at) VALUES (?, ?, ?, ?)').run(key, JSON.stringify(data), ttl, now);
        } else if (this.type === 'json') {
            this.jsonStore.search[key] = { data, ttl, ts: now };
            this.saveJSON('search');
        } else {
            this.store[`s_${key}`] = { data, ttl, ts: now };
        }
    }

    // --- Detail Cache Interface ---
    getDetail(key) {
        if (this.type === 'none') return null;

        if (this.type === 'sqlite') {
            const row = this.db.prepare('SELECT data FROM detail_cache WHERE cache_key = ?').get(key);
            return row ? JSON.parse(row.data) : null;
        }

        return this.type === 'json' ? this.jsonStore.detail[key] : this.store[`d_${key}`];
    }

    setDetail(key, data) {
        if (this.type === 'none') return;

        if (this.type === 'sqlite') {
            this.db.prepare('INSERT OR REPLACE INTO detail_cache (cache_key, data, created_at) VALUES (?, ?, ?)').run(key, JSON.stringify(data), Date.now());
        } else if (this.type === 'json') {
            this.jsonStore.detail[key] = data; // 详情暂无TTL和TS结构，直接存对象
            this.saveJSON('detail');
        } else {
            this.store[`d_${key}`] = data;
        }
    }
}

const cache = new CacheManager(CACHE_TYPE);

app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

// 从远程URL获取配置（带缓存）
async function fetchRemoteDB() {
    const now = Date.now();
    if (remoteDbCache && (now - remoteDbLastFetch < REMOTE_DB_CACHE_TTL)) {
        return remoteDbCache;
    }

    try {
        console.log(`[RemoteDB] Fetching from: ${REMOTE_DB_URL}`);
        const response = await axios.get(REMOTE_DB_URL, { timeout: 10000 });
        remoteDbCache = response.data;
        remoteDbLastFetch = now;
        console.log(`[RemoteDB] Loaded ${remoteDbCache.sites?.length || 0} sites`);
        return remoteDbCache;
    } catch (e) {
        console.error('[RemoteDB] Fetch failed:', e.message);
        // 如果远程获取失败，回退到缓存或本地
        if (remoteDbCache) return remoteDbCache;
        return getLocalDB();
    }
}

// 从本地文件获取配置
function getLocalDB() {
    try {
        if (!fs.existsSync(DATA_FILE)) return { sites: [] };
        return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch (e) { return { sites: [] }; }
}

// 统一的配置获取函数
async function getDBAsync() {
    if (REMOTE_DB_URL) {
        return await fetchRemoteDB();
    }
    return getLocalDB();
}

// 同步版本（用于需要同步访问的地方）
function getDB() {
    if (REMOTE_DB_URL && remoteDbCache) {
        return remoteDbCache;
    }
    return getLocalDB();
}

// === API Routes ===

// 密码验证接口
app.post('/api/auth/verify', (req, res) => {
    const { passwordHash } = req.body;

    if (!PASSWORD_HASH) {
        // 没有设置密码，直接通过
        return res.json({ success: true, message: 'No password required' });
    }

    if (passwordHash === PASSWORD_HASH) {
        return res.json({ success: true, message: 'Password verified' });
    }

    return res.status(401).json({ success: false, message: 'Invalid password' });
});

// 检查是否需要密码的接口
app.get('/api/auth/check', (req, res) => {
    res.json({
        requirePassword: !!PASSWORD_HASH,
        // 不返回密码哈希，只返回是否需要密码
    });
});

// 1. 真实测速接口
app.get('/api/check', async (req, res) => {
    const { key } = req.query;
    const db = await getDBAsync();
    const site = db.sites.find(s => s.key === key);
    if (!site) return res.json({ latency: 9999 });

    const start = Date.now();
    try {
        await axios.get(`${site.api}?ac=list&pg=1`, { timeout: 3000 });
        res.json({ latency: Date.now() - start });
    } catch (e) {
        res.json({ latency: 9999 });
    }
});

// 2. 热门接口
app.get('/api/hot', async (req, res) => {
    const db = await getDBAsync();
    const sites = db.sites.filter(s => ['ffzy', 'bfzy', 'lzi', 'dbzy'].includes(s.key));
    for (const site of sites) {
        try {
            const response = await axios.get(`${site.api}?ac=list&pg=1&h=24&out=json`, { timeout: 3000 });
            const list = response.data.list || response.data.data;
            if (list && list.length > 0) return res.json({ list: list.slice(0, 12) });
        } catch (e) { continue; }
    }
    res.json({ list: [] });
});

// 3. 搜索接口
app.get('/api/search', async (req, res) => {
    const { wd, stream } = req.query;
    console.log(`[Search] ${wd} (Stream: ${stream})`);
    if (!wd) return res.json({ list: [] });

    // Cache Check
    const cachedItem = cache.getSearch(wd);
    if (cachedItem) {
        console.log(`[Search] Cache Hit: ${wd} (${cachedItem.data.length} items)`);
        if (stream === 'true') {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.write(`data: ${JSON.stringify(cachedItem.data)}\n\n`);
            res.write('event: done\ndata: {}\n\n');
            return res.end();
        }
        return res.json({ list: cachedItem.data });
    }

    const db = await getDBAsync();
    const sites = db.sites.filter(s => s.active);
    let allResults = [];

    // --- Stream Mode ---
    if (stream === 'true') {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        const promises = sites.map(async (site) => {
            try {
                const connector = site.api.includes('?') ? '&' : '?';
                let url = `${site.api}${connector}ac=list&wd=${encodeURIComponent(wd)}`;
                if (!url.includes('out=json')) url += '&out=json';

                const response = await axios.get(url, { timeout: 4000 }); // 稍微长一点的超时给流式
                const list = response.data.list || response.data.data;
                if (list && Array.isArray(list) && list.length > 0) {
                    const results = list.map(item => ({
                        ...item,
                        site_key: site.key,
                        site_name: site.name
                    }));
                    allResults = allResults.concat(results);
                    // Push chunk
                    res.write(`data: ${JSON.stringify(results)}\n\n`);
                }
            } catch (e) { }
        });

        await Promise.allSettled(promises);

        // Save Cache
        if (allResults.length > 0) {
            const currentYear = new Date().getFullYear();
            const hasNewContent = allResults.some(item => {
                const y = parseInt(item.vod_year);
                return !isNaN(y) && y >= currentYear - 1;
            });
            const ttl = hasNewContent ? 3600 : 0;
            cache.setSearch(wd, allResults, ttl);
        }

        res.write('event: done\ndata: {}\n\n');
        return res.end();
    }

    // --- Legacy Mode (Wait All) ---
    // 为了结果完整，取消早停，等待所有结果
    const promises = sites.map(async (site) => {
        try {
            const connector = site.api.includes('?') ? '&' : '?';
            let url = `${site.api}${connector}ac=list&wd=${encodeURIComponent(wd)}`;
            if (!url.includes('out=json')) url += '&out=json';

            const response = await axios.get(url, { timeout: 3000 });
            const list = response.data.list || response.data.data;
            if (list && Array.isArray(list) && list.length > 0) {
                const results = list.map(item => ({
                    ...item,
                    site_key: site.key,
                    site_name: site.name
                }));
                allResults = allResults.concat(results);
            }
        } catch (e) { }
    });

    await Promise.allSettled(promises);

    if (allResults.length > 0) {
        const currentYear = new Date().getFullYear();
        const hasNewContent = allResults.some(item => {
            const y = parseInt(item.vod_year);
            return !isNaN(y) && y >= currentYear - 1;
        });
        const ttl = hasNewContent ? 3600 : 0;
        cache.setSearch(wd, allResults, ttl);
        console.log(`[Search] Cached: ${wd} (${allResults.length} items) - TTL: ${ttl}`);
    }

    console.log(`[Search] Return ${allResults.length} items (Full)`);
    res.json({ list: allResults });
});

// 4. 详情接口
app.get('/api/detail', async (req, res) => {
    const { site_key, id } = req.query;
    const cacheKey = `${site_key}_${id}`;

    // Cache Check
    const cachedData = cache.getDetail(cacheKey);
    if (cachedData) return res.json(cachedData);

    const db = await getDBAsync();
    const site = db.sites.find(s => s.key === site_key);
    if (!site) return res.status(404).json({ error: "Site not found" });

    try {
        const connector = site.api.includes('?') ? '&' : '?';
        let url = `${site.api}${connector}ac=detail&ids=${id}`;
        if (!url.includes('out=json')) url += '&out=json';

        console.log(`[Detail] Requesting: ${url}`);
        const response = await axios.get(url, { timeout: 6000 });
        const data = response.data;

        if (typeof data === 'string' && data.trim().startsWith('<')) throw new Error("XML received");

        if (data && (data.list || data.data)) {
            cache.setDetail(cacheKey, data);
        }
        res.json(data);
    } catch (e) {
        console.error(`[Detail Error] ${site.name}: ${e.message}`);
        res.status(500).json({ error: "Source Error" });
    }
});

// 5. 配置接口
app.get('/api/config', (req, res) => {
    res.json({
        tmdb_api_key: process.env.TMDB_API_KEY || '',
        tmdb_proxy_url: process.env.TMDB_PROXY_URL || ''
    });
});

// 6. 站点接口
app.get('/api/sites', async (req, res) => {
    const db = await getDBAsync();
    const sites = db.sites.filter(s => s.active);
    res.json({ sites: sites.map(s => ({ key: s.key, name: s.name, api: s.api })) });
});

app.listen(PORT, () => { console.log(`服务已启动: http://localhost:${PORT}`); });

// 启动时预加载远程配置
(async () => {
    if (REMOTE_DB_URL) {
        console.log('[Startup] Remote DB URL configured, pre-fetching...');
        await fetchRemoteDB();
        console.log(`[Config] Using remote db.json: ${REMOTE_DB_URL}`);
    }
    if (ACCESS_PASSWORD) {
        console.log('[Security] Password protection enabled');
    }
})();
