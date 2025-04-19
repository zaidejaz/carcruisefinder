const fs = require('fs').promises;
const path = require('path');
const { ComprehensiveCarEventScraper } = require('./scraper');

// Helper to show proper command line usage
function showUsage() {
  console.log(`
Car Cruise Finder Console Scraper
--------------------------------

Usage: node console-scraper.js [options] [state1] [state2] ...

Options:
  --resume               Resume from previous run's state
  --resume-state <num>   Resume from a specific state number
  --max-concurrency <num> Set maximum concurrent event scrapes (default: 3)
  --stats                Show scraper statistics and exit
  --list-states          List all available states and exit
  --help                 Show this help message

Examples:
  node console-scraper.js                    # Scrape all states from the beginning
  node console-scraper.js --resume           # Resume from last saved position
  node console-scraper.js california texas   # Only scrape California and Texas
  node console-scraper.js --stats            # Display statistics about previous runs
`);
}

// Function to parse command line arguments
function parseArguments() {
  const args = process.argv.slice(2);
  const options = {
    resume: false,
    resumeState: 0,
    maxConcurrency: 3,
    showStats: false,
    listStates: false,
    states: []
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i].toLowerCase();
    
    if (arg === '--resume') {
      options.resume = true;
    } else if (arg === '--resume-state' && i + 1 < args.length) {
      options.resumeState = parseInt(args[++i], 10);
      if (isNaN(options.resumeState)) {
        console.error('Invalid state number for --resume-state');
        process.exit(1);
      }
    } else if (arg === '--max-concurrency' && i + 1 < args.length) {
      options.maxConcurrency = parseInt(args[++i], 10);
      if (isNaN(options.maxConcurrency) || options.maxConcurrency < 1) {
        console.error('Invalid value for --max-concurrency, using default of 3');
        options.maxConcurrency = 3;
      }
    } else if (arg === '--stats') {
      options.showStats = true;
    } else if (arg === '--list-states') {
      options.listStates = true;
    } else if (arg === '--help') {
      showUsage();
      process.exit(0);
    } else if (!arg.startsWith('--')) {
      options.states.push(arg);
    }
  }

  return options;
}

// Function to ensure logs directory exists
async function ensureLogDirectory() {
  const logsDir = path.join(__dirname, 'logs');
  try {
    await fs.access(logsDir);
  } catch (error) {
    // Directory doesn't exist, create it
    await fs.mkdir(logsDir, { recursive: true });
    console.log(`Created logs directory at: ${logsDir}`);
  }
}

// Function to load state links from JSON file
async function loadStateLinks() {
  try {
    const stateLinksPath = path.join(__dirname, 'state-car-show-links.json');
    const data = await fs.readFile(stateLinksPath, 'utf8');
    const { stateCarShowLinks } = JSON.parse(data);
    
    // Create a temporary scraper just to use its getStateFromUrl method
    const tempScraper = new ComprehensiveCarEventScraper();
    
    // Convert to format expected by scraper
    return stateCarShowLinks.map(link => {
      // Use the scraper's method to extract state name consistently
      const stateName = tempScraper.getStateFromUrl(link);
      
      return {
        link,
        name: stateName
      };
    });
  } catch (error) {
    console.error('Error loading state links:', error);
    throw error;
  }
}

// Function to display scraper statistics
async function showScraperStats() {
  const progressPath = path.join(__dirname, 'console_scraper_progress.json');
  
  try {
    await fs.access(progressPath);
    const data = await fs.readFile(progressPath, 'utf8');
    const progressData = JSON.parse(data);
    
    console.log('\n=== Car Cruise Finder Scraper Statistics ===\n');
    console.log(`Last Run: ${progressData.timestamp || 'Unknown'}`);
    console.log(`Total Events Found: ${progressData.totalEventsFound || 0}`);
    console.log(`Events Processed: ${progressData.processedEvents || 0}`);
    console.log(`States Completed: ${progressData.completedStates?.length || 0} of ${progressData.totalStates || 0}`);
    
    // Show progress for each state
    if (progressData.stateProgress) {
      console.log('\n--- State Progress ---');
      
      Object.entries(progressData.stateProgress).forEach(([stateId, progress]) => {
        const isCompleted = progressData.completedStates?.includes(stateId);
        console.log(`${stateId}: ${isCompleted ? 'COMPLETED' : 'IN PROGRESS'}`);
        console.log(`  Pages Processed: ${progress.lastPage || 0}`);
        console.log(`  Events Found: ${progress.eventsFound || 0}`);
        console.log(`  Last Updated: ${progress.lastProcessed || 'Unknown'}`);
        console.log('');
      });
    }
    
    console.log('=== End of Statistics ===\n');
  } catch (error) {
    console.error('No previous scraper progress found or error reading statistics.');
  }
}

