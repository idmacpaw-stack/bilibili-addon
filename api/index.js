const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');

const BASE = 'https://api.bilibili.tv/intl/gateway/web';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, Referer: 'https://www.bilibili.tv/', Origin: 'https://www.bilibili.tv' };
const LOCALE = 'en_US';
const PAGE_SIZE = 20;
const ORIGIN = process.env.PUBLIC_URL || 'https://bilibili-addon.vercel.app';

const GENRES = ['Action', 'Romance', 'Comedy', 'Fantasy', 'Isekai', 'Slice of Life', 'Sports', 'Mystery', 'Horror', 'Donghua'];

const manifest = {
    id: 'org.bilibilicustom.addon',
    version: '1.7.0',
    name: 'Bilibili TV Addon',
    description: 'Anime dan series dari Bilibili.tv',
    resources: ['catalog', 'meta', 'stream'],
    types: ['series'],
    catalogs: [
        {
            type: 'series',
            id: 'bili_airing',
            name: 'Bilibili - Sedang Tayang',
            extra: []
        },
        {
            type: 'series',
            id: 'bili_series',
            name: 'Bilibili - Anime',
            extra: [
                { name: 'genre', options: GENRES, isRequired: false },
                { name: 'search', isRequired: false }
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

async function fetchTimeline() {
    const { data } = await http.get(`${BASE}/v2/ogv/timeline`, {
        params: { s_locale: LOCALE, platform: 'web' }
    });
    return data;
}

// Cari beberapa kata kunci x beberapa halaman sekaligus, ambil hanya yang berjenis series
async function seriesFromSearch(keywords, pages) {
    const jobs = [];
    for (const k of keywords) for (const pg of pages) jobs.push(searchBili(k, pg).catch(() => null));
    const results = await Promise.all(jobs);
    const all = [];
    const seen = new Set();
    for (const r of results) collectItems(r && r.data, all, seen);
    return all.filter(m => m.type === 'series');
}

builder.defineCatalogHandler(async (args) => {
    try {
        const extra = (args && args.extra) || {};
        // Daftar dibuat sekali jalan, jadi halaman berikutnya dikosongkan
        if (parseInt(extra.skip, 10) > 0) return { metas: [] };

        let items = [];
        if (args.id === 'bili_airing') {
            const data = await fetchTimeline();
            const all = [];
            collectItems(data && data.data, all, new Set());
            items = all.filter(m => m.type === 'series');
        } else {
            let keywords;
            if (extra.search && extra.search.trim()) keywords = [extra.search.trim()];
            else if (extra.genre) keywords = extra.genre === 'Donghua' ? ['donghua'] : [`${extra.genre} anime`, extra.genre];
            else keywords = ['anime', 'donghua', 'anime season', 'episode 1 sub'];
            items = await seriesFromSearch(keywords, [1, 2, 3]);
        }

        const metas = items.map(m => ({ ...m, type: 'series' }));
        return { metas, cacheMaxAge: 1800 };
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
    if (kind === 'av') {
        params.aid = num;
        params.spm_id = 'bstar-web.ugc-video-detail.0.0';
        params.from_spm_id = '';
    } else {
        params.ep_id = num;
    }
    const { data } = await http.get(`${BASE}/playurl`, { params });
    return data;
}

const esc = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Cache link putar per instance (link Bilibili terikat ke IP server yang memintanya,
// jadi permintaan video harus lewat instance yang sama)
const playCache = new Map();
async function cachedPlay(kind, num) {
    const key = `${kind}:${num}`;
    const hit = playCache.get(key);
    if (hit && Date.now() - hit.t < 4 * 60 * 1000) return hit.data;
    const data = await fetchPlay(kind, num);
    if (data && data.code === 0) playCache.set(key, { t: Date.now(), data });
    return data;
}

function pickTracks(data) {
    const pu = data && data.data && data.data.playurl;
    if (!pu || !Array.isArray(pu.video)) return { pu: null, videos: [], audios: [] };
    const videos = pu.video
        .map(v => v.video_resource)
        .filter(r => r && r.url && r.segment_base && /avc1/.test(r.codecs || ''));
    const audios = (Array.isArray(pu.audio_resource) ? pu.audio_resource : [])
        .filter(r => r && r.url && r.segment_base);
    return { pu, videos, audios };
}

// Membuat manifest DASH (.mpd). Video/audio diambil lewat proxy /media milik addon ini.
function buildMpd(data, kind, num) {
    const { pu, videos, audios } = pickTracks(data);
    if (!pu || !videos.length || !audios.length) return null;

    const dur = ((pu.duration || 0) / 1000).toFixed(3);
    const rep = (r, id, path, extra) => `
      <Representation id="${id}" bandwidth="${r.bandwidth || 0}" codecs="${esc(r.codecs || '')}"${extra}>
        <BaseURL>${esc(`${ORIGIN}/media/${kind}/${num}/${path}.m4s`)}</BaseURL>
        <SegmentBase indexRange="${esc(r.segment_base.index_range)}"><Initialization range="${esc(r.segment_base.range)}"/></SegmentBase>
      </Representation>`;

    const vReps = videos.map((r, i) =>
        rep(r, `v${i}`, `v${i}`, ` width="${r.width || 0}" height="${r.height || 0}"${r.frame_rate ? ` frameRate="${esc(r.frame_rate)}"` : ''}`)
    ).join('');
    const aReps = audios.map((r, i) => rep(r, `a${i}`, `a${i}`, '')).join('');

    return `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011" type="static" mediaPresentationDuration="PT${dur}S" minBufferTime="PT2S">
  <Period>
    <AdaptationSet mimeType="video/mp4" segmentAlignment="true" startWithSAP="1">${vReps}
    </AdaptationSet>
    <AdaptationSet mimeType="audio/mp4" segmentAlignment="true" startWithSAP="1" lang="und">${aReps}
    </AdaptationSet>
  </Period>
</MPD>`;
}

function extractStreams(data, kind, num) {
    const hints = {
        notWebReady: true,
        proxyHeaders: { request: { Referer: 'https://www.bilibili.tv/', 'User-Agent': UA } }
    };
    const pu = data && data.data && data.data.playurl;
    const streams = [];
    if (!pu || !Array.isArray(pu.video)) return streams;

    // Pilihan 1: DASH (video + audio) lewat manifest buatan sendiri
    if (kind && num && buildMpd(data, kind, num)) {
        streams.push({
            name: 'Bilibili',
            title: 'DASH (video + suara)',
            url: `${ORIGIN}/dash/${kind}/${num}.mpd`,
            behaviorHints: hints
        });
    }

    // Pilihan berikutnya: video saja (tanpa suara)
    const direct = [];
    for (const v of pu.video) {
        const r = v.video_resource;
        if (!r || !r.url) continue;
        const codec = String(r.codecs || '');
        const info = v.stream_info || {};
        const label = info.desc_words || info.display_desc || (r.height ? r.height + 'p' : 'Bilibili');
        direct.push({
            name: 'Bilibili',
            title: `${label}${codec ? ' • ' + codec.split('.')[0] : ''} • video saja`,
            url: r.url,
            behaviorHints: hints
        });
    }
    direct.sort((a, b) => (/avc1/.test(b.title) ? 1 : 0) - (/avc1/.test(a.title) ? 1 : 0));
    return streams.concat(direct);
}

async function resolveAndPlay(id) {
    const parsed = parseId(id);
    if (!parsed) return { steps: ['id tidak dikenali'], data: null, kind: null, num: null };
    const steps = [];
    let { kind, num } = parsed;
    if (kind === 'ss') {
        const { eps } = await fetchEpisodes(num);
        steps.push(`season ${num} punya ${eps.length} episode`);
        if (!eps.length) return { steps, data: null, kind: null, num: null };
        kind = 'ep';
        num = String(eps[0].episode_id);
        steps.push(`memakai episode pertama ${num}`);
    }
    const data = await fetchPlay(kind, num);
    steps.push(`playurl code=${data && data.code} message=${data && data.message}`);
    return { steps, data, kind, num };
}

builder.defineStreamHandler(async (args) => {
    try {
        const { data, kind, num } = await resolveAndPlay(args.id);
        return { streams: extractStreams(data, kind, num), cacheMaxAge: 120 };
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

app.get('/debug/timeline', wrap(async () => {
    const data = await fetchTimeline();
    const all = [];
    collectItems(data && data.data, all, new Set());
    const series = all.filter(m => m.type === 'series');
    return { code: data && data.code, found: all.length, series: series.length, first: series.slice(0, 8).map(i => ({ id: i.id, name: i.name })) };
}));

app.get('/debug/series', wrap(async req => {
    const kws = req.query.q ? [req.query.q] : ['anime', 'donghua', 'anime season', 'episode 1 sub'];
    const out = {};
    for (const k of kws) {
        const items = await seriesFromSearch([k], [1, 2, 3]);
        out[k] = { series: items.length, first: items.slice(0, 5).map(i => i.name) };
    }
    return out;
}));

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
    const { steps, data, kind, num } = await resolveAndPlay(req.params.id);
    const streams = extractStreams(data, kind, num);
    const pu = data && data.data && data.data.playurl;
    return {
        steps,
        streamCount: streams.length,
        titles: streams.map(s => s.title),
        dashUrl: kind && num ? `${ORIGIN}/dash/${kind}/${num}.mpd` : null,
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


// Manifest DASH yang dibuat saat diminta
app.get(/^\/dash\/(ep|av)\/(\d+)\.mpd$/, async (req, res) => {
    try {
        const [kind, num] = [req.params[0], req.params[1]];
        const data = await cachedPlay(kind, num);
        const mpd = buildMpd(data, kind, num);
        if (!mpd) return res.status(404).send('Stream DASH tidak tersedia');
        res.set('Content-Type', 'application/dash+xml');
        res.set('Cache-Control', 'no-store');
        res.send(mpd);
    } catch (e) {
        res.status(502).send('Gagal mengambil data: ' + e.message);
    }
});

// Proxy video/audio: server addon mengambil dari CDN Bilibili (dengan Referer + Range) lalu meneruskannya
app.get(/^\/media\/(ep|av)\/(\d+)\/([va])(\d+)\.m4s$/, async (req, res) => {
    try {
        const [kind, num, type, idx] = [req.params[0], req.params[1], req.params[2], parseInt(req.params[3], 10)];
        let data = await cachedPlay(kind, num);
        let { videos, audios } = pickTracks(data);
        const track = (type === 'v' ? videos : audios)[idx];
        if (!track) return res.status(404).send('Track tidak ditemukan');

        const headers = { 'User-Agent': UA, Referer: 'https://www.bilibili.tv/', Origin: 'https://www.bilibili.tv' };
        if (req.headers.range) headers.Range = req.headers.range;

        const up = await axios.get(track.url, {
            responseType: 'stream',
            headers,
            validateStatus: () => true,
            timeout: 20000
        });
        res.status(up.status);
        for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
            if (up.headers[h]) res.set(h, up.headers[h]);
        }
        if (!up.headers['accept-ranges']) res.set('Accept-Ranges', 'bytes');
        res.set('Cache-Control', 'no-store');
        req.on('close', () => up.data.destroy());
        up.data.on('error', () => res.end());
        up.data.pipe(res);
    } catch (e) {
        res.status(502).send('Gagal meneruskan video: ' + e.message);
    }
});

// Cek apakah server bisa mengambil potongan video dari CDN Bilibili
app.get('/debug/media/:kind/:num', wrap(async req => {
    const data = await cachedPlay(req.params.kind, req.params.num);
    const { videos, audios } = pickTracks(data);
    const out = { videoTracks: videos.length, audioTracks: audios.length };
    for (const [name, tr] of [['video0', videos[0]], ['audio0', audios[0]]]) {
        if (!tr) { out[name] = 'tidak ada'; continue; }
        const r = await axios.get(tr.url, {
            headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.tv/', Range: 'bytes=0-99' },
            responseType: 'arraybuffer',
            validateStatus: () => true,
            timeout: 8000
        });
        out[name] = { status: r.status, contentType: r.headers['content-type'], contentRange: r.headers['content-range'], bytes: r.data ? r.data.length : 0 };
    }
    return out;
}));

app.get('/', (req, res) => res.redirect('/manifest.json'));
app.use('/', getRouter(builder.getInterface()));

module.exports = app;
