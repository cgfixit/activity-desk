const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desk", {
  status: () => ipcRenderer.invoke("desk:status"),
  signIn: (token) => ipcRenderer.invoke("desk:sign-in", token),
  signOut: () => ipcRenderer.invoke("desk:sign-out"),
  github: (operation, args) => ipcRenderer.invoke("desk:github", operation, args),
  openTokenPage: () => ipcRenderer.invoke("desk:open-token-page"),
});
