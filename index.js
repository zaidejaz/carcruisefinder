const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs-extra');

// Set up global error handling
process.on('uncaughtException', (error) => {
  console.error('UNCAUGHT EXCEPTION:', error);
});

// Global variables
let mainWindow;
let scraperInstance = null;
let isScraperRunning = false;
let scrapedDataExists = false;
let trackedEventLinks = new Set();
global.isScraperRunning = false;

// App directories and paths
const APP_DATA_DIR = path.join(app.getPath('userData'), 'car-events-scraper');
const CSV_OUTPUT_DIR = path.join(APP_DATA_DIR, 'output');
const LOGS_DIR = path.join(APP_DATA_DIR, 'logs');
const LOG_FILE_PATH = path.join(LOGS_DIR, 'scraper.log');
const PROGRESS_FILE_PATH = path.join(APP_DATA_DIR, 'scraper_progress.json');
const CSV_FILE_PATH = path.join(CSV_OUTPUT_DIR, 'car_events_details.csv');

// Function to create the main window
function createWindow() {
  console.log('Creating window...');
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

  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
  }

  console.log('Window created successfully');
}

// Helper functions
async function readLogFile() {
  try {
    await fs.ensureFile(LOG_FILE_PATH);
    const logContent = await fs.readFile(LOG_FILE_PATH, 'utf8');
    const logs = logContent.split('\n')
      .filter(line => line.trim() !== '')
      .slice(-500)
      .map(line => {
        const timestampMatch = line.match(/^([^-]+-[^-]+-[^-]+) - (.*)$/);
        if (timestampMatch) {
          const [, timestamp, message] = timestampMatch;
          const type = message.toLowerCase().includes('error') ? 'error' :
            message.toLowerCase().includes('completed') ? 'success' :
              'info';
          return { timestamp, message, type };
        } else {
          return {
            timestamp: new Date().toISOString(),
            message: line,
            type: 'info'
          };
        }
      });
    return logs;
  } catch (error) {
    console.error('Error reading log file:', error);
    return [];
  }
}

async function writeLogEntry(message) {
  try {
    await fs.ensureFile(LOG_FILE_PATH);
    const logEntry = `${new Date().toISOString()} - ${message}\n`;
    await fs.appendFile(LOG_FILE_PATH, logEntry);
    return true;
  } catch (error) {
    console.error('Error writing log entry:', error);
    return false;
  }
}

async function loadPreviousProgress() {
  try {
    const progressExists = await fs.pathExists(PROGRESS_FILE_PATH);
    if (progressExists) {
      const progressData = await fs.readJSON(PROGRESS_FILE_PATH);

      // Load tracked event links if available
      if (progressData.trackedEventLinks && Array.isArray(progressData.trackedEventLinks)) {
        trackedEventLinks = new Set(progressData.trackedEventLinks);
      }

      return progressData;
    }
    return null;
  } catch (error) {
    console.error('Error loading previous progress:', error);
    return null;
  }
}

async function checkCsvExists() {
  try {
    const csvExists = await fs.pathExists(CSV_FILE_PATH);
    if (csvExists) {
      const stats = await fs.stat(CSV_FILE_PATH);
      return stats.size > 0;
    }
    return false;
  } catch (error) {
    console.error('Error checking CSV file:', error);
    return false;
  }
}

