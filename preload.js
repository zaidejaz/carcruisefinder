const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // Scraping operations
  startScraping: (options) => ipcRenderer.invoke('start-scraping', options),
  stopScraping: () => ipcRenderer.invoke('stop-scraping'),
  resetScraper: () => ipcRenderer.invoke('reset-scraper'),
  
  // Progress tracking - enhanced to include detailed progress info
  onScrapingProgress: (callback) => {
    // Remove any existing listeners to prevent duplicates
    ipcRenderer.removeAllListeners('scraping-progress');
    
    // Add the new listener
    ipcRenderer.on('scraping-progress', (event, message, progressInfo) => {
      callback(event, message, progressInfo);
    });
  },
  
  removeScrapingProgressListener: () => {
    ipcRenderer.removeAllListeners('scraping-progress');
  },
  
  // App state checks
  checkAppState: () => ipcRenderer.invoke('check-app-state'),
  
  // File operations
  saveCSVFile: () => ipcRenderer.invoke('save-csv-file'),
  
  // Logging operations
  getLogs: () => ipcRenderer.invoke('get-logs'),
  writeLogs: (logs) => ipcRenderer.invoke('write-logs', logs)
});