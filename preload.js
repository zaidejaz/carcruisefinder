const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  startScraping: () => ipcRenderer.invoke('start-scraping'),
  resetScraper: () => ipcRenderer.invoke('reset-scraper'),
  onScrapingProgress: (callback) => ipcRenderer.on('scraping-progress', callback),
  removeScrapingProgressListener: () => ipcRenderer.removeAllListeners('scraping-progress')
});