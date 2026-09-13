/* ============================================================
 * GoodJust — serialize.js
 * .gjs 工程文件（JSON）保存 / 加载
 * ============================================================ */
"use strict";

const Serialize = (() => {

  function save(project) {
    return JSON.stringify(project, null, 2);
  }

  function load(json) {
    const p = JSON.parse(json);
    if (!p || !Array.isArray(p.scenes)) throw new Error("无效的工程文件");
    // 恢复 id 计数器
    let maxId = 0;
    const walk = (o) => {
      if (o && typeof o === "object") {
        if (typeof o.id === "number") maxId = Math.max(maxId, o.id);
        for (const k of Object.keys(o)) walk(o[k]);
      }
    };
    walk(p);
    Model.setNextId(maxId + 1);
    return p;
  }

  return { save, load };
})();
