'use strict';

const COORDS = {
  us: { latitude: 37.0902, longitude: -95.7129 },
  gb: { latitude: 51.5074, longitude: -0.1278 },
  uk: { latitude: 51.5074, longitude: -0.1278 },
  de: { latitude: 52.52, longitude: 13.405 },
  fr: { latitude: 48.8566, longitude: 2.3522 },
  in: { latitude: 28.6139, longitude: 77.209 },
  au: { latitude: -33.8688, longitude: 151.2093 },
  ca: { latitude: 43.6532, longitude: -79.3832 },
  jp: { latitude: 35.6762, longitude: 139.6503 },
  br: { latitude: -23.5505, longitude: -46.6333 },
  nl: { latitude: 52.3676, longitude: 4.9041 },
  es: { latitude: 40.4168, longitude: -3.7038 },
  it: { latitude: 41.9028, longitude: 12.4964 },
  mx: { latitude: 19.4326, longitude: -99.1332 },
  sg: { latitude: 1.3521, longitude: 103.8198 },
};

function parseCoords(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/(-?\d+(?:\.\d+)?)\s*[,/]\s*(-?\d+(?:\.\d+)?)/);
  if (!m) return null;
  const latitude = Number(m[1]);
  const longitude = Number(m[2]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return { latitude, longitude, accuracy: 100000 };
}

function fromCountry(gl) {
  const g = String(gl || 'us').toLowerCase().slice(0, 8);
  const c = COORDS[g] || COORDS.us;
  return { latitude: c.latitude, longitude: c.longitude, accuracy: 100000 };
}

function coordsFor({ gl, proxy, explicit } = {}) {
  if (explicit) {
    const parsed = typeof explicit === 'string' ? parseCoords(explicit) : explicit;
    if (parsed && parsed.latitude != null) return { ...parsed, accuracy: parsed.accuracy || 100000 };
  }
  const fromProxy = String(proxy || '').match(/lat=(-?\d+(?:\.\d+)?)[,&]?(?:lon|lng)=(-?\d+(?:\.\d+)?)/i);
  if (fromProxy) {
    return { latitude: Number(fromProxy[1]), longitude: Number(fromProxy[2]), accuracy: 100000 };
  }
  return fromCountry(gl);
}

module.exports = { coordsFor, parseCoords, fromCountry, COORDS };
