const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const { ComprehensiveCarEventScraper } = require('./scraper');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWindow.loadFile('index.html');
}

// IPC handlers for scraper interactions
app.whenReady().then(() => {
  createWindow();

  // Scraper instance
  let scraperInstance = null;

  // IPC handler to start scraping
  ipcMain.handle('start-scraping', async (event) => {
    try {
      // Create scraper instance
      scraperInstance = new ComprehensiveCarEventScraper();
      
      // Read state links
      const stateLinksPath = path.join(__dirname, 'state-car-show-links.json');
      const stateLinksData = JSON.parse(await fs.readFile(stateLinksPath, 'utf8'));
      
      // Transform state links to include names
      const stateLinks = stateLinksData.stateCarShowLinks.map(link => {
        const stateName = link
          .split('/')[1]
          .replace('-car-events', '')
          .split('-')
          .map(word => word.charAt(0).toUpperCase() + word.slice(1))
          .join(' ');
        
        return { link, name: stateName };
      });

      // Start scraping with progress tracking
      const progressTracking = (message) => {
        mainWindow.webContents.send('scraping-progress', message);
      };

      // Override scraping methods to send progress
      scraperInstance.onProgress = progressTracking;

      // Start scraping
      await scraperInstance.scrapeAllEvents(stateLinks);

      return { success: true, message: 'Scraping completed successfully' };
    } catch (error) {
      console.error('Scraping error:', error);
      return { 
        success: false, 
        message: error.message || 'An error occurred during scraping' 
      };
    }
  });

  // IPC handler to reset scraper
  ipcMain.handle('reset-scraper', async (event) => {
    try {
      // Remove progress file
      const progressPath = path.join(__dirname, 'scraper_progress.json');
      await fs.unlink(progressPath).catch(() => {});

      // Remove CSV file
      const csvPath = path.join(__dirname, 'car_events_details.csv');
      await fs.unlink(csvPath).catch(() => {});

      return { success: true, message: 'Scraper reset successfully' };
    } catch (error) {
      console.error('Reset error:', error);
      return { 
        success: false, 
        message: error.message || 'An error occurred while resetting' 
      };
    }
  });

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});