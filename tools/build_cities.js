/* 从 GeoNames 拉取城市数据，精简成扩展内置的最近邻查询库。
 * 离线运行一次即可，产物是 src/lib/cities.data.js，之后不再需要网络。 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const URL = 'https://download.geonames.org/export/dump/cities15000.zip';
const OUT = path.join(__dirname, '..', 'src', 'lib', 'cities.data.js');
const LOG = path.join(__dirname, 'build_cities.log');
const CACHE = path.join(__dirname, '.cache', 'cities15000.txt');

function log(s) { fs.appendFileSync(LOG, s + '\n'); }

function findEOCD(buf) {
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

function unzip(buf) {
  const eocd = findEOCD(buf);
  if (eocd < 0) throw new Error('EOCD not found');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const files = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.slice(start, start + compSize);
    files.push({ name, data: method === 8 ? zlib.inflateRawSync(raw) : raw });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

async function main() {
  fs.writeFileSync(LOG, '');

  let tsv;
  if (fs.existsSync(CACHE)) {
    // 原始 TSV 留一份缓存，之后重建不用再联网
    tsv = fs.readFileSync(CACHE);
    log('using cache: ' + CACHE);
  } else {
    log('fetching ' + URL);
    const res = await fetch(URL, { headers: { 'User-Agent': 'night-owl-build' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    log('zip bytes: ' + buf.length);
    const entry = unzip(buf).find((f) => /cities15000\.txt$/.test(f.name));
    if (!entry) throw new Error('cities15000.txt not in archive');
    tsv = entry.data;
    fs.mkdirSync(path.dirname(CACHE), { recursive: true });
    fs.writeFileSync(CACHE, tsv);
    log('cached: ' + CACHE);
  }
  log('tsv bytes: ' + tsv.length);

  const rows = [];
  tsv.toString('utf8').split('\n').forEach((line) => {
    if (!line.trim()) return;
    const c = line.split('\t');
    // name, asciiname, latitude, longitude, country, population
    const name = c[1] || c[2];
    const lat = parseFloat(c[4]);
    const lng = parseFloat(c[5]);
    const cc = c[8] || '';
    const pop = parseInt(c[14], 10) || 0;
    if (!name || !isFinite(lat) || !isFinite(lng)) return;
    rows.push({ name, lat, lng, cc, pop });
  });
  log('rows: ' + rows.length);

  // 大城市直接入选
  const picked = new Map();
  rows.slice().sort((a, b) => b.pop - a.pop).slice(0, 1500).forEach((r) => picked.set(r.name + '|' + r.cc, r));

  // 再按 2° 网格补充，保证偏远地区也有可参照的近邻
  const grid = new Map();
  rows.forEach((r) => {
    const key = Math.floor(r.lat / 2) + ':' + Math.floor(r.lng / 2);
    const cur = grid.get(key);
    if (!cur || r.pop > cur.pop) grid.set(key, r);
  });
  grid.forEach((r) => {
    const k = r.name + '|' + r.cc;
    if (!picked.has(k)) picked.set(k, r);
  });

  // 全球人口排名，排名越小城市越大
  const rank = new Map();
  rows.slice().sort((a, b) => b.pop - a.pop).forEach((r, i) => rank.set(r.name + '|' + r.cc, i));

  const list = Array.from(picked.values());
  log('picked: ' + list.length);

  // 紧凑存储：坐标放大 100 倍取整，0.01° 约 1.1km，足够做最近邻
  // 第 5 位是人口排名：0 = 全球第一大城，越小越大
  // 作用：上海市中心离 "Puxi" 只有 1.1km、离 "Shanghai" 1.7km，纯最近邻会报出区名，
  //       查询时改为"半径内报人口最大的那个"，就永远报都会区主体城市。
  const packed = list.map((r) => [
    Math.round(r.lat * 100),
    Math.round(r.lng * 100),
    r.name,
    r.cc,
    rank.get(r.name + '|' + r.cc) | 0
  ]);
  log('rank range: 0..' + Math.max.apply(null, packed.map((p) => p[4])));

  const body = '/* 自动生成，请勿手改。来源 GeoNames cities15000，已按人口与 2° 网格精简。\n' +
    ' * 格式：[lat*100, lng*100, name, countryCode, popRank]，popRank 越小城市越大。 */\n' +
    '(function () {\n' +
    '  var root = (typeof module !== "undefined" && module.exports) ? module.exports\n' +
    '    : (typeof globalThis !== "undefined" ? globalThis : window);\n' +
    '  root.NW = root.NW || {};\n' +
    '  root.NW.cities = ' + JSON.stringify({ v: 1, list: packed }) + ';\n' +
    '})();\n';

  fs.writeFileSync(OUT, body);
  log('written: ' + OUT + ' (' + body.length + ' bytes)');
}

main().catch((e) => { log('FAILED: ' + e.message); });
