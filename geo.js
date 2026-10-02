// 球面最小二乘定位：由多个已知点 + 到信号源的距离，估出信号源坐标。
// 移植自 ZJU-live-better courses.zju/autosign.js 的 decimal.js 实现，改用 float64。
// 原 eps=1e-12 度会丢弃 Decimal(100) 的大部分精度（∂dist/∂lon ≈ 1.1e5 m/度，
// 扰动残差仅 ~1e-7 m）；float64 下取 eps=1e-6 度（≈0.11 m）可让雅可比保持在 ~10 位有效数字，
// 相对 500 m 的判定半径冗余充足。退化输入（共线/零距离/非有限值）返回 NaN，由调用方兜底。

export const R_EARTH = 6372999.26; // 与原实现一致的地球半径（米）

const DEG = Math.PI / 180;

export function haversineMeters(lon, lat, lonI, latI, r = R_EARTH) {
  const φ = lat * DEG;
  const φi = latI * DEG;
  const dφ = φ - φi;
  const dλ = (lon - lonI) * DEG;

  const sinDφHalf2 = Math.sin(dφ / 2) ** 2;
  const sinDλHalf2 = Math.sin(dλ / 2) ** 2;
  const h = sinDφHalf2 + Math.cos(φ) * Math.cos(φi) * sinDλHalf2;
  const deltaSigma = 2 * Math.asin(Math.min(1, Math.sqrt(h)));
  return r * deltaSigma;
}

function residuals(lon, lat, pts) {
  return pts.map((p) => p.d - haversineMeters(lon, lat, p.lon, p.lat));
}

// 数值雅可比（前向差分）
function jacobian(lon, lat, pts, base, eps) {
  const resLon = residuals(lon + eps, lat, pts);
  const resLat = residuals(lon, lat + eps, pts);
  return pts.map((_, i) => [
    -(resLon[i] - base[i]) / eps,
    -(resLat[i] - base[i]) / eps,
  ]);
}

export function solveSphereLeastSquares(rawPoints, { maxIterations = 30, eps = 1e-6 } = {}) {
  const pts = rawPoints.filter(
    (p) => [p.lon, p.lat, p.d].every(Number.isFinite) && p.d > 0
  );
  if (pts.length < 3) return { lon: NaN, lat: NaN, rms: NaN };

  let lon = pts.reduce((s, p) => s + p.lon, 0) / pts.length;
  let lat = pts.reduce((s, p) => s + p.lat, 0) / pts.length;

  for (let iter = 0; iter < maxIterations; iter++) {
    const r = residuals(lon, lat, pts);
    const J = jacobian(lon, lat, pts, r, eps);

    let a00 = 0, a01 = 0, a11 = 0, b0 = 0, b1 = 0;
    for (let i = 0; i < pts.length; i++) {
      const [jLon, jLat] = J[i];
      a00 += jLon * jLon;
      a01 += jLon * jLat;
      a11 += jLat * jLat;
      b0 += jLon * r[i];
      b1 += jLat * r[i];
    }

    const det = a00 * a11 - a01 * a01;
    if (!Number.isFinite(det) || det === 0) return { lon: NaN, lat: NaN, rms: NaN };

    // 2x2 逆乘 JTr 得高斯-牛顿步进
    const dLon = (a11 * b0 - a01 * b1) / det;
    const dLat = (-a01 * b0 + a00 * b1) / det;
    if (!Number.isFinite(dLon) || !Number.isFinite(dLat)) {
      return { lon: NaN, lat: NaN, rms: NaN };
    }

    lon += dLon;
    lat += dLat;
    if (Math.abs(dLon) < 1e-9 && Math.abs(dLat) < 1e-9) break;
  }

  const r = residuals(lon, lat, pts);
  const rms = Math.sqrt(r.reduce((s, v) => s + v * v, 0) / pts.length);
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || !Number.isFinite(rms)) {
    return { lon: NaN, lat: NaN, rms: NaN };
  }
  return { lon, lat, rms };
}
