'use strict';

// -----------------------------
// 設定
// -----------------------------

// 初期表示の中心（海老名市役所付近）
// 出典例: NAVITIME（海老名市役所）
const DEFAULT_CENTER = { lat: 35.446423, lng: 139.390779 };
const DEFAULT_ZOOM = 13;

const STORE_DATA_URL = './stores.json';
const PRE_GEOCODED_URL = './stores_geocoded.json'; // 任意（ある場合は高速化）

// 国土地理院 住所検索API（GeoJSON配列）
// 例: https://msearch.gsi.go.jp/address-search/AddressSearch?q=札幌駅
const GSI_GEOCODE_ENDPOINT = 'https://msearch.gsi.go.jp/address-search/AddressSearch?q=';

// アクセス過多を避けるため、住所→緯度経度の呼び出し間隔を空けます。
const GEOCODE_DELAY_MS = 700;

// 近隣表示の上限（マーカーを増やし過ぎないため）
const MAX_MARKERS_ON_MAP = 80;
const MAX_LIST_ITEMS = 50;

// localStorage のキー
const GEO_CACHE_PREFIX = 'ebinya_geo_v1:';

// -----------------------------
// 状態
// -----------------------------
let stores = [];
let map;
let storeLayer;
let storeMarkerById = new Map();

let centerLatLng = null;
let centerMarker = null;
let centerCircle = null;

let geocodeRunning = false;
let geocodeProgress = { done: 0, total: 0 };

let pendingUpdateTimer = null;

// -----------------------------
// 小物
// -----------------------------
function $(id) {
  return document.getElementById(id);
}

function setStatus(message) {
  $('status').textContent = message || '';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fmtDistance(meters) {
  if (!Number.isFinite(meters)) return '—';
  if (meters < 1000) return `${Math.round(meters)}m`;
  return `${(meters / 1000).toFixed(2)}km`;
}

function escapeHtml(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function getRadiusMeters() {
  const v = parseInt($('radius').value, 10);
  return Number.isFinite(v) ? v : 500;
}

function getVoucherFilter() {
  return $('voucherFilter').value;
}

function matchesVoucherFilter(store) {
  const f = getVoucherFilter();
  if (f === 'all') return true;
  if (f === 'common') return store.voucher === '共通券';
  if (f === 'both') return store.voucher === '共通券・個店限定券';
  return true;
}

// Haversine（球面距離）
function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// -----------------------------
// 地図
// -----------------------------
function initMap() {
  map = L.map('map', { zoomControl: true });
  map.setView([DEFAULT_CENTER.lat, DEFAULT_CENTER.lng], DEFAULT_ZOOM);

  // OpenStreetMap タイル
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap contributors',
  }).addTo(map);

  storeLayer = L.layerGroup().addTo(map);

  // 地図タップで中心を指定
  map.on('click', (e) => {
    setSearchCenter(e.latlng, { reason: 'tap' });
  });
}

function setSearchCenter(latlng, opts) {
  centerLatLng = latlng;

  if (!centerMarker) {
    centerMarker = L.marker(latlng, { title: '検索の中心' }).addTo(map);
  } else {
    centerMarker.setLatLng(latlng);
  }

  const radius = getRadiusMeters();
  if (!centerCircle) {
    centerCircle = L.circle(latlng, {
      radius,
      weight: 1,
      fillOpacity: 0.08,
    }).addTo(map);
  } else {
    centerCircle.setLatLng(latlng);
    centerCircle.setRadius(radius);
  }

  if (opts?.reason === 'tap') {
    setStatus('地図で選んだ場所のまわりを表示します。');
  } else if (opts?.reason === 'locate') {
    setStatus('現在地のまわりを表示します。');
  }

  updateResults();
}

function focusStore(storeId) {
  const marker = storeMarkerById.get(storeId);
  if (!marker) return;
  const latlng = marker.getLatLng();
  map.setView(latlng, Math.max(map.getZoom(), 16), { animate: true });
  marker.openPopup();
}

