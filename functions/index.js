/**
 * Pendi Drama Player — API (Firebase Functions / Vercel)
 * 
 * PERBAIKAN UTAMA:
 *   GET  /api/episodes/:bookId  → scrape episode langsung (tanpa simpan ke Firestore)
 *                                  FIX: player tidak lagi blank walau episode belum di-scrape
 *
 * Routes lengkap:
 *   GET  /api/decrypt?url=          → proxy decrypt video
 *   GET  /api/episodes/:bookId      → ambil episode langsung dari DramaBox (BARU)
 *   POST /api/admin/scrape-catalog  → scrape + simpan katalog ke Firestore
 *   POST /api/admin/scrape-drama    → scrape + simpan episode drama ke Firestore
 *   POST /api/admin/refresh-drama   → re-scrape episode (update Firestore)
 *   POST /api/admin/delete-drama    → hapus drama dari Firestore
 *   POST /api/admin/lock-episodes   → set episode mana yg terkunci per drama
 *   POST /api/admin/update-drama-info → update info drama (title, cover, dll)
 *   POST /api/admin/verify          → cek admin key
 */

const admin   = require('firebase-admin');
const express = require('express');
const cors    = require('cors');
const https   = require('https');
const tls     = require('tls');
const crypto  = require('crypto');
const zlib    = require('zlib');
const axios   = require('axios');

// ─── Firebase Admin Init ──────────────────────────────────────────────────────
if (!admin.apps.length) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '{}');
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

// ─── Admin Key ────────────────────────────────────────────────────────────────
function getAdminKey() { return process.env.ADMIN_KEY || 'admin123'; }

function checkAdmin(req, res) {
    const key = req.headers['x-admin-key'] || req.body?.adminKey || req.query.adminKey;
    if (key !== getAdminKey()) { res.status(401).json({ error: 'Unauthorized' }); return false; }
    return true;
}

// ─── Scraper Engine ───────────────────────────────────────────────────────────
const API_BASE   = 'https://nb-dramabox-gentoken.vercel.app';
const TIMEOUT_MS = 15000;
const MAX_RETRY  = 3;

const session = {
    token:'', deviceid:'', androidid:'',
    instanceid: crypto.randomBytes(16).toString('hex'),
    afid: `${Date.now()}-${Math.floor(Math.random()*9999999999)}`,
    ins: Date.now().toString(),
    st: 'cK4n10B_0tTQBrxFyyBWnOKD',
    cookies: [], ready: false
};

function localTime() {
    const bt = new Date(Date.now() + 7*3600000);
    const p  = n => n.toString().padStart(2,'0');
    return `${bt.getUTCFullYear()}-${p(bt.getUTCMonth()+1)}-${p(bt.getUTCDate())} ` +
           `${p(bt.getUTCHours())}:${p(bt.getUTCMinutes())}:${p(bt.getUTCSeconds())}.` +
           `${bt.getUTCMilliseconds().toString().padStart(3,'0')} +0700`;
}

async function ensureToken() {
    if (session.ready) return true;
    try {
        const r = await axios.get(`${API_BASE}/generate-token`, { timeout: TIMEOUT_MS });
        if (r.data?.status && r.data?.data) {
            Object.assign(session, {
                token: r.data.data.sn, deviceid: r.data.data.device_id,
                androidid: r.data.data.android_id, cookies: [], ready: true
            });
            return true;
        }
    } catch {}
    return false;
}

async function sign(body) {
    try {
        const r = await axios.post(`${API_BASE}/sign`, {
            body, device_id: session.deviceid,
            android_id: session.androidid, token: session.token
        }, { timeout: TIMEOUT_MS });
        return r.data?.status ? r.data.data : null;
    } catch { return null; }
}

