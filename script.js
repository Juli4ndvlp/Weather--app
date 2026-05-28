// ═══════════════════════════════════════════════════════════
//  Weather App — script.js
//  Open-Meteo API (clima) + Windy Webcam API (cámaras)
//  MIT License — Copyright (c) 2025
//
//  CÓMO OBTENER TU API KEY DE WINDY (gratis):
//  1. Ve a https://api.windy.com/
//  2. Crea una cuenta gratuita
//  3. En el dashboard crea una nueva app → copia la key
//  4. Pégala en la constante WINDY_API_KEY de abajo
// ═══════════════════════════════════════════════════════════

// ── API Key de Windy ─────────────────────────────────────────
// Reemplaza este valor con tu key real.
// Sin ella la sección de cámara no aparecerá.
const WINDY_API_KEY = "hObWh6fvPtBjzVK1RqkE2G4fxQzZqcoj";

// ── Constantes de caché y privacidad ─────────────────────────
const CACHE_KEY    = "weather_cache";
const HISTORY_KEY  = "weather_history";
const CONSENT_KEY  = "weather_consent"; // "granted" | "denied"
const CACHE_TTL_MS = 10 * 60 * 1000;          // 10 minutos
const HISTORY_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 días

// Radio de búsqueda de webcams (km).
// Si no hay cámara en 50 km, se muestra mensaje informativo.
const CAM_SEARCH_RADIUS_KM = 50;

// ── Traducciones WMO ─────────────────────────────────────────
const WMO_CODES = {
  0:  "Cielo despejado",
  1:  "Principalmente despejado",
  2:  "Parcialmente nublado",
  3:  "Nublado",
  45: "Niebla",
  48: "Niebla helada",
  51: "Llovizna ligera",
  53: "Llovizna moderada",
  55: "Llovizna densa",
  61: "Lluvia ligera",
  63: "Lluvia moderada",
  65: "Lluvia fuerte",
  71: "Nevada ligera",
  73: "Nevada moderada",
  75: "Nevada fuerte",
  80: "Chubascos ligeros",
  81: "Chubascos moderados",
  82: "Chubascos violentos",
  95: "Tormenta eléctrica",
  99: "Tormenta con granizo",
};

const WMO_ICONS = {
  0: "☀️", 1: "🌤️", 2: "⛅", 3: "☁️",
  45: "🌫️", 48: "🌫️",
  51: "🌦️", 53: "🌦️", 55: "🌧️",
  61: "🌧️", 63: "🌧️", 65: "⛈️",
  71: "❄️", 73: "❄️", 75: "❄️",
  80: "🌧️", 81: "⛈️", 82: "⛈️",
  95: "⛈️", 99: "⛈️",
};

// ── Estado en memoria ─────────────────────────────────────────
let cache    = {};
let history  = [];
let isOnline = navigator.onLine;

// ═══════════════════════════════════════════════════════════
//  CONSENTIMIENTO
// ═══════════════════════════════════════════════════════════

function hasConsent()    { return localStorage.getItem(CONSENT_KEY) === "granted"; }
function consentDenied() { return localStorage.getItem(CONSENT_KEY) === "denied"; }

function grantConsent() {
  localStorage.setItem(CONSENT_KEY, "granted");
  document.getElementById("consent-banner").style.display = "none";
  loadStore();
  renderHistoryPanel();
  renderCachePanel();
}

function denyConsent() {
  localStorage.setItem(CONSENT_KEY, "denied");
  document.getElementById("consent-banner").style.display = "none";
}

// ═══════════════════════════════════════════════════════════
//  PERSISTENCIA
// ═══════════════════════════════════════════════════════════

function loadStore() {
  if (!hasConsent()) return;
  try {
    cache = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}");
  } catch { cache = {}; }
  try {
    const raw = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    history = raw
      .map((h) => (typeof h === "string" ? { city: h, savedAt: Date.now() } : h))
      .filter((h) => h && typeof h.city === "string" && Date.now() - (h.savedAt || 0) < HISTORY_TTL_MS);
  } catch { history = []; }
}

function saveCache()   { if (!hasConsent()) return; try { localStorage.setItem(CACHE_KEY,   JSON.stringify(cache));   } catch (_) {} }
function saveHistory() { if (!hasConsent()) return; try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); } catch (_) {} }

// ═══════════════════════════════════════════════════════════
//  HELPERS DE CACHÉ
// ═══════════════════════════════════════════════════════════

function cacheKey(city) { return city.trim().toLowerCase(); }

function getCached(city) {
  const entry = cache[cacheKey(city)];
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    delete cache[cacheKey(city)];
    saveCache();
    return null;
  }
  return entry;
}

