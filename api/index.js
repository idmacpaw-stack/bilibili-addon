const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');

const BASE = 'https://api.bilibili.tv/intl/gateway/web';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, Referer: 'https://www.bilibili.tv/', Origin: 'https://www.bilibili.tv' };
const LOCALE = 'en_US';

const manifest = {
    id: 'org.bilibilicustom.addon',
    version: '1.3.0',
    name: 'Bilibili TV Addon',
    description: 'Katalog dan streaming dari Bilibili.tv',
    resources: ['catalog', 'meta', 'stream'],
    types: ['movie'],
    catalogs: [
        {
            type: 'movie',
            id: 'bili_trending',
            name: 'Bilibili - Trending',
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

// ID: bili_ep_123 (episode), bili_ss_123 (season), bili_av_123 (video biasa)
function parseId(id) {
    const m = /^bili_(ep|ss|av)_(\d+)$/.exec(id);
    return m ? { kind: m[1], num: m[2] } : null;
}

const PAGE_SIZE = 20;

async function searchBili(keyword, page = 1) {
    const { data } = await http.get(`${BASE}/v2/search_v2`, {
        params: { keyword, s_locale: LOCALE, platform: 'web', pn: page, ps: PAGE_SIZE }
    });
    return data;
}

// Struktur respons pencarian belum pasti, jadi kita telusuri semua objek
// yang punya judul + salah satu ID (episode_id / season_id / aid).
function collectItems(node, out, seen) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
        node.forEach(n => collectItems(n, out, seen));
        return;
    }
    const title = typeof node.title === 'string' ? node.title : (typeof node.name === 'string' ? node.name : null);
    let id = null;
    if (node.episode_id) id = `bili_ep_${node.episode_id}`;
    else if (node.season_id) id = `bili_ss_${node.season_id}`;
    else if (node.aid) id = `bili_av_${node.aid}`;

    if (title && id && !seen.has(id)) {
        seen.add(id);
        out.push({
            id,
            type: 'movie',
            name: title.replace(/<[^>]+>/g, ''),
            poster: node.cover || node.vertical_cover || node.horizontal_cover || node.image || undefined,
            posterShape: 'poster',
            description: node.intro || node.desc || node.subtitle || ''
        });
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
        const metas = [];
        collectItems(data && data.data, metas, new Set());
        return { metas, cacheMaxAge: 900 };
    } catch (err) {
        console.error('catalog error:', err.message);
        return { metas: [] };
    }
});

builder.defineMetaHandler(async (args) => ({
    meta: {
        id: args.id,
        type: 'movie',
        name: 'Bilibili Video',
        description: 'Detail video dari Bilibili TV'
    }
}));

// Season -> episode pertama
async function firstEpisodeOfSeason(seasonId) {
    const { data } = await http.get(`${BASE}/v2/ogv/play/episodes`, {
        params: { season_id: seasonId, platform: 'web', s_locale: LOCALE }
    });
    const eps = [];
    (function walk(n) {
        if (!n || typeof n !== 'object') return;
        if (Array.isArray(n)) return n.forEach(walk);
        if (n.episode_id) eps.push(String(n.episode_id));
        Object.values(n).forEach(walk);
    })(data && data.data);
    return eps[0] || null;
}

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
        // Utamakan H.264 supaya kompatibel dengan player
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

builder.defineStreamHandler(async (args) => {
    try {
        const parsed = parseId(args.id);
        if (!parsed) return { streams: [] };
        let { kind, num } = parsed;
        if (kind === 'ss') {
            num = await firstEpisodeOfSeason(num);
            kind = 'ep';
            if (!num) return { streams: [] };
        }
        const data = await fetchPlay(kind, num);
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
    const metas = [];
    collectItems(data && data.data, metas, new Set());
    return {
        code: data && data.code,
        found: metas.length,
        firstThree: metas.slice(0, 3),
        rawSample: JSON.stringify(data).slice(0, 800)
    };
}));

app.get('/debug/play/:kind/:num', wrap(async req => {
    const data = await fetchPlay(req.params.kind, req.params.num);
    const streams = extractStreams(data);
    return {
        code: data && data.code,
        message: data && data.message,
        streamCount: streams.length,
        titles: streams.map(s => s.title),
        hasAudioResource: !!(data && data.data && data.data.playurl && data.data.playurl.audio_resource),
        rawSample: JSON.stringify(data).slice(0, 600).replace(/https?:\/\/[^"]+/g, '[url]')
    };
}));


app.get('/', (req, res) => res.redirect('/manifest.json'));
app.use('/', getRouter(builder.getInterface()));

module.exports = app;