function buildHeaders(sn, token) {
    return {
        'accept-encoding':'gzip','version':'580','package-name':'com.storymatrix.drama',
        'p':'63','cid':'DRA1000042','apn':'2','country-code':'ID','mchid':'DRA1000042',
        'tz':'-420','language':'in','mcc':'510','locale':'in_ID','is_root':'0',
        'device-id':session.deviceid,'nchid':'DRA1000042','instanceid':session.instanceid,
        'md':'Redmi Note 5','store-source':'store_google','mf':'XIAOMI','device-score':'60',
        'local-time':localTime(),'time-zone':'+0700','brand':'Xiaomi','lat':'0',
        'is_emulator':'0','current-language':'in','ov':'10','afid':session.afid,
        'android-id':session.androidid,'srn':'1080x2160','ins':session.ins,'is_vpn':'1',
        'build':'Build/QQ3A.200805.001','pline':'ANDROID','vn':'5.8.0','over-flow':'new-fly',
        'tn': token ? `Bearer ${token}` : '',
        'sn':sn,'st':session.st,
        'active-time': Math.floor(Math.random()*20000).toString(),
        'content-type':'application/json; charset=UTF-8','user-agent':'okhttp/4.12.0'
    };
}

function tlsPost(urlStr, body, hdrs) {
    return new Promise(resolve => {
        const u   = new URL(urlStr);
        const str = JSON.stringify(body);
        if (session.cookies.length) hdrs['Cookie'] = session.cookies.join('; ');

        let raw = `POST ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.hostname}\r\n`;
        for (const [k,v] of Object.entries(hdrs))
            if (!['host','content-length','cookie'].includes(k.toLowerCase()))
                raw += `${k}: ${v}\r\n`;
        if (hdrs['Cookie']) raw += `Cookie: ${hdrs['Cookie']}\r\n`;
        raw += `Content-Length: ${Buffer.byteLength(str)}\r\nConnection: close\r\n\r\n${str}`;

        let sock;
        try {
            sock = tls.connect({
                host: u.hostname, port: 443, servername: u.hostname,
                rejectUnauthorized: false,
                ciphers: 'TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:ECDHE-ECDSA-AES128-GCM-SHA256',
                ALPNProtocols: ['http/1.1']
            }, () => sock.write(raw));
        } catch(e) { return resolve({ ok: false, err: e.message }); }

        let buf = Buffer.alloc(0);
        sock.on('data', d => buf = Buffer.concat([buf, d]));
        sock.on('end', () => {
            const s   = buf.toString('binary');
            const idx = s.indexOf('\r\n\r\n');
            if (idx === -1) return resolve({ ok: false, err: 'Bad HTTP' });

            const hPart = s.substring(0, idx);
            let   bPart = buf.subarray(idx + 4);
            const code  = parseInt(hPart.split('\r\n')[0].split(' ')[1], 10);

            const h = {};
            hPart.split('\r\n').slice(1).forEach(l => {
                const p = l.split(':');
                if (p.length > 1) {
                    const key = p[0].trim().toLowerCase();
                    const val = p.slice(1).join(':').trim();
                    h[key] = key === 'set-cookie' ? [...(h[key]||[]), val] : val;
                }
            });

            if (h['st']) session.st = h['st'];
            if (h['set-cookie']) h['set-cookie'].forEach(cs => {
                const m = cs.split(';')[0];
                session.cookies = session.cookies.filter(c => !c.startsWith(m.split('=')[0]+'='));
                session.cookies.push(m);
            });

            if (code >= 400) return resolve({ ok: false, err: `HTTP ${code}` });
            if (h['content-encoding'] === 'gzip') { try { bPart = zlib.gunzipSync(bPart); } catch {} }

            let fs2 = bPart.toString('utf8');
            if (h['transfer-encoding'] === 'chunked') {
                const a = fs2.indexOf('{'), b = fs2.lastIndexOf('}');
                if (a !== -1 && b !== -1) fs2 = fs2.substring(a, b+1);
            }
            try { resolve({ ok: true, data: JSON.parse(fs2) }); }
            catch { resolve({ ok: false, err: 'JSON parse error' }); }
        });
        sock.on('error', e => resolve({ ok: false, err: e.message }));
        sock.setTimeout(TIMEOUT_MS);
        sock.on('timeout', () => { sock.destroy(); resolve({ ok: false, err: 'Timeout' }); });
    });
}

