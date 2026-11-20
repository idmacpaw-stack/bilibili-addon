const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');

const BASE = 'https://api.bilibili.tv';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, Referer: 'https://www.bilibili.tv/', Origin: 'https://www.bilibili.tv' };

const manifest = {
    id: 'org.bilibilicustom.addon',
    version: '1.1.0',
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

// ID dibuat dengan penanda jenis: bili_ep_123 (episode) atau bili_ss_123 (season)
function makeId(item) {
    if (item.episode_id) return `bili_ep_${item.episode_id}`;
    if (item.season_id) return `bili_ss_${item.season_id}`;
    return null;
}

function parseId(id) {
    const m = /^bili_(ep|ss)_(\d+)$/.exec(id);
    return m ? { kind: m[1], num: m[2] } : null;
}

async function searchBili(keyword) {
    const { data } = await http.get(`${BASE}/wb/web/search/all`, {
        params: { keyword, platform: 'html' }
    });
    return data;
}

builder.defineCatalogHandler(async (args) => {
    try {
        const extra = (args && args.extra) || {};
        // Pencarian Bilibili tidak dipaginasi di sini, jadi halaman berikutnya dikosongkan
        // supaya Stremio/Nuvio tidak menampilkan hasil yang sama berulang kali.
        if (parseInt(extra.skip, 10) > 0) return { metas: [] };

        const keyword = extra.search && extra.search.trim() ? extra.search.trim() : 'anime';
        const data = await searchBili(keyword);

        const metas = [];
        const seen = new Set();
        const groups = (data && data.data && data.data.result) || [];
        for (const group of groups) {
            for (const item of group.list || []) {
                const id = makeId(item);
                const name = item.title || item.name;
                if (!id || !name || seen.has(id)) continue;
                seen.add(id);
                metas.push({
                    id,
                    type: 'movie',
                    name: String(name).replace(/<[^>]+>/g, ''),
                    poster: item.cover || item.image || undefined,
                    posterShape: 'poster',
                    description: item.intro || ''
                });
            }
        }
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

// Kalau ID berupa season, cari episode pertamanya
async function resolveEpisodeId(parsed) {
    if (parsed.kind === 'ep') return parsed.num;
    const { data } = await http.get(`${BASE}/intl/gateway/web/v2/ogv/play/episodes`, {
        params: { season_id: parsed.num, platform: 'web', 's_locale': 'en_US' }
    });
    const sections = (data && data.data && data.data.sections) || [];
    for (const s of sections) {
        if (s.episodes && s.episodes.length) return String(s.episodes[0].episode_id || s.episodes[0].id);
    }
    return null;
}

async function fetchPlay(epId) {
    const { data } = await http.get(`${BASE}/intl/gateway/web/playurl`, {
        params: {
            ep_id: epId,
            platform: 'web',
            s_locale: 'en_US',
            qn: 64,
            type: 0,
            device: 'wap',
            tf: 0
        }
    });
    return data;
}

function extractStreams(data) {
    const streams = [];
    const hints = {
        notWebReady: true,
        proxyHeaders: { request: { Referer: 'https://www.bilibili.tv/', 'User-Agent': UA } }
    };
    const pu = data && data.data && data.data.playurl;

    if (typeof pu === 'string' && pu) {
        streams.push({ name: 'Bilibili', title: 'Bilibili', url: pu, behaviorHints: hints });
    } else if (pu && Array.isArray(pu.video)) {
        for (const v of pu.video) {
            const url = v.video_resource && v.video_resource.url;
            if (!url) continue;
            const q = (v.stream_info && (v.stream_info.desc_words || v.stream_info.display_desc)) || 'Bilibili';
            streams.push({ name: 'Bilibili', title: String(q), url, behaviorHints: hints });
        }
    }
    return streams;
}

builder.defineStreamHandler(async (args) => {
    try {
        const parsed = parseId(args.id);
        if (!parsed) return { streams: [] };
        const epId = await resolveEpisodeId(parsed);
        if (!epId) return { streams: [] };
        const data = await fetchPlay(epId);
        return { streams: extractStreams(data), cacheMaxAge: 300 };
    } catch (err) {
        console.error('stream error:', err.message);
        return { streams: [] };
    }
});

const app = express();
app.use(cors());

// Halaman diagnosa: lihat respons mentah Bilibili
app.get('/debug/search', async (req, res) => {
    try {
        const data = await searchBili(req.query.q || 'anime');
        res.json({ sample: JSON.stringify(data).slice(0, 1500) });
    } catch (e) {
        res.json({ error: e.message, status: e.response && e.response.status });
    }
});
app.get('/debug/play/:epId', async (req, res) => {
    try {
        const data = await fetchPlay(req.params.epId);
        res.json({ sample: JSON.stringify(data).slice(0, 1500).replace(/https?:\/\/[^"]+/g, '[url]') });
    } catch (e) {
        res.json({ error: e.message, status: e.response && e.response.status });
    }
});

app.get('/', (req, res) => res.redirect('/manifest.json'));
app.use('/', getRouter(builder.getInterface()));

module.exports = app;
