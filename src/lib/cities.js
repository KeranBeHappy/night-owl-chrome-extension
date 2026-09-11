/* Night Owl — 最近城市查询（纯本地，内置精简城市库）
 *
 * 只在设置页引入，不进 content script，避免给每个网页背上数据体积。
 * 用途：定位成功后告诉用户"定位到了哪里"，便于确认坐标是否正确。
 */
(function () {
  'use strict';

  var root = (typeof module !== 'undefined' && module.exports)
    ? module.exports
    : (typeof globalThis !== 'undefined' ? globalThis : window);

  var R = 6371;
  var METRO_RADIUS_KM = 30;   // 半径内有城市就报其中人口最大的那个，
                              // 避免上海市中心被报成 "Puxi" 这种城区名

  function rad(d) { return d * Math.PI / 180; }

  function distanceKm(lat1, lng1, lat2, lng2) {
    var dLat = rad(lat2 - lat1);
    var dLng = rad(lng2 - lng1);
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /* 线性扫描 3300 条记录，约 1ms，只在用户点定位时调一次 */
  function nearest(lat, lng) {
    var data = root.NW && root.NW.cities;
    if (!data || !data.list || !data.list.length) return null;
    if (!isFinite(lat) || !isFinite(lng)) return null;

    var list = data.list;
    var best = null, bestD = Infinity;   // 最近的条目（兜底）
    var main = null, mainD = Infinity, mainRank = Infinity;  // 半径内人口最大的城市

    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      var d = distanceKm(lat, lng, e[0] / 100, e[1] / 100);
      if (d < bestD) { bestD = d; best = e; }
      // 第 5 位是人口排名，缺失时按 Infinity 处理（老数据自动退化为纯最近邻）
      var rk = typeof e[4] === 'number' ? e[4] : Infinity;
      if (d <= METRO_RADIUS_KM && rk < mainRank) { mainRank = rk; mainD = d; main = e; }
    }

    var pick = main || best;
    if (!pick) return null;
    return {
      name: pick[2],
      country: pick[3],
      km: pick === main ? mainD : bestD,
      // major=false 说明附近没收录城市，这个结果只是"最近的条目"
      major: !!main
    };
  }

  /* distanceKm 是 nearest 内部辅助（球面距离公式）；
   * nearest() 是设置页唯一会调用的入口。 */
  var api = {
    nearest: nearest
  };

  // mount: browser -> globalThis.NW.geo ; node -> flat module.exports
  root.NW = root.NW || {};
  root.NW.geo = api;
  if (typeof module !== 'undefined' && module.exports) {
    for (var k in api) {
      if (Object.prototype.hasOwnProperty.call(api, k)) module.exports[k] = api[k];
    }
  }
})();