function storePopupHtml(store) {
  const name = escapeHtml(store.name);
  const voucher = escapeHtml(store.voucher);
  const address = escapeHtml(store.address);

  const appleMaps = `https://maps.apple.com/?daddr=${encodeURIComponent(
    `${store.lat},${store.lng}`
  )}&q=${encodeURIComponent(store.name)}`;

  const googleMaps = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
    `${store.lat},${store.lng}`
  )}`;

  const tel = store.phone ? `tel:${encodeURIComponent(store.phone)}` : '';

  const lines = [];
  lines.push(`<div style="font-weight:700; margin-bottom:6px;">${name}</div>`);
  lines.push(`<div style="margin-bottom:6px;">${address}</div>`);
  lines.push(`<div style="margin-bottom:8px;">券種: ${voucher}</div>`);
  lines.push(`<div style="display:flex; gap:10px; flex-wrap:wrap;">`);
  lines.push(`<a href="${appleMaps}" target="_blank" rel="noopener">Appleマップ</a>`);
  lines.push(`<a href="${googleMaps}" target="_blank" rel="noopener">Googleマップ</a>`);
  if (tel) {
    lines.push(`<a href="${tel}">電話</a>`);
  }
  lines.push(`</div>`);
  return lines.join('');
}

function renderMarkers(nearby) {
  storeLayer.clearLayers();
  storeMarkerById.clear();

  const toShow = nearby.slice(0, MAX_MARKERS_ON_MAP);
  for (const s of toShow) {
    const marker = L.marker([s.lat, s.lng], { title: s.name });
    marker.bindPopup(storePopupHtml(s));
    marker.addTo(storeLayer);
    storeMarkerById.set(s.id, marker);
  }
}

function renderList(nearby, meta) {
  const list = $('list');
  list.innerHTML = '';

  if (!centerLatLng) {
    const div = document.createElement('div');
    div.className = 'card';
    div.innerHTML =
      '<div class="meta"><span class="muted">「現在地で探す」か、地図をタップしてください。</span></div>';
    list.appendChild(div);
    return;
  }

  if (meta?.missingCoords > 0) {
    const div = document.createElement('div');
    div.className = 'card';
    div.innerHTML =
      `<div class="meta"><span class="muted">` +
      `まだ位置が分からない店舗があります（${meta.missingCoords}件）。` +
      `「店舗位置を準備」を押すと、住所から緯度経度を取得してキャッシュします。</span></div>`;
    list.appendChild(div);
  }

  if (!nearby.length) {
    const div = document.createElement('div');
    div.className = 'card';
    div.innerHTML =
      '<div class="meta">近くのお店が見つかりませんでした。<span class="muted">半径を広げると見つかることがあります。</span></div>';
    list.appendChild(div);
    return;
  }

  const toShow = nearby.slice(0, MAX_LIST_ITEMS);
  for (const s of toShow) {
    const card = document.createElement('div');
    card.className = 'card';

    const appleMaps = `https://maps.apple.com/?daddr=${encodeURIComponent(
      `${s.lat},${s.lng}`
    )}&q=${encodeURIComponent(s.name)}`;

    const telLink = s.phone ? `tel:${encodeURIComponent(s.phone)}` : '';

    card.innerHTML = `
      <h3 class="card-title">${escapeHtml(s.name)}</h3>
      <div class="meta">
        <div>${escapeHtml(s.address)} <span class="muted">（${fmtDistance(s._distance)}）</span></div>
        <div class="muted">電話: ${s.phone ? `<a href="${telLink}">${escapeHtml(s.phone)}</a>` : '—'}</div>
      </div>
      <div class="badges">
        <span class="badge">${escapeHtml(s.voucher)}</span>
        ${s.category ? `<span class="badge">${escapeHtml(s.category)}</span>` : ''}
      </div>
      <div class="actions">
        <a class="action-link" href="${appleMaps}" target="_blank" rel="noopener">地図アプリで開く</a>
        ${s.phone ? `<a class="action-link" href="${telLink}">電話</a>` : ''}
      </div>
    `;

    card.addEventListener('click', (e) => {
      // リンクタップはそのまま開く
      const target = e.target;
      if (target && target.tagName === 'A') return;
      focusStore(s.id);
    });

    list.appendChild(card);
  }
}

// -----------------------------
// データ読み込み
// -----------------------------

function loadCachedCoords(storeId) {
  try {
    const raw = localStorage.getItem(`${GEO_CACHE_PREFIX}${storeId}`);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj) return null;
    if (Number.isFinite(obj.lat) && Number.isFinite(obj.lng)) {
      return { lat: obj.lat, lng: obj.lng };
    }
    return null;
  } catch {
    return null;
  }
}

function saveCachedCoords(storeId, lat, lng) {
  try {
    localStorage.setItem(
      `${GEO_CACHE_PREFIX}${storeId}`,
      JSON.stringify({ lat, lng, ts: Date.now(), source: 'gsi' })
    );
  } catch {
    // localStorage が使えない場合は諦めます
  }
}

async function loadStores() {
  setStatus('店舗データを読み込んでいます…');

  const res = await fetch(STORE_DATA_URL, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`店舗データの読み込みに失敗しました: ${res.status}`);
  }
  const data = await res.json();
  if (!Array.isArray(data)) {
    throw new Error('店舗データの形式が想定と違います。');
  }

  stores = data.map((s) => ({
    id: String(s.id),
    name: s.name,
    voucher: s.voucher,
    category: s.category,
    address: s.address,
    postal: s.postal,
    phone: s.phone,
    fullAddress: s.fullAddress,
    lat: null,
    lng: null,
  }));

  // 1) localStorage のキャッシュを反映
  for (const s of stores) {
    const cached = loadCachedCoords(s.id);
    if (cached) {
      s.lat = cached.lat;
      s.lng = cached.lng;
    }
  }

  // 2) もし stores_geocoded.json が置いてあれば、それも反映（キャッシュより優先）
  try {
    const r = await fetch(PRE_GEOCODED_URL, { cache: 'no-store' });
    if (r.ok) {
      const geo = await r.json();
      if (Array.isArray(geo)) {
        const byId = new Map(geo.map((x) => [String(x.id), x]));
        for (const s of stores) {
          const g = byId.get(String(s.id));
          if (g && Number.isFinite(g.lat) && Number.isFinite(g.lng)) {
            s.lat = g.lat;
            s.lng = g.lng;
            saveCachedCoords(s.id, g.lat, g.lng);
          }
        }
      }
    }
  } catch {
    // 無視（任意ファイル）
  }

  const withCoords = stores.filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng)).length;
  const missing = stores.length - withCoords;

  if (missing === 0) {
    setStatus(`店舗データを読み込みました（${stores.length}件）。位置情報は準備済みです。`);
  } else {
    setStatus(`店舗データを読み込みました（${stores.length}件）。位置情報がない店舗: ${missing}件。`);
  }
}

// -----------------------------
// 住所→緯度経度（国土地理院）
// -----------------------------

function normalizeForQuery(s) {
  let out = String(s ?? '').trim();

  // 先頭の郵便番号（7桁）を取り除く（ジオコーディングの邪魔になることがある）
  out = out.replace(/^\d{7}\s*/, '');

  // ハイフン類を統一（例: ｰ, －, −, ― など）
  out = out.replace(/[ｰ－−―]/g, '-');

  // 全角スペース→半角
  out = out.replace(/\u3000/g, ' ');

  // 連続スペースを詰める
  out = out.replace(/\s+/g, ' ');

  return out;
}

function simplifiedQuery(s) {
  const q = normalizeForQuery(s);

  // 例: 海老名市泉2-2-12相模ﾋﾞﾙ2F -> 海老名市泉2-2-12
  // 例: 海老名市扇町5番4号103号室 -> 海老名市扇町5番4号
  const m1 = q.match(/^(.*?\d+(?:-\d+){1,4})/);
  if (m1) return m1[1];

  const m2 = q.match(/^(.*?\d+番\d+号)/);
  if (m2) return m2[1];

  return q;
}

async function geocodeOnce(query) {
  const url = `${GSI_GEOCODE_ENDPOINT}${encodeURIComponent(query)}`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) return null;

  const json = await res.json();
  if (!Array.isArray(json) || json.length === 0) return null;

  const feature = json[0];
  const coords = feature?.geometry?.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) return null;

  const lng = Number(coords[0]);
  const lat = Number(coords[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  return { lat, lng };
}

async function geocodeStore(store) {
  // fullAddress には「神奈川県」が入っているので、それを基本にします。
  const q1 = normalizeForQuery(store.fullAddress);
  const q2 = simplifiedQuery(store.fullAddress);
  const queries = Array.from(new Set([q1, q2])).filter(Boolean);

  for (const q of queries) {
    try {
      const hit = await geocodeOnce(q);
      if (hit) return hit;
    } catch {
      // 次の候補へ
    }
  }

  return null;
}

async function startGeocodeAll() {
  if (geocodeRunning) {
    setStatus(`店舗位置を準備中です…（${geocodeProgress.done}/${geocodeProgress.total}）`);
    return;
  }

  const missing = stores.filter((s) => !(Number.isFinite(s.lat) && Number.isFinite(s.lng)));
  if (missing.length === 0) {
    setStatus('店舗位置はすでに準備済みです。');
    updateResults();
    return;
  }

  geocodeRunning = true;
  geocodeProgress = { done: 0, total: missing.length };
  setStatus(`店舗位置を準備しています…（${geocodeProgress.done}/${geocodeProgress.total}）`);

  for (const s of missing) {
    // 直前にキャッシュが入った場合（他タブ等）も考慮
    const cached = loadCachedCoords(s.id);
    if (cached) {
      s.lat = cached.lat;
      s.lng = cached.lng;
      geocodeProgress.done += 1;
      continue;
    }

    const hit = await geocodeStore(s);
    if (hit) {
      s.lat = hit.lat;
      s.lng = hit.lng;
      saveCachedCoords(s.id, hit.lat, hit.lng);
    }

    geocodeProgress.done += 1;

    // 進捗表示（頻繁すぎないように）
    if (geocodeProgress.done % 5 === 0 || geocodeProgress.done === geocodeProgress.total) {
      setStatus(`店舗位置を準備しています…（${geocodeProgress.done}/${geocodeProgress.total}）`);
      scheduleUpdateResults();
    }

    await sleep(GEOCODE_DELAY_MS);
  }

  geocodeRunning = false;
  setStatus('店舗位置の準備が終わりました。');
  updateResults();
}

// -----------------------------
// 結果の更新
// -----------------------------

function scheduleUpdateResults() {
  if (pendingUpdateTimer) return;
  pendingUpdateTimer = setTimeout(() => {
    pendingUpdateTimer = null;
    updateResults();
  }, 250);
}

function updateResults() {
  if (!centerLatLng) {
    renderList([], null);
    return;
  }

  const radius = getRadiusMeters();
  if (centerCircle) centerCircle.setRadius(radius);

  const withCoords = stores.filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng));
  const missingCoords = stores.length - withCoords.length;

  const candidates = withCoords.filter(matchesVoucherFilter);

  const nearby = [];
  for (const s of candidates) {
    const d = distanceMeters(centerLatLng.lat, centerLatLng.lng, s.lat, s.lng);
    if (d <= radius) {
      s._distance = d;
      nearby.push(s);
    }
  }

  nearby.sort((a, b) => a._distance - b._distance);

  renderMarkers(nearby);
  renderList(nearby, { missingCoords });
}

// -----------------------------
// 現在地取得
// -----------------------------

function geolocationErrorMessage(err) {
  if (!err) return '現在地を取得できませんでした。';
  if (err.code === 1) return '位置情報の利用が許可されていません（許可にすると現在地で探せます）。';
  if (err.code === 2) return '現在地を取得できませんでした（電波状況などが原因のことがあります）。';
  if (err.code === 3) return '現在地の取得がタイムアウトしました。';
  return `現在地を取得できませんでした（${err.message || '不明なエラー'}）。`;
}

function locate() {
  if (!navigator.geolocation) {
    setStatus('このブラウザでは現在地の取得に対応していません。');
    return;
  }

  setStatus('現在地を取得しています…');

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      const latlng = L.latLng(lat, lng);
      setSearchCenter(latlng, { reason: 'locate' });
      map.setView([lat, lng], Math.max(map.getZoom(), 16));
    },
    (err) => {
      setStatus(geolocationErrorMessage(err));
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
  );
}

// -----------------------------
// UI
// -----------------------------

function wireUi() {
  $('btnLocate').addEventListener('click', locate);
  $('radius').addEventListener('change', () => {
    if (centerCircle && centerLatLng) {
      centerCircle.setRadius(getRadiusMeters());
    }
    updateResults();
  });
  $('voucherFilter').addEventListener('change', updateResults);
  $('btnStartGeocode').addEventListener('click', startGeocodeAll);
}

// -----------------------------
// 起動
// -----------------------------

async function main() {
  try {
    initMap();
    await loadStores();
    wireUi();
    renderList([], null);
  } catch (err) {
    console.error(err);
    setStatus('起動に失敗しました。');
    $('list').innerHTML =
      `<div class="card"><div class="meta">` +
      `読み込みに失敗しました。<span class="muted">${escapeHtml(err?.message || '')}</span>` +
      `</div></div>`;
  }
}

document.addEventListener('DOMContentLoaded', main);