// Set up all IPC handlers
function setupIpcHandlers() {
  // IPC handler to get logs
  ipcMain.handle('get-logs', async () => {
    return await readLogFile();
  });

  // IPC handler for checking app state
  ipcMain.handle('check-app-state', async () => {
    try {
      // Recheck CSV existence
      const csvHasContent = await checkCsvExists();
      scrapedDataExists = csvHasContent;

      // Check progress file
      const progressExists = await fs.pathExists(PROGRESS_FILE_PATH);

      return {
        isScraperRunning,
        scrapedDataExists: csvHasContent,
        hasProgress: progressExists
      };
    } catch (error) {
      console.error('Error checking app state:', error);
      return {
        isScraperRunning: false,
        scrapedDataExists: false,
        hasProgress: false
      };
    }
  });

  // IPC handler to start scraping
  ipcMain.handle('start-scraping', async (event, options = {}) => {
    // Ensure directories exist
    await fs.ensureDir(APP_DATA_DIR);
    await fs.ensureDir(CSV_OUTPUT_DIR);
    await fs.ensureDir(LOGS_DIR);

    // Prevent multiple scraping instances
    if (isScraperRunning) {
      return {
        success: false,
        message: 'Scraper is already running'
      };
    }

    try {
      // Explicitly set running state
      isScraperRunning = true;
      global.isScraperRunning = true;


      // Log the start of scraping
      await writeLogEntry('Scraping started');

      // Ensure UI reflects running state
      mainWindow.webContents.send('scraping-progress', 'Scraping started');

      // Require scraper dynamically to ensure fresh instance
      const { ComprehensiveCarEventScraper } = require('./scraper');

      // Determine if we're resuming
      let resumeFromState = 0;
      let progressData = null;

      if (options.resume) {
        progressData = await loadPreviousProgress();
        if (progressData && typeof progressData.currentState === 'number') {
          resumeFromState = progressData.currentState;
          await writeLogEntry(`Resuming scraping from state index ${resumeFromState}`);
        }
      }

      // Create scraper instance with custom output paths
      scraperInstance = new ComprehensiveCarEventScraper({
        csvPath: CSV_FILE_PATH,
        progressPath: PROGRESS_FILE_PATH,
        logsPath: LOG_FILE_PATH,
        trackedEventLinks,
        maxConcurrency: 3  // Limit concurrency to avoid rate limiting
      });

      // If we have progress data, set the internal state
      if (progressData) {
        scraperInstance.currentState = progressData.currentState || 0;
        scraperInstance.totalStates = progressData.totalStates || 0;
        scraperInstance.processedEvents = progressData.processedEvents || 0;
        scraperInstance.totalEventsFound = progressData.totalEventsFound || 0;
      }

      if (options.resume && progressData) {
        scraperInstance.currentState = progressData.currentState || 0;
        scraperInstance.totalStates = progressData.totalStates || 0;
        scraperInstance.processedEvents = progressData.processedEvents || 0;
        scraperInstance.totalEventsFound = progressData.totalEventsFound || 0;

        // Send initial stats to the UI immediately
        mainWindow.webContents.send('scraping-progress', 'Resuming with previous data', {
          stats: {
            statesProcessed: scraperInstance.currentState,
            totalStates: scraperInstance.totalStates,
            eventsProcessed: scraperInstance.processedEvents,
            totalEvents: scraperInstance.totalEventsFound,
            // If you have the current state name stored, include it here
            currentStateName: progressData.currentStateName || 'Resuming...'
          }
        });
      }

      // Read state links
      const stateLinksPath = path.join(__dirname, 'state-car-show-links.json');

      // Check if file exists
      const stateLinksExists = await fs.pathExists(stateLinksPath);
      if (!stateLinksExists) {
        throw new Error(`State links file not found at ${stateLinksPath}`);
      }

      const stateLinksData = await fs.readJSON(stateLinksPath);

      if (!stateLinksData || !stateLinksData.stateCarShowLinks || !Array.isArray(stateLinksData.stateCarShowLinks)) {
        throw new Error('Invalid state links data format');
      }

      // Transform state links to include names
      const stateLinks = stateLinksData.stateCarShowLinks.map(link => {
        // Extract state name from URL segment
        let stateName;
        try {
          stateName = link
            .split('/')[1]
            .replace('-car-events', '')
            .replace('-car-shows', '')
            .split('-')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');
        } catch (e) {
          // Fallback if URL parsing fails
          stateName = link.replace(/https?:\/\/[^/]+\//, '')
            .replace(/\/.*/, '')
            .replace(/-/g, ' ');
        }

        return { link, name: stateName || 'Unknown State' };
      });

      if (stateLinks.length === 0) {
        throw new Error('No state links found');
      }

      // Override scraping methods to send progress
      scraperInstance.onProgress = async (message, progressData = {}) => {
        if (!isScraperRunning) return;

        // Log to file
        await writeLogEntry(message);

        // Create progress information
        let progressInfo = {
          message,
          timestamp: new Date().toISOString()
        };

        // Add progress percentage and stats information
        if (progressData.overallProgress) {
          const { statesProcessed, totalStates, processed, total } = progressData.overallProgress;

          // Calculate percentage based on states and events
          let stateWeight = 0.7; // 70% of progress based on states
          let eventWeight = 0.3; // 30% based on events processed

          let statePercentage = totalStates > 0 ? (statesProcessed / totalStates) * 100 : 0;
          let eventPercentage = total > 0 ? (processed / total) * 100 : 0;

          // Combined weighted percentage
          let percentage = (statePercentage * stateWeight) + (eventPercentage * eventWeight);

          // Format for display (0-100%)
          progressInfo.percentage = Math.min(100, Math.max(0, Math.round(percentage)));
          progressInfo.progressDetail = `States: ${statesProcessed}/${totalStates}, Events: ${processed}/${total || '?'}`;

          // Add explicit stats information
          progressInfo.stats = {
            statesProcessed,
            totalStates,
            eventsProcessed: processed,
            totalEvents: total,
            currentState: scraperInstance.currentState
          };
        }

        // If there's state completion info, include it
        if (progressData.stateCompleted) {
          const { state, stateIndex, totalStates, eventsScraped } = progressData.stateCompleted;
          if (!progressInfo.stats) progressInfo.stats = {};
          progressInfo.stats.currentStateName = state;
          progressInfo.stats.stateIndex = stateIndex;
          if (eventsScraped) progressInfo.stats.eventsScraped = eventsScraped;
        }

        // Send to UI with additional progress info
        mainWindow.webContents.send('scraping-progress', message, progressInfo);
      };

      // Start scraping 
      await scraperInstance.scrapeAllEvents(stateLinks, resumeFromState);

      // Mark as completed
      isScraperRunning = false;
      scrapedDataExists = true;

      // Log completion
      await writeLogEntry('Scraping completed successfully');

      // Send final progress update
      mainWindow.webContents.send('scraping-progress', 'Scraping completed', {
        message: 'Scraping completed',
        percentage: 100,
        progressDetail: 'All states and events processed'
      });

      return { success: true, message: 'Scraping completed successfully' };
    } catch (error) {
      // Log error and update state
      await writeLogEntry(`Scraping error: ${error.message}`);

      isScraperRunning = false;
      console.error('Scraping error:', error);

      // Send error progress update
      mainWindow.webContents.send('scraping-progress', `Error: ${error.message}`, {
        error: true,
        message: `Error: ${error.message}`
      });

      return {
        success: false,
        message: error.message || 'An error occurred during scraping'
      };
    }
  });

  ipcMain.handle('stop-scraping', async (event) => {
    if (!isScraperRunning) {
      return {
        success: false,
        message: 'No scraping is currently in progress'
      };
    }

    try {
      // Set scraper running flag to false
      isScraperRunning = false;
      global.isScraperRunning = false;


      // Log the stop operation
      await writeLogEntry('Scraping stopped by user');

      // Send stop message to UI
      mainWindow.webContents.send('scraping-progress', 'Scraping stopped by user', {
        message: 'Scraping stopped by user',
        stopped: true
      });

      // Force scraper to clean up if it exists
      if (scraperInstance) {
        // Add a message to the scraper's log
        if (typeof scraperInstance.writeLog === 'function') {
          await scraperInstance.writeLog('Scraper forcibly stopped by user');
        }

        // Clear the instance to allow garbage collection
        scraperInstance = null;
      }

      return {
        success: true,
        message: 'Scraping stopped successfully'
      };
    } catch (error) {
      console.error('Stop scraping error:', error);
      return {
        success: false,
        message: error.message || 'An error occurred while stopping scraping'
      };
    }
  });

  // IPC handler to reset scraper
  ipcMain.handle('reset-scraper', async (event) => {
    if (isScraperRunning) {
      return {
        success: false,
        message: 'Cannot reset while scraping is in progress'
      };
    }

    try {
      console.log('Starting complete scraper reset with multiple methods...');
      let successMessages = [];
      let errorMessages = [];

      // 1. Force scraper to clean up if it exists
      if (scraperInstance) {
        console.log('Clearing scraper instance');
        scraperInstance = null;
        successMessages.push('Scraper instance cleared');
      }

      // 2. Clear tracked event links
      trackedEventLinks.clear();
      successMessages.push('Tracked event links cleared');

      // 3. Update state flags
      scrapedDataExists = false;

      // 4. Try multiple different methods to delete the progress file
      const progressFilePath = PROGRESS_FILE_PATH;
      console.log(`Attempting to delete progress file at ${progressFilePath} using multiple methods`);

      let progressFileDeleted = false;

      // Method 1: fs-extra unlink
      try {
        if (await fs.pathExists(progressFilePath)) {
          await fs.unlink(progressFilePath);
          console.log('Progress file deleted with fs.unlink');
          progressFileDeleted = true;
          successMessages.push('Progress file deleted (unlink)');
        } else {
          console.log('Progress file does not exist');
          progressFileDeleted = true;
          successMessages.push('Progress file does not exist');
        }
      } catch (e) {
        console.error('Error unlinking progress file:', e);
        errorMessages.push(`Unlink failed: ${e.message}`);
      }

      // Method 2: fs-extra remove (if Method 1 failed)
      if (!progressFileDeleted) {
        try {
          if (await fs.pathExists(progressFilePath)) {
            await fs.remove(progressFilePath);
            console.log('Progress file deleted with fs.remove');
            progressFileDeleted = true;
            successMessages.push('Progress file deleted (remove)');
          }
        } catch (e) {
          console.error('Error removing progress file with fs.remove:', e);
          errorMessages.push(`Remove failed: ${e.message}`);
        }
      }

      // Method 3: native fs.unlinkSync (if Methods 1 & 2 failed)
      if (!progressFileDeleted) {
        try {
          const fs_native = require('fs');
          if (fs_native.existsSync(progressFilePath)) {
            fs_native.unlinkSync(progressFilePath);
            console.log('Progress file deleted with native fs.unlinkSync');
            progressFileDeleted = true;
            successMessages.push('Progress file deleted (native unlinkSync)');
          }
        } catch (e) {
          console.error('Error unlinking progress file with native fs:', e);
          errorMessages.push(`Native unlinkSync failed: ${e.message}`);
        }
      }

      // Method 4: Write empty object to the file (last resort)
      if (!progressFileDeleted && await fs.pathExists(progressFilePath)) {
        try {
          await fs.writeJson(progressFilePath, {});
          console.log('Progress file content cleared (could not delete)');
          successMessages.push('Progress file cleared but not deleted');
        } catch (e) {
          console.error('Error writing to progress file:', e);
          errorMessages.push(`Writing empty json failed: ${e.message}`);
        }
      }

      // 5. Delete the CSV file
      try {
        if (await fs.pathExists(CSV_FILE_PATH)) {
          await fs.remove(CSV_FILE_PATH);
          successMessages.push('CSV file removed');
        } else {
          successMessages.push('No CSV file found to remove');
        }
      } catch (e) {
        console.error('Error removing CSV file:', e);
        errorMessages.push(`Failed to remove CSV file: ${e.message}`);

        // Try native fs as backup
        try {
          const fs_native = require('fs');
          if (fs_native.existsSync(CSV_FILE_PATH)) {
            fs_native.unlinkSync(CSV_FILE_PATH);
            successMessages.push('CSV file removed with native fs');
          }
        } catch (e2) {
          errorMessages.push(`Native fs also failed to remove CSV: ${e2.message}`);
        }
      }

      // 6. Clear log file but keep the file
      try {
        // Ensure logs directory exists
        await fs.ensureDir(LOGS_DIR);

        // Clear the log file
        await fs.writeFile(LOG_FILE_PATH, '');
        successMessages.push('Log file cleared');
      } catch (e) {
        console.error('Error clearing log file:', e);
        errorMessages.push(`Failed to clear log file: ${e.message}`);
      }

      // 7. Final check if files still exist
      const progressStillExists = await fs.pathExists(progressFilePath);
      const csvStillExists = await fs.pathExists(CSV_FILE_PATH);

      if (progressStillExists) {
        console.warn('WARNING: Progress file STILL exists after all deletion attempts!');
        errorMessages.push('Progress file could not be deleted by any method');
      }

      if (csvStillExists) {
        console.warn('WARNING: CSV file STILL exists after all deletion attempts!');
        errorMessages.push('CSV file could not be deleted by any method');
      }

      // 8. Write reset operation outcome to logs
      await writeLogEntry('Scraper has been reset');
      await writeLogEntry(`Reset operation results: ${successMessages.join(', ')}`);
      if (errorMessages.length > 0) {
        await writeLogEntry(`Reset errors: ${errorMessages.join(', ')}`);
      }

      console.log('Reset completed with results:', { successMessages, errorMessages });
      console.log('Progress file still exists:', progressStillExists);
      console.log('CSV file still exists:', csvStillExists);

      return {
        success: true,
        message: progressStillExists ?
          'Scraper reset completed but some files could not be deleted' :
          'Scraper reset successfully',
        details: {
          success: successMessages,
          errors: errorMessages,
          filesRemaining: {
            progress: progressStillExists,
            csv: csvStillExists
          }
        }
      };
    } catch (error) {
      console.error('Reset error:', error);
      return {
        success: false,
        message: error.message || 'An error occurred while resetting'
      };
    }
  });

  // IPC handler to save CSV file to user-selected location
  ipcMain.handle('save-csv-file', async () => {
    try {
      if (!scrapedDataExists) {
        return {
          success: false,
          message: 'No data available to save'
        };
      }

      // Open save dialog
      const { canceled, filePath } = await dialog.showSaveDialog({
        title: 'Save Car Events Data',
        defaultPath: path.join(app.getPath('downloads'), 'car_events_details.csv'),
        filters: [
          { name: 'CSV Files', extensions: ['csv'] }
        ]
      });

      if (canceled) {
        return {
          success: false,
          message: 'Save operation canceled'
        };
      }

      // Copy CSV file from app data to selected location
      await fs.copyFile(CSV_FILE_PATH, filePath);
      await writeLogEntry(`CSV file exported to ${filePath}`);

      return {
        success: true,
        message: 'File saved successfully',
        path: filePath
      };
    } catch (error) {
      console.error('Error saving CSV file:', error);
      return {
        success: false,
        message: error.message || 'An error occurred while saving the file'
      };
    }
  });

  // Add this for writing logs (used in preload.js)
  ipcMain.handle('write-logs', async (event, logs) => {
    try {
      if (!Array.isArray(logs) || logs.length === 0) {
        return { success: false, message: 'No logs to write' };
      }

      // Ensure log file exists
      await fs.ensureFile(LOG_FILE_PATH);

      // Format and write logs
      const formattedLogs = logs.map(log =>
        `${new Date().toISOString()} - ${log.message}\n`
      ).join('');

      await fs.appendFile(LOG_FILE_PATH, formattedLogs);
      return { success: true };
    } catch (error) {
      console.error('Error writing logs:', error);
      return {
        success: false,
        message: error.message || 'An error occurred while writing logs'
      };
    }
  });
}

// Initialize app when ready
app.whenReady().then(async () => {
  console.log('App is ready, initializing...');

  try {
    // Ensure directories exist
    await fs.ensureDir(APP_DATA_DIR);
    await fs.ensureDir(CSV_OUTPUT_DIR);
    await fs.ensureDir(LOGS_DIR);
    await fs.ensureFile(LOG_FILE_PATH);

    // Check if CSV file exists
    const csvExists = await fs.pathExists(CSV_FILE_PATH);
    if (csvExists) {
      const stats = await fs.stat(CSV_FILE_PATH);
      scrapedDataExists = stats.size > 0;
    }

    // Load previous progress
    const progressExists = await fs.pathExists(PROGRESS_FILE_PATH);
    if (progressExists) {
      const progressData = await fs.readJSON(PROGRESS_FILE_PATH);
      if (progressData.trackedEventLinks && Array.isArray(progressData.trackedEventLinks)) {
        trackedEventLinks = new Set(progressData.trackedEventLinks);
      }
    }

    // Create the window
    createWindow();

    // Set up IPC handlers
    setupIpcHandlers();

    console.log('Initialization complete');
  } catch (error) {
    console.error('Error during initialization:', error);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// Export module
module.exports = {
  getIsScraperRunning: () => isScraperRunning
};