// Main function
async function main() {
  try {
    // Parse command line options
    const options = parseArguments();
    
    // Ensure logs directory exists
    await ensureLogDirectory();
    
    // Show statistics if requested
    if (options.showStats) {
      await showScraperStats();
      return;
    }
    
    // Load all state links
    const allStateLinks = await loadStateLinks();
    console.log(`Loaded ${allStateLinks.length} states`);
    
    // List states if requested
    if (options.listStates) {
      console.log('\nAvailable States:');
      allStateLinks.forEach((state, index) => {
        console.log(`${index + 1}. ${state.name}`);
      });
      return;
    }
    
    // Filter state links if specific states were provided
    let stateLinksToProcess = allStateLinks;
    if (options.states.length > 0) {
      const stateNamesToProcess = options.states.map(s => s.toLowerCase());
      stateLinksToProcess = allStateLinks.filter(stateObj => 
        stateNamesToProcess.some(arg => stateObj.name.toLowerCase().includes(arg))
      );
      console.log(`Filtered to ${stateLinksToProcess.length} states: ${stateLinksToProcess.map(s => s.name).join(', ')}`);
    }
    
    if (stateLinksToProcess.length === 0) {
      console.error('No matching states found! Use --list-states to see available states.');
      process.exit(1);
    }
    
    // Initialize the scraper
    const scraper = new ComprehensiveCarEventScraper({
      csvPath: path.join(__dirname, 'car_events_console.csv'),
      logsPath: path.join(__dirname, 'logs', 'console_scraper.log'),
      progressPath: path.join(__dirname, 'console_scraper_progress.json'),
      maxConcurrency: options.maxConcurrency
    });
    
    // Add enhanced console logging for better visibility
    scraper.onProgress = (message, progressData) => {
      // Call original logging method
      scraper.writeLog(message);
      
      // Enhanced console output with timestamp
      const timestamp = new Date().toISOString();
      
      // Format based on type of progress
      if (progressData?.error) {
        console.error(`[${timestamp}] ❌ ERROR: ${message}`);
      } else if (progressData?.stateCompleted) {
        const { state, eventsScraped, stateIndex, totalStates, markedComplete } = progressData.stateCompleted;
        console.log(`[${timestamp}] ✅ COMPLETED STATE: ${state} (${stateIndex+1}/${totalStates}) - Scraped ${eventsScraped} events ${markedComplete ? '(Marked as complete)' : ''}`);
      } else if (progressData?.stateSkipped) {
        const { state } = progressData.stateSkipped;
        console.log(`[${timestamp}] ⏭️ SKIPPED STATE: ${state} - Already completed`);
      } else if (progressData?.stateResumed) {
        const { state, page } = progressData.stateResumed;
        console.log(`[${timestamp}] 🔄 RESUMING STATE: ${state} from page ${page}`);
      } else if (progressData?.stateProgress) {
        const { state, currentPage, eventsFound } = progressData.stateProgress;
        console.log(`[${timestamp}] 🔍 SCRAPING: ${state} - Page ${currentPage} (Events found so far: ${eventsFound})`);
      } else if (progressData?.overallProgress) {
        const { processed, total, statesProcessed, totalStates } = progressData.overallProgress;
        console.log(`[${timestamp}] 📊 PROGRESS: ${processed}/${total || '?'} events, ${statesProcessed}/${totalStates} states`);
      } else if (progressData?.eventDetails) {
        const { name, state, date } = progressData.eventDetails;
        console.log(`[${timestamp}] 📝 EVENT: "${name}" in ${state} on ${date}`);
      } else if (progressData?.scraperSummary) {
        const { totalStates, completedStates, remainingStates, eventsAlreadyFound } = progressData.scraperSummary;
        console.log(`[${timestamp}] 🚀 STARTING: ${completedStates}/${totalStates} states completed, ${remainingStates} remaining, ${eventsAlreadyFound} events found so far`);
      } else if (progressData?.scrapingComplete) {
        const { totalEvents, totalStates } = progressData.scrapingComplete;
        console.log(`[${timestamp}] 🎉 COMPLETE: Scraped ${totalEvents} events across ${totalStates} states`);
      } else {
        console.log(`[${timestamp}] ℹ️ INFO: ${message}`);
      }
    };
    
    // Handle cleanup on process termination
    process.on('SIGINT', async () => {
      console.log('\nReceived SIGINT (Ctrl+C). Cleaning up...');
      scraper.stop();  // First stop the scraper
      console.log('Waiting for current operations to complete...');
      
      // Give the scraper a moment to finish current operations
      setTimeout(async () => {
        await scraper.cleanup();
        console.log('Cleanup complete. Exiting.');
        process.exit(0);
      }, 2000);
    });
    
    // Also handle other termination signals
    process.on('SIGTERM', async () => {
      console.log('\nReceived SIGTERM. Cleaning up...');
      scraper.stop();
      await scraper.cleanup();
      process.exit(0);
    });
    
    // Set global variable for stopping
    global.isScraperRunning = true;
    
    console.log('Starting scraper...');
    
    // Determine where to start from
    let resumeFromState = options.resumeState;
    if (options.resume) {
      resumeFromState = true; // Use true to indicate we want to use the stored state
    }
    
    // Start or resume scraping
    await scraper.scrapeAllEvents(stateLinksToProcess, resumeFromState);
    
    console.log('Scraping complete!');
    await scraper.cleanup();
    
  } catch (error) {
    console.error('An error occurred during scraping:', error);
    process.exit(1);
  }
}

// Run the main function
main().catch(error => {
  console.error('Unhandled error in main function:', error);
  process.exit(1);
}); 