"use strict";

// src/preload/index.ts
var import_electron = require("electron");
var api = {
  load: () => import_electron.ipcRenderer.invoke("db:load"),
  openOrImport: () => import_electron.ipcRenderer.invoke("db:openOrImport"),
  openSample: () => import_electron.ipcRenderer.invoke("db:openSample"),
  reload: () => import_electron.ipcRenderer.invoke("db:reload"),
  updateItems: (changes) => import_electron.ipcRenderer.invoke("db:updateItems", changes),
  undo: () => import_electron.ipcRenderer.invoke("db:undo"),
  addItem: (projectId, type, start, end) => import_electron.ipcRenderer.invoke("db:addItem", projectId, type, start, end),
  saveView: (name, def) => import_electron.ipcRenderer.invoke("db:saveView", name, def),
  deleteView: (id) => import_electron.ipcRenderer.invoke("db:deleteView", id),
  setLabels: (scope, patch, mode) => import_electron.ipcRenderer.invoke("db:setLabels", scope, patch, mode),
  dataTables: () => import_electron.ipcRenderer.invoke("data:tables"),
  dataPage: (table, opts) => import_electron.ipcRenderer.invoke("data:page", table, opts),
  dataUpdate: (table, key, column, value, v) => import_electron.ipcRenderer.invoke("data:update", table, key, column, value, v),
  dataInsert: (table, values) => import_electron.ipcRenderer.invoke("data:insert", table, values),
  dataDelete: (table, key) => import_electron.ipcRenderer.invoke("data:delete", table, key),
  exportView: (req) => import_electron.ipcRenderer.invoke("export:view", req),
  onDataChanged: (cb) => {
    const h = (_e, ds, why) => cb(ds, why);
    import_electron.ipcRenderer.on("db:changed", h);
    return () => import_electron.ipcRenderer.removeListener("db:changed", h);
  },
  onMenu: (cb) => {
    const h = (_e, cmd) => cb(cmd);
    import_electron.ipcRenderer.on("menu", h);
    return () => import_electron.ipcRenderer.removeListener("menu", h);
  },
  getExportState: () => import_electron.ipcRenderer.invoke("export:state"),
  exportReady: () => import_electron.ipcRenderer.send("export:ready")
};
if (location.hash === "#selftest") {
  api.testOutsideWrite = (id, start) => import_electron.ipcRenderer.invoke("test:outsideWrite", id, start);
}
import_electron.contextBridge.exposeInMainWorld("untangle", api);