async function apiPost(endpoint, body) {
    const s = await sign(body);
    if (!s) return { ok: false, err: 'Sign gagal' };
    const sep = endpoint.includes('?') ? '&' : '?';
    const r   = await tlsPost(`${endpoint}${sep}timestamp=${s.timestamp}`, body, buildHeaders(s.sn, session.token));
    return r.ok && r.data?.data ? { ok: true, data: r.data.data } : { ok: false, err: r.err || 'No data' };
}

// ─── Scrape Catalog ───────────────────────────────────────────────────────────
async function scrapeCatalog() {
    let page = 1, all = [];
    while (true) {
        const r = await apiPost('https://sapi.dramaboxvideo.com/drama-box/he001/theater', {
            newChannelStyle:1, isNeedRank:1, pageNo:page, index:1, channelId:43,
            recSessionId: crypto.randomBytes(32).toString('hex')
        });
        if (r.ok && r.data?.newTheaterList?.records?.length) {
            all.push(...r.data.newTheaterList.records);
            if (page >= (r.data.newTheaterList.pages || 1)) break;
            page++;
        } else break;
    }
    return all.map(d => ({
        bookId:   String(d.bookId),
        title:    d.bookName || d.name || 'Unknown',
        cover:    d.cover || d.coverWap || '',
        totalEps: d.chapterCount || d.totalChapter || 0,
        status:   d.serialStatus === 1 ? 'Ongoing' : 'Completed',
        tags:     (d.labelList || []).map(l => l.name).join(', '),
        lockedEpisodes: [],
        lastScraped: admin.firestore.FieldValue.serverTimestamp()
    }));
}

// ─── Scrape Episodes ──────────────────────────────────────────────────────────
async function scrapeEpisodes(bookId) {
    let all = [], cursor = -1, retries = 0;

    while (true) {
        const r = await apiPost('https://sapi.dramaboxvideo.com/drama-box/chapterv2/batch/load', {
            boundaryIndex:0, index: parseInt(cursor),
            currencyPlaySource:'discover_175_rec', needEndRecommend:0,
            currencyPlaySourceName:'首页发现_Untukmu_推荐列表',
            preLoad:false, rid:'', pullCid:'', enterReaderChapterIndex:0,
            loadDirection: cursor === -1 ? 0 : 2,
            startUpKey: crypto.randomUUID(),
            bookId: String(bookId)
        });

        const isEmpty = r.ok && !r.data?.chapterList?.length;

        if (!r.ok || isEmpty) {
            retries++;
            if (retries >= MAX_RETRY) break;
            if (retries % 2 === 0) { session.ready = false; await ensureToken(); }
            if (cursor !== -1) cursor += 5;
            continue;
        }

        retries = 0;
        const fresh = r.data.chapterList.filter(n => !all.some(e => e.chapterId === n.chapterId));
        if (!fresh.length) { cursor += 5; retries++; continue; }

        all.push(...fresh);
        cursor = parseInt(fresh[fresh.length - 1].chapterIndex);
    }

    if (!all.length) return [];
    all.sort((a,b) => a.chapterIndex - b.chapterIndex);

    return all.map((ep, i) => {
        const cdn  = ep.cdnList ? (ep.cdnList.find(c => c.isDefault===1) || ep.cdnList[0]) : null;
        const vids = cdn?.videoPathList || [];
        const main = vids.find(v => v.isDefault===1) || vids[0];
        return {
            title:        ep.chapterName || `Episode ${i+1}`,
            chapterIndex: ep.chapterIndex,
            chapterId:    ep.chapterId,
            rawUrl:       main?.videoPath || '',
            quality:      main?.quality   || 0,
            sources:      vids.filter(v => v.videoPath).map(v => ({ quality: v.quality, rawUrl: v.videoPath })),
            thumbnailUrl: ep.chapterImg || ep.spriteSnapshotUrl || ''
        };
    });
}