function setCache(city, data) {
  cache[cacheKey(city)] = { data, timestamp: Date.now(), cityRaw: data.city };
  saveCache();
}

// ── Caché vencida: usada como fallback offline ───────────────
function getStaleCache(city) {
  return cache[cacheKey(city)] || null;
}

// ═══════════════════════════════════════════════════════════
//  HISTORIAL
// ═══════════════════════════════════════════════════════════

function addHistory(city) {
  const entry = { city, savedAt: Date.now() };
  history = [entry, ...history.filter((h) => h.city.toLowerCase() !== city.toLowerCase())].slice(0, 6);
  saveHistory();
}

// ═══════════════════════════════════════════════════════════
//  RED — HELPERS
// ═══════════════════════════════════════════════════════════

/**
 * fetch con timeout de 5s usando AbortController.
 * Evita que la app se cuelgue si la API no responde.
 */
async function fetchWithTimeout(url, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return response;
  } catch (error) {
    clearTimeout(timer);
    if (error.name === "AbortError") {
      throw new Error(`Tiempo de espera agotado (${timeoutMs / 1000}s).`);
    }
    throw error;
  }
}

/**
 * fetch con timeout + header de autenticación de Windy.
 * Separado de fetchWithTimeout para no mezclar APIs.
 */
async function fetchWindy(url, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { "x-windy-api-key": WINDY_API_KEY },
      signal: controller.signal,
    });
    clearTimeout(timer);
    return response;
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
}

// ═══════════════════════════════════════════════════════════
//  API — CLIMA (Open-Meteo)
// ═══════════════════════════════════════════════════════════

// PASO 1: ciudad → coordenadas
async function getCoordsFromCity(city) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=es`;
  let response;
  try {
    response = await fetchWithTimeout(url);
  } catch (networkError) {
    throw new Error(`Error de red al geocodificar "${city}": ${networkError.message}`);
  }
  if (!response.ok) throw new Error(`Geocoding API respondió con HTTP ${response.status}`);
  const data = await response.json();
  if (!data.results?.length) throw new Error(`Ciudad no encontrada: "${city}". Verifica el nombre e intenta de nuevo.`);
  const { name, latitude, longitude } = data.results[0];
  return { name, latitude, longitude };
}

// PASO 2: coordenadas → clima actual + humedad
async function getWeatherFromCoords(latitude, longitude) {
  const url = [
    `https://api.open-meteo.com/v1/forecast`,
    `?latitude=${latitude}&longitude=${longitude}`,
    `&current_weather=true`,
    `&hourly=relativehumidity_2m`,
    `&temperature_unit=celsius`,
    `&wind_speed_unit=kmh`,
    `&timezone=auto`,
  ].join("");
  let response;
  try {
    response = await fetchWithTimeout(url);
  } catch (networkError) {
    throw new Error(`Error de red al obtener el clima: ${networkError.message}`);
  }
  if (!response.ok) throw new Error(`Weather API respondió con HTTP ${response.status}`);
  const data = await response.json();
  const currentHour = new Date().getHours();
  const humidity = data.hourly?.relativehumidity_2m?.[currentHour] ?? null;
  return { ...data.current_weather, humidity };
}

// PASO 3: orquestador principal
async function fetchWeather(city) {
  const { name, latitude, longitude } = await getCoordsFromCity(city.trim());
  const w = await getWeatherFromCoords(latitude, longitude);
  return {
    city:                name,
    latitude,                                              // ← guardados en caché
    longitude,                                             // ← para lookup de webcam
    temperature_celsius: Math.round(w.temperature * 10) / 10,
    wind_speed_kmh:      Math.round(w.windspeed),
    weathercode:         w.weathercode,
    humidity:            w.humidity !== null ? Math.round(w.humidity) : null,
  };
}

// ═══════════════════════════════════════════════════════════
//  API — WEBCAM (Windy)
// ═══════════════════════════════════════════════════════════

/**
 * Busca la webcam más cercana a las coordenadas dadas.
 * Usa el endpoint /webcams de Windy API v3.
 */
