const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');

const BASE = 'https://api.bilibili.tv/intl/gateway/web';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, Referer: 'https://www.bilibili.tv/', Origin: 'https://www.bilibili.tv' };
const LOCALE = 'en_US';
const PAGE_SIZE = 20;

const manifest = {
    id: 'org.bilibilicustom.addon',
    version: '1.4.0',
    name: 'Bilibili TV Addon',
    description: 'Katalog dan streaming dari Bilibili.tv',
    resources: ['catalog', 'meta', 'stream'],
    types: ['movie', 'series'],
    catalogs: [
        {
            type: 'series',
            id: 'bili_series',
            name: 'Bilibili - Series / Anime',
            extra: [
                { name: 'search', isRequired: false },
                { name: 'skip', isRequired: false }
            ]
        },
        {
            type: 'movie',
            id: 'bili_trending',
            name: 'Bilibili - Videos',
            extra: [
                { name: 'search', isRequired: false },
                { name: 'skip', isRequired: false }
            ]
        }
    ],
    idPrefixes: ['bili_']
};

const builder = new addonBuilder(manifest);
const http = axios.create({ timeout: 7000, headers: HEADERS });

// Cache sederhana (hanya hidup selama instance serverless masih aktif)
const infoCache = new Map();

// ID: bili_ep_123 (episode), bili_ss_123 (season/series), bili_av_123 (video biasa)
function parseId(id) {
    const m = /^bili_(ep|ss|av)_(\d+)$/.exec(id || '');
    return m ? { kind: m[1], num: m[2] } : null;
}

async function searchBili(keyword, page = 1) {
    const { data } = await http.get(`${BASE}/v2/search_v2`, {
        params: { keyword, s_locale: LOCALE, platform: 'web', pn: page, ps: PAGE_SIZE }
    });
    return data;
}

const clean = t => String(t || '').replace(/<[^>]+>/g, '').trim();

// Telusuri respons: objek yang punya judul + salah satu ID
function collectItems(node, out, seen) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
        node.forEach(n => collectItems(n, out, seen));
        return;
    }
    const title = typeof node.title === 'string' ? node.title : (typeof node.name === 'string' ? node.name : null);
    let id = null;
    let type = 'movie';
    if (node.season_id) { id = `bili_ss_${node.season_id}`; type = 'series'; }
    else if (node.episode_id) id = `bili_ep_${node.episode_id}`;
    else if (node.aid) id = `bili_av_${node.aid}`;

    if (title && id && !seen.has(id)) {
        seen.add(id);
        const item = {
            id,
            type,
            name: clean(title),
            poster: node.cover || node.vertical_cover || node.horizontal_cover || node.image || undefined,
            posterShape: 'poster',
            description: clean(node.intro || node.desc || node.subtitle || '')
        };
        infoCache.set(id, item);
        out.push(item);
        return;
    }
    Object.values(node).forEach(v => collectItems(v, out, seen));
}

builder.defineCatalogHandler(async (args) => {
    try {
        const extra = (args && args.extra) || {};
        const skip = parseInt(extra.skip, 10) || 0;
        const page = Math.floor(skip / PAGE_SIZE) + 1;
        const keyword = extra.search && extra.search.trim() ? extra.search.trim() : 'anime';

        const data = await searchBili(keyword, page);
        const all = [];
        collectItems(data && data.data, all, new Set());

        const wantSeries = args.type === 'series';
        const metas = all
            .filter(m => (wantSeries ? m.type === 'series' : m.type !== 'series'))
            .map(m => ({ ...m, type: wantSeries ? 'series' : 'movie' }));
        return { metas, cacheMaxAge: 900 };
    } catch (err) {
        console.error('catalog error:', err.message);
        return { metas: [] };
    }
});

async function fetchEpisodes(seasonId) {
    const { data } = await http.get(`${BASE}/v2/ogv/play/episodes`, {
        params: { season_id: seasonId, platform: 'web', s_locale: LOCALE }
    });
    const eps = [];
    (function walk(n) {
        if (!n || typeof n !== 'object') return;
        if (Array.isArray(n)) return n.forEach(walk);
        if (n.episode_id) eps.push(n);
        else Object.values(n).forEach(walk);
    })(data && data.data);
    return { raw: data, eps };
}