// ─── Simpan ke Firestore ──────────────────────────────────────────────────────
async function saveDramaToFirestore(bookId, dramaData, episodes) {
    const batch    = db.batch();
    const dramaRef = db.collection('dramas').doc(String(bookId));
    batch.set(dramaRef, dramaData, { merge: true });
    const epRef = db.collection('episodes').doc(String(bookId));
    batch.set(epRef, {
        bookId:      String(bookId),
        chapters:    episodes,
        totalEps:    episodes.length,
        lastUpdated: admin.firestore.FieldValue.serverTimestamp()
    });
    await batch.commit();
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── Routes: Public ───────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

// ── [BARU] GET /api/episodes/:bookId ─────────────────────────────────────────
// Scrape episode langsung dari DramaBox tanpa butuh data di Firestore.
// Ini yang memperbaiki bug player blank screen.
app.get('/api/episodes/:bookId', async (req, res) => {
    const { bookId } = req.params;
    if (!bookId) return res.status(400).json({ error: 'bookId wajib diisi.' });
    try {
        const ok = await ensureToken();
        if (!ok) return res.status(502).json({ error: 'Gagal inisialisasi token.' });

        // Cek cache Firestore dulu (opsional, lebih cepat)
        const snap = await db.collection('episodes').doc(String(bookId)).get();
        if (snap.exists) {
            const data = snap.data();
            const chapters = data.chapters || [];
            if (chapters.length > 0) {
                return res.json(chapters);
            }
        }

        // Kalau tidak ada di cache, scrape langsung
        const episodes = await scrapeEpisodes(bookId);
        if (!episodes.length) return res.status(404).json({ error: 'Tidak ada episode ditemukan.' });
        res.json(episodes);
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/decrypt?url= ─────────────────────────────────────────────────────
app.get('/api/decrypt', (req, res) => {
    const url = req.query.url;
    if (!url) return res.status(400).json({ error: 'Missing url' });
    try { new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL' }); }

    const proxyUrl = `https://nb-dramabox-gentoken.vercel.app/decrypt-video?url=${encodeURIComponent(url)}`;
    const req2 = https.get(proxyUrl, r2 => {
        res.status(r2.statusCode || 200);
        ['content-type','content-length','accept-ranges'].forEach(h => {
            if (r2.headers[h]) res.setHeader(
                h === 'content-type'   ? 'Content-Type'   :
                h === 'content-length' ? 'Content-Length' : 'Accept-Ranges',
                r2.headers[h]
            );
        });
        res.setHeader('Cache-Control', 'public, max-age=3600');
        r2.pipe(res);
    });
    req2.on('error', e => { if (!res.headersSent) res.status(502).json({ error: e.message }); });
    req.on('close', () => req2.destroy());
});

// ═══════════════════════════════════════════════════════════════════════════════
// ─── Routes: Admin ────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/admin/scrape-catalog', async (req, res) => {
    if (!checkAdmin(req, res)) return;
    try {
        const ok = await ensureToken();
        if (!ok) return res.status(502).json({ error: 'Gagal inisialisasi token.' });
        const catalog = await scrapeCatalog();
        if (!catalog.length) return res.status(502).json({ error: 'Katalog kosong.' });
        const batch = db.batch();
        catalog.forEach(d => {
            const ref = db.collection('dramas').doc(d.bookId);
            batch.set(ref, d, { merge: true });
        });
        await batch.commit();
        res.json({ success: true, total: catalog.length, message: `${catalog.length} drama disimpan.` });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/scrape-drama', async (req, res) => {
    if (!checkAdmin(req, res)) return;
    const { bookId } = req.body;
    if (!bookId) return res.status(400).json({ error: 'bookId wajib diisi.' });
    try {
        const ok = await ensureToken();
        if (!ok) return res.status(502).json({ error: 'Gagal inisialisasi token.' });
        const dramaSnap = await db.collection('dramas').doc(String(bookId)).get();
        const dramaData = dramaSnap.exists ? dramaSnap.data() : {
            bookId: String(bookId), title: `Drama ${bookId}`,
            cover: '', totalEps: 0, status: 'Unknown', tags: '', lockedEpisodes: []
        };
        const episodes = await scrapeEpisodes(bookId);
        if (!episodes.length) return res.status(502).json({ error: 'Tidak ada episode ditemukan.' });
        dramaData.totalEps    = episodes.length;
        dramaData.lastScraped = admin.firestore.FieldValue.serverTimestamp();
        await saveDramaToFirestore(bookId, dramaData, episodes);
        res.json({ success: true, total: episodes.length, message: `${episodes.length} episode disimpan.` });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/refresh-drama', async (req, res) => {
    if (!checkAdmin(req, res)) return;
    const { bookId } = req.body;
    if (!bookId) return res.status(400).json({ error: 'bookId wajib diisi.' });
    try {
        const ok = await ensureToken();
        if (!ok) return res.status(502).json({ error: 'Gagal inisialisasi token.' });
        const episodes = await scrapeEpisodes(bookId);
        if (!episodes.length) return res.status(502).json({ error: 'Tidak ada episode ditemukan.' });
        const dramaSnap = await db.collection('dramas').doc(String(bookId)).get();
        const existing  = dramaSnap.exists ? dramaSnap.data() : {};
        await saveDramaToFirestore(bookId, {
            ...existing, bookId: String(bookId),
            totalEps: episodes.length,
            lastScraped: admin.firestore.FieldValue.serverTimestamp()
        }, episodes);
        res.json({ success: true, total: episodes.length });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/lock-episodes', async (req, res) => {
    if (!checkAdmin(req, res)) return;
    const { bookId, lockedEpisodes } = req.body;
    if (!bookId) return res.status(400).json({ error: 'bookId wajib diisi.' });
    try {
        const locked = Array.isArray(lockedEpisodes) ? lockedEpisodes.map(Number) : [];
        await db.collection('dramas').doc(String(bookId)).update({
            lockedEpisodes: locked,
            lastModified: admin.firestore.FieldValue.serverTimestamp()
        });
        res.json({ success: true, bookId, lockedEpisodes: locked });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/delete-drama', async (req, res) => {
    if (!checkAdmin(req, res)) return;
    const { bookId } = req.body;
    if (!bookId) return res.status(400).json({ error: 'bookId wajib diisi.' });
    try {
        const batch = db.batch();
        batch.delete(db.collection('dramas').doc(String(bookId)));
        batch.delete(db.collection('episodes').doc(String(bookId)));
        await batch.commit();
        res.json({ success: true, message: `Drama ${bookId} dihapus.` });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/update-drama-info', async (req, res) => {
    if (!checkAdmin(req, res)) return;
    const { bookId, title, cover, status, tags } = req.body;
    if (!bookId) return res.status(400).json({ error: 'bookId wajib diisi.' });
    try {
        const update = { lastModified: admin.firestore.FieldValue.serverTimestamp() };
        if (title  !== undefined) update.title  = title;
        if (cover  !== undefined) update.cover  = cover;
        if (status !== undefined) update.status = status;
        if (tags   !== undefined) update.tags   = tags;
        await db.collection('dramas').doc(String(bookId)).update(update);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/verify', (req, res) => {
    if (!checkAdmin(req, res)) return;
    res.json({ success: true, message: 'Admin key valid.' });
});

module.exports = app;