async function getNearbyCam(latitude, longitude) {
  const url = `https://api.windy.com/webcams/api/v3/webcams?nearby=${latitude},${longitude},${CAM_SEARCH_RADIUS_KM}&limit=1&include=player`;
  try {
    const response = await fetchWindy(url);
    if (!response.ok) return null;
    const data = await response.json();
    return data.webcams?.[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Orquesta la búsqueda y renderizado de la webcam.
 * ARREGLADO: Limpieza estricta de parámetros para evitar el error 400.
 */
async function loadWebcam(latitude, longitude, cityName) {
  const section   = document.getElementById("cam-section");
  const container = document.getElementById("cam-container");

  if (!WINDY_API_KEY || WINDY_API_KEY === "TU_API_KEY_AQUI") {
    section.style.display = "none";
    return;
  }

  if (!navigator.onLine) {
    section.style.display = "none";
    return;
  }

  section.style.display = "";
  container.innerHTML = `<p class="cam-loading">&#128247; Buscando cámara cercana...</p>`;

  const cam = await getNearbyCam(latitude, longitude);

  if (!cam) {
    container.innerHTML = `
      <p class="cam-empty">
        Sin cámara disponible en un radio de ${CAM_SEARCH_RADIUS_KM} km de ${cityName}.
      </p>`;
    return;
  }

  if (!cam.webcamId) {
    container.innerHTML = `<p class="cam-empty">Sin cámara disponible para ${cityName}.</p>`;
    return;
  }

  // ── REPARACIÓN INCONDICIONAL DE LA URL ─────────────────────────
  let embedUrl = "";
  
  if (cam.player?.embed) {
    // Si la URL de Windy ya trae algún parámetro previo, le quitamos todo 
    // lo que esté después del signo '?' para construirla de forma limpia.
    const baseUrl = cam.player.embed.split('?')[0];
    embedUrl = `${baseUrl}?playertype=day`;
  } else {
    // Fallback directo usando la estructura por ID si el objeto embed falla
    embedUrl = `https://webcams.windy.com/webcams/public/embed/player/${cam.webcamId}/day`;
  }

  console.log("[WeatherApp] Cargando iframe con URL:", embedUrl);

  container.innerHTML = `
    <div class="cam-meta">
      <span class="cam-title">${cam.title ?? cityName}</span>
      <a
        href="https://www.windy.com/webcams/${cam.webcamId}"
        target="_blank"
        rel="noopener"
        class="cam-link"
      >Ver en Windy ↗</a>
    </div>
    <iframe
      src="${embedUrl}"
      class="cam-iframe"
      allowfullscreen
      loading="lazy"
      title="Cámara en vivo — ${cam.title ?? cityName}"
    ></iframe>`;
}


// ═══════════════════════════════════════════════════════════
//  RENDER — UI
// ═══════════════════════════════════════════════════════════

function setStatus(msg) {
  document.getElementById("status").textContent = msg;
}

function minutesLeft(timestamp) {
  return Math.max(0, Math.round((CACHE_TTL_MS - (Date.now() - timestamp)) / 60000));
}

function ageLabel(timestamp) {
  const s = Math.floor((Date.now() - timestamp) / 1000);
  if (s < 60) return `hace ${s}s`;
  return `hace ${Math.floor(s / 60)}min`;
}

function renderBadge(type) {
  const configs = {
    live:    { cls: "badge-live",    dot: "dot-live",    label: "Datos en vivo" },
    cached:  { cls: "badge-cached",  dot: "dot-cached",  label: "Desde caché"   },
    offline: { cls: "badge-offline", dot: "dot-offline", label: "Sin conexión"  },
  };
  const { cls, dot, label } = configs[type];
  return `<span class="cache-badge ${cls}"><span class="dot ${dot}"></span>${label}</span>`;
}

function renderCard(data, source) {
  const icon     = WMO_ICONS[data.weathercode]  ?? "🌡️";
  const desc     = WMO_CODES[data.weathercode]  ?? `Código ${data.weathercode}`;
  const badgeType = source === "live" ? "live" : isOnline ? "cached" : "offline";
  const humidity  = data.humidity !== null ? `${data.humidity}%` : "—";

  document.getElementById("result").innerHTML = `
    ${renderBadge(badgeType)}
    <div class="weather-card">
      <div class="card-header">
        <span class="weather-icon" aria-hidden="true">${icon}</span>
        <span class="city-name">${data.city}</span>
      </div>
      <div class="weather-desc">${desc}</div>
      <div class="metrics">
        <div class="metric">
          <div class="val">${data.temperature_celsius}°C</div>
          <div class="lbl">Temperatura</div>
        </div>
        <div class="metric">
          <div class="val">${data.wind_speed_kmh}</div>
          <div class="lbl">km/h viento</div>
        </div>
        <div class="metric">
          <div class="val">${humidity}</div>
          <div class="lbl">Humedad</div>
        </div>
      </div>
    </div>`;

  renderCachePanel();
}

function renderHistoryPanel() {
  const sec = document.getElementById("history-section");
  if (history.length === 0) { sec.style.display = "none"; return; }
  sec.style.display = "";
  document.getElementById("history-list").innerHTML = history
    .map((h) => `<span class="history-chip" data-city="${h.city}">${h.city}</span>`)
    .join("");
}

function renderCachePanel() {
  const entries = Object.values(cache);
  const sec = document.getElementById("cache-section");
  if (entries.length === 0) { sec.style.display = "none"; return; }
  sec.style.display = "";
  document.getElementById("cache-entries").innerHTML = entries
    .map((e) => `
      <div class="cache-entry">
        <span class="city-col">${e.cityRaw || e.data.city}</span>
        <span class="age-col">${ageLabel(e.timestamp)} · expira en ${minutesLeft(e.timestamp)}min</span>
      </div>`)
    .join("");
}

function clearCache() {
  cache   = {};
  history = [];
  localStorage.removeItem(CACHE_KEY);
  localStorage.removeItem(HISTORY_KEY);
  renderCachePanel();
  renderHistoryPanel();
  document.getElementById("result").innerHTML     = "";
  document.getElementById("cam-section").style.display = "none";
  setStatus("Caché e historial eliminados.");
}

// ═══════════════════════════════════════════════════════════
//  FLUJO PRINCIPAL DE BÚSQUEDA
// ═══════════════════════════════════════════════════════════

async function handleSearch() {
  const city = document.getElementById("city-input").value.trim();
  if (!city) { setStatus("Escribe el nombre de una ciudad."); return; }

  const cached = getCached(city);
  isOnline = navigator.onLine;

  if (!isOnline) {
    document.getElementById("offline-banner").style.display = "block";
    document.getElementById("cam-section").style.display = "none";

    if (cached) {
      setStatus("Sin conexión — mostrando datos del caché local.");
      renderCard(cached.data, "offline");
      addHistory(city);
      renderHistoryPanel();
    } else {
      const stale = getStaleCache(city);
      if (stale) {
        setStatus("Sin conexión — datos guardados (pueden estar desactualizados).");
        renderCard(stale.data, "offline");
      } else {
        setStatus(`Sin conexión y sin datos guardados para "${city}".`);
        document.getElementById("result").innerHTML = "";
      }
    }
    return;
  }

  document.getElementById("offline-banner").style.display = "none";

  if (cached) {
    const mins = minutesLeft(cached.timestamp);
    setStatus(`Caché válido (expira en ${mins}min) — sin llamada a la API.`);
    renderCard(cached.data, "cached");
    addHistory(city);
    renderHistoryPanel();
    if (cached.data.latitude && cached.data.longitude) {
      loadWebcam(cached.data.latitude, cached.data.longitude, cached.data.city);
    }
    return;
  }

  setStatus("Consultando la API...");
  document.getElementById("search-btn").disabled = true;
  document.getElementById("cam-section").style.display = "none";

  try {
    const data = await fetchWeather(city);
    setCache(city, data);
    addHistory(data.city);
    renderCard(data, "live");
    setStatus("");
    renderHistoryPanel();
    loadWebcam(data.latitude, data.longitude, data.city);
  } catch (err) {
    const stale = getStaleCache(city);
    if (stale) {
      setStatus("Error de red — usando datos guardados (pueden estar desactualizados).");
      renderCard(stale.data, "offline");
    } else {
      setStatus("Error: " + err.message);
      document.getElementById("result").innerHTML = "";
    }
  } finally {
    document.getElementById("search-btn").disabled = false;
  }
}

// ═══════════════════════════════════════════════════════════
//  EVENTOS
// ═══════════════════════════════════════════════════════════

document.getElementById("city-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") handleSearch();
});

document.getElementById("search-btn").addEventListener("click", handleSearch);
document.getElementById("clear-btn").addEventListener("click", clearCache);

document.getElementById("history-list").addEventListener("click", (e) => {
  const chip = e.target.closest(".history-chip");
  if (!chip) return;
  document.getElementById("city-input").value = chip.dataset.city;
  handleSearch();
});

window.addEventListener("online", () => {
  isOnline = true;
  document.getElementById("offline-banner").style.display = "none";
  setStatus("Conexión restaurada.");
});

window.addEventListener("offline", () => {
  isOnline = false;
  document.getElementById("offline-banner").style.display = "block";
  document.getElementById("cam-section").style.display = "none";
  setStatus("Sin conexión — usando caché local.");
});

// ═══════════════════════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════════════════════

document.getElementById("consent-accept").addEventListener("click", grantConsent);
document.getElementById("consent-reject").addEventListener("click", denyConsent);

const consentDecided = localStorage.getItem(CONSENT_KEY);
if (!consentDecided) {
  document.getElementById("consent-banner").style.display = "block";
} else {
  loadStore();
  renderHistoryPanel();
  renderCachePanel();
}