builder.defineMetaHandler(async (args) => {
    const parsed = parseId(args.id);
    const cached = infoCache.get(args.id) || {};
    try {
        if (parsed && parsed.kind === 'ss') {
            const { eps } = await fetchEpisodes(parsed.num);
            const videos = eps.map((e, i) => {
                const n = i + 1;
                const label = clean(e.title_display || e.short_title || e.title || '');
                return {
                    id: `bili_ep_${e.episode_id}`,
                    title: label || `Episode ${n}`,
                    season: 1,
                    episode: n,
                    thumbnail: e.cover || undefined,
                    // Stremio/Nuvio mengurutkan lewat tanggal rilis
                    released: new Date(Date.UTC(2000, 0, n)).toISOString()
                };
            });
            return {
                meta: {
                    id: args.id,
                    type: 'series',
                    name: cached.name || 'Bilibili Series',
                    poster: cached.poster,
                    background: cached.poster,
                    description: cached.description || '',
                    videos
                }
            };
        }
        return {
            meta: {
                id: args.id,
                type: 'movie',
                name: cached.name || 'Bilibili Video',
                poster: cached.poster,
                background: cached.poster,
                description: cached.description || ''
            }
        };
    } catch (err) {
        console.error('meta error:', err.message);
        return { meta: { id: args.id, type: parsed && parsed.kind === 'ss' ? 'series' : 'movie', name: cached.name || 'Bilibili' } };
    }
});

async function fetchPlay(kind, num) {
    const params = {
        s_locale: LOCALE,
        platform: 'web',
        qn: 64,
        type: 0,
        device: 'wap',
        tf: 0
    };
    if (kind === 'av') params.aid = num;
    else params.ep_id = num;
    const { data } = await http.get(`${BASE}/playurl`, { params });
    return data;
}

function extractStreams(data) {
    const hints = {
        notWebReady: true,
        proxyHeaders: { request: { Referer: 'https://www.bilibili.tv/', 'User-Agent': UA } }
    };
    const pu = data && data.data && data.data.playurl;
    const streams = [];
    if (!pu || !Array.isArray(pu.video)) return streams;

    for (const v of pu.video) {
        const r = v.video_resource;
        if (!r || !r.url) continue;
        const codec = String(r.codecs || '');
        const info = v.stream_info || {};
        const label = info.desc_words || info.display_desc || (r.height ? r.height + 'p' : 'Bilibili');
        streams.push({
            name: 'Bilibili',
            title: `${label}${codec ? ' • ' + codec.split('.')[0] : ''}`,
            url: r.url,
            behaviorHints: hints
        });
    }
    streams.sort((a, b) => (/avc1/.test(b.title) ? 1 : 0) - (/avc1/.test(a.title) ? 1 : 0));
    return streams;
}

async function resolveAndPlay(id) {
    const parsed = parseId(id);
    if (!parsed) return { steps: ['id tidak dikenali'], data: null };
    const steps = [];
    let { kind, num } = parsed;
    if (kind === 'ss') {
        const { eps } = await fetchEpisodes(num);
        steps.push(`season ${num} punya ${eps.length} episode`);
        if (!eps.length) return { steps, data: null };
        kind = 'ep';
        num = String(eps[0].episode_id);
        steps.push(`memakai episode pertama ${num}`);
    }
    const data = await fetchPlay(kind, num);
    steps.push(`playurl code=${data && data.code} message=${data && data.message}`);
    return { steps, data };
}

builder.defineStreamHandler(async (args) => {
    try {
        const { data } = await resolveAndPlay(args.id);
        return { streams: extractStreams(data), cacheMaxAge: 300 };
    } catch (err) {
        console.error('stream error:', err.message);
        return { streams: [] };
    }
});

const app = express();
app.use(cors());

const wrap = fn => async (req, res) => {
    try {
        res.json(await fn(req));
    } catch (e) {
        res.json({ error: e.message, status: e.response && e.response.status });
    }
};

app.get('/debug/search', wrap(async req => {
    const data = await searchBili(req.query.q || 'anime', 1);
    const items = [];
    collectItems(data && data.data, items, new Set());
    return {
        code: data && data.code,
        found: items.length,
        series: items.filter(i => i.type === 'series').length,
        firstItems: items.slice(0, 5).map(i => ({ id: i.id, name: i.name }))
    };
}));

// Telusuri seluruh proses stream untuk satu ID, contoh: /debug/id/bili_ss_34661
app.get('/debug/id/:id', wrap(async req => {
    const { steps, data } = await resolveAndPlay(req.params.id);
    const streams = extractStreams(data);
    const pu = data && data.data && data.data.playurl;
    return {
        steps,
        streamCount: streams.length,
        titles: streams.map(s => s.title),
        hasAudioResource: !!(pu && pu.audio_resource),
        rawSample: JSON.stringify(data).slice(0, 700).replace(/https?:\/\/[^"]+/g, '[url]')
    };
}));

app.get('/debug/season/:id', wrap(async req => {
    const { raw, eps } = await fetchEpisodes(req.params.id);
    return {
        episodeCount: eps.length,
        firstEpisodeKeys: eps[0] ? Object.keys(eps[0]) : [],
        rawSample: JSON.stringify(raw).slice(0, 500).replace(/https?:\/\/[^"]+/g, '[url]')
    };
}));

app.get('/', (req, res) => res.redirect('/manifest.json'));
app.use('/', getRouter(builder.getInterface()));

module.exports = app;
