const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desk", {
  status: () => ipcRenderer.invoke("desk:status"),
  signIn: (token) => ipcRenderer.invoke("desk:sign-in", token),
  signOut: () => ipcRenderer.invoke("desk:sign-out"),
  browse: (login) => ipcRenderer.invoke("desk:browse", login),
  removeToken: (slot) => ipcRenderer.invoke("desk:remove-token", slot),
  github: (operation, args, slot) => ipcRenderer.invoke("desk:github", operation, args, slot),
  openTokenPage: (kind) => ipcRenderer.invoke("desk:open-token-page", kind),
  openReading: (id) => ipcRenderer.invoke("desk:open-reading", id),
  openGitHub: (repo, number) => ipcRenderer.invoke("desk:open-github", repo, number),
  history: () => ipcRenderer.invoke("desk:history"),
  clearHistory: () => ipcRenderer.invoke("desk:clear-history"),
  setHistory: (enabled) => ipcRenderer.invoke("desk:history-setting", enabled),
  saveSnapshot: (snapshot) => ipcRenderer.invoke("desk:snapshot", snapshot),
  notes: () => ipcRenderer.invoke("desk:notes"),
  saveNote: (note) => ipcRenderer.invoke("desk:note-save", note),
  deleteNote: (id) => ipcRenderer.invoke("desk:note-delete", id),
  cards: () => ipcRenderer.invoke("desk:cards"),
  setCard: (id, state) => ipcRenderer.invoke("desk:card-set", id, state),
  eventArchive: () => ipcRenderer.invoke("desk:event-archive"),
  setEventArchive: (level) => ipcRenderer.invoke("desk:event-archive-level", level),
});
