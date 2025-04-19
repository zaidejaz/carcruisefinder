const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs').promises;
const path = require('path');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const createCsvStringifier = require('csv-writer').createObjectCsvStringifier;


class ComprehensiveCarEventScraper {
  constructor(options = {}) {
    this.baseUrl = 'https://carcruisefinder.com';
    this.maxConcurrency = options.maxConcurrency || 5;
    this.csvPath = options.csvPath || path.join(__dirname, 'car_events_details.csv');
    this.logsPath = options.logsPath || path.join(__dirname, 'logs', 'scraper.log');
    this.progressPath = options.progressPath || path.join(__dirname, 'scraper_progress.json');
    this.trackedEventLinks = options.trackedEventLinks || new Set();
    this.csvWriter = this.initCsvWriter();

    // Progress tracking
    this.currentState = 0;
    this.totalStates = 0;
    this.processedEvents = 0;
    this.totalEventsFound = 0;
    
    // Enhanced progress tracking
    this.stateProgress = options.stateProgress || {}; // Track pages scraped per state
    this.completedStates = options.completedStates || new Set(); // Track fully completed states
    
    // Control flag for stopping scraper
    this.isRunning = true;

    // Default progress callback
    this.onProgress = (message, progressData) => {
      this.writeLog(message);
      console.log(message);
    };
  }

  // Write logs to file
  async writeLog(message) {
    try {
      await fs.appendFile(this.logsPath, `${new Date().toISOString()} - ${message}\n`);
    } catch (error) {
      console.error('Error writing log:', error);
    }
  }

  // Save progress data to file
  async saveProgress() {
    try {
      const progressData = {
        trackedEventLinks: Array.from(this.trackedEventLinks),
        currentState: this.currentState,
        totalStates: this.totalStates,
        processedEvents: this.processedEvents,
        totalEventsFound: this.totalEventsFound,
        stateProgress: this.stateProgress,
        completedStates: Array.from(this.completedStates),
        timestamp: new Date().toISOString()
      };

      await fs.writeFile(
        this.progressPath,
        JSON.stringify(progressData, null, 2)
      );
    } catch (error) {
      console.error('Error saving progress:', error);
    }
  }

  async cleanup() {
    try {
      // Save current progress
      await this.writeLog('Scraper is shutting down, saving progress...');
      await this.saveProgress();
      await this.writeLog('Progress saved successfully');

      // Any additional cleanup can be added here

      return true;
    } catch (error) {
      console.error('Error during scraper cleanup:', error);
      return false;
    }
  }

  // Load progress data from file
  async loadProgress() {
    try {
      const exists = await fs.access(this.progressPath)
        .then(() => true)
        .catch(() => false);

      if (!exists) return false;

      const data = await fs.readFile(this.progressPath, 'utf8');
      const progressData = JSON.parse(data);

      this.currentState = progressData.currentState || 0;
      this.totalStates = progressData.totalStates || 0;
      this.processedEvents = progressData.processedEvents || 0;
      this.totalEventsFound = progressData.totalEventsFound || 0;

      // Restore tracked links
      if (Array.isArray(progressData.trackedEventLinks)) {
        this.trackedEventLinks = new Set(progressData.trackedEventLinks);
      }
      
      // Restore enhanced progress tracking
      this.stateProgress = progressData.stateProgress || {};
      
      // Restore completed states
      if (Array.isArray(progressData.completedStates)) {
        this.completedStates = new Set(progressData.completedStates);
      }

      return true;
    } catch (error) {
      console.error('Error loading progress:', error);
      return false;
    }
  }

  // Initialize CSV writer
  initCsvWriter() {
    return createCsvWriter({
      path: this.csvPath,
      header: [
        { id: 'eventName', title: 'Event Name' },
        { id: 'state', title: 'State' },
        { id: 'venue', title: 'Venue' },
        { id: 'streetAddress', title: 'Street Address' },
        { id: 'city', title: 'City' },
        { id: 'stateAbbr', title: 'State Abbr' },
        { id: 'country', title: 'Country' },
        { id: 'date', title: 'Date' },
        { id: 'start-time', title: 'Start Time' },
        { id: 'end-time', title: 'End Time' },
        { id: 'description', title: 'Description' },
        { id: 'originalLink', title: 'Original Link' }
      ],
      append: true
    });
  }

  // Method to stop the scraper
  stop() {
    this.isRunning = false;
    this.onProgress('Scraper stop requested. Will stop after current task completes.', {
      stopped: true,
      message: 'Stop requested by user'
    });
  }

  // Scrape a single state worker with retries
  async scrapeStateWorker(stateLink, stateName) {
    // Check if scraper has been stopped
    if (!this.isRunning) {
      this.onProgress(`Scraping of state ${stateName} aborted due to stop request`, {
        stateAborted: {
          state: stateName
        }
      });
      return [];
    }
    
    // Create a state identifier that's unique and safe for storing in JSON
    const stateId = stateName.toLowerCase().replace(/\s+/g, '_');
    
    // Handle if the URL has changed but we're trying to scrape the same state
    // This maps the old URL format to the new one if needed
    const fullUrl = stateLink.startsWith('http')
      ? stateLink
      : `${this.baseUrl}${stateLink}`;
      
    // Check if we've already completed this state
    if (this.completedStates.has(stateId)) {
      this.onProgress(`State ${stateName} already fully scraped. Skipping.`, {
        stateSkipped: {
          state: stateName,
          reason: 'already_completed'
        }
      });
      return [];
    }
    
    // Get the last processed page for this state, or start from 1
    let currentPage = 1;
    if (this.stateProgress[stateId] && this.stateProgress[stateId].lastPage) {
      currentPage = this.stateProgress[stateId].lastPage + 1;
      this.onProgress(`Resuming state ${stateName} from page ${currentPage}`, {
        stateResumed: {
          state: stateName,
          page: currentPage
        }
      });
    }
    
    let hasMorePages = true;
    const scrapedEventLinks = [];
    const maxRetries = 3;

    // For easier identification in logs
    const stateDisplayName = stateName || this.getStateFromUrl(stateLink) || 'Unknown State';

    while (hasMorePages) {
      // Check if scraper has been stopped
      if (!this.isRunning) {
        this.onProgress(`Scraping of state ${stateDisplayName} aborted due to stop request`, {
          stateAborted: {
            state: stateDisplayName
          }
        });
        return scrapedEventLinks;
      }
      
      let retries = 0;
      let success = false;

      while (retries < maxRetries && !success) {
        try {
          // Construct paginated URL
          const pageUrl = currentPage > 1
            ? `${fullUrl}/page/${currentPage}/`
            : fullUrl;

          this.onProgress(`Scraping page ${currentPage} for ${stateDisplayName}`, {
            stateProgress: {
              state: stateDisplayName,
              currentPage,
              eventsFound: scrapedEventLinks.length
            }
          });

          // Add exponential backoff for retries
          if (retries > 0) {
            const delay = Math.pow(2, retries) * 1000;
            await new Promise(resolve => setTimeout(resolve, delay));
            this.onProgress(`Retry ${retries}/${maxRetries} for page ${currentPage} of ${stateDisplayName}`, {
              stateProgress: {
                state: stateDisplayName,
                currentPage,
                eventsFound: scrapedEventLinks.length,
                retrying: true,
                retryCount: retries
              }
            });
          }

          // Scrape with Axios
          const response = await axios.get(pageUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            },
            timeout: 60000  // 60 seconds timeout
          });

          const $ = cheerio.load(response.data);

          const eventLinks = $('h3.tribe-events-calendar-list__event-title a.tribe-events-calendar-list__event-title-link')
            .map((i, el) => $(el).attr('href'))
            .get()
            .filter(link => !this.trackedEventLinks.has(link));

          // If no events found, stop pagination
          if (eventLinks.length === 0) {
            hasMorePages = false;
            break;
          }

          // Scrape each event details concurrently with limited concurrency
          const chunks = [];
          for (let i = 0; i < eventLinks.length; i += this.maxConcurrency) {
            const chunk = eventLinks.slice(i, i + this.maxConcurrency);
            chunks.push(chunk);
          }

          for (const chunk of chunks) {
            // Check if scraper has been stopped
            if (!this.isRunning) {
              this.onProgress(`Scraping of events for ${stateDisplayName} aborted due to stop request`, {
                eventsAborted: {
                  state: stateDisplayName
                }
              });
              return scrapedEventLinks;
            }
            
            const eventScrapingPromises = chunk.map(async (eventLink) => {
              return await this.scrapeEventDetails(eventLink, stateDisplayName);
            });

            // Wait for chunk to complete
            const results = await Promise.allSettled(eventScrapingPromises);

            // Count successful scrapes
            const successfulScrapes = results.filter(r => r.status === 'fulfilled' && r.value !== null).length;
            this.processedEvents += successfulScrapes;

            // Update progress
            this.onProgress(`Processed ${this.processedEvents}/${this.totalEventsFound} events (${stateDisplayName})`, {
              overallProgress: {
                processed: this.processedEvents,
                total: this.totalEventsFound,
                statesProcessed: this.currentState,
                totalStates: this.totalStates
              }
            });

            // Save progress periodically
            await this.saveProgress();
          }

          // Add event links to tracked links
          scrapedEventLinks.push(...eventLinks);
          this.totalEventsFound += eventLinks.length;

          // Update the state progress with the last successfully processed page
          this.stateProgress[stateId] = {
            ...this.stateProgress[stateId],
            lastPage: currentPage,
            totalPages: currentPage, // We continuously update this as we progress
            lastProcessed: new Date().toISOString(),
            eventsFound: (this.stateProgress[stateId]?.eventsFound || 0) + eventLinks.length
          };
          
          // Save progress after each successful page
          await this.saveProgress();

          // Increment page
          currentPage++;
          success = true;

          // Small delay between pages to be respectful to the server
          await new Promise(resolve => setTimeout(resolve, 1000));

        } catch (error) {
          retries++;
          this.onProgress(`Error scraping page ${currentPage} for ${stateDisplayName}: ${error.message}. Retry ${retries}/${maxRetries}`, {
            error: true,
            errorDetails: {
              message: error.message,
              state: stateDisplayName,
              page: currentPage,
              retryCount: retries
            }
          });

          // If 404 or no more pages, stop
          if (error.response && error.response.status === 404) {
            hasMorePages = false;
            break;
          }

          // If we've maxed out retries, stop scraping this page
          if (retries >= maxRetries) {
            break;
          }
        }
      }

      // If we couldn't scrape this page after all retries, stop scraping this state
      if (!success && retries >= maxRetries) {
        break;
      }
    }

    // Mark this state as completed
    this.completedStates.add(stateId);
    this.onProgress(`State ${stateDisplayName} fully scraped and marked as completed`, {
      stateCompleted: {
        state: stateDisplayName,
        pagesProcessed: currentPage - 1,
        eventsFound: scrapedEventLinks.length,
        markedComplete: true
      }
    });
    
    // Save progress after state completion
    await this.saveProgress();

    return scrapedEventLinks;
  }

  // Helper method to extract state name from URL
  getStateFromUrl(url) {
    try {
      if (!url) return 'Unknown State';

      // For absolute URLs, convert to URL object and work with the path
      let urlPath = url;
      
      if (url.startsWith('http')) {
        try {
          const urlObj = new URL(url);
          urlPath = urlObj.pathname;
        } catch (e) {
          console.error('Invalid URL:', url);
        }
      }
      
      // Handle new URL format: /car-shows/category/iowa/
      const newFormatRegex = /\/car-shows\/category\/([a-z-]+)\/?/i;
      const newFormatMatch = urlPath.match(newFormatRegex);
      
      if (newFormatMatch && newFormatMatch[1]) {
        const stateName = newFormatMatch[1].toLowerCase();
        return stateName.charAt(0).toUpperCase() + stateName.slice(1);
      }
      
      // Handle old URL format: /alabama-car-events/events/category/alabama-car-shows/
      const oldFormatRegex = /\/([a-z-]+)-car-events\//i;
      const oldFormatMatch = urlPath.match(oldFormatRegex);
      
      if (oldFormatMatch && oldFormatMatch[1]) {
        const stateName = oldFormatMatch[1].split('-')[0].toLowerCase();
        return stateName.charAt(0).toUpperCase() + stateName.slice(1);
      }
      
      // If all else fails, try to extract state name from any part of the URL
      const anyStateRegex = /\/([a-z-]+)(?:\/|$)/i;
      const pathParts = urlPath.split('/').filter(p => p && !['events', 'category', 'car-shows'].includes(p.toLowerCase()));
      
      if (pathParts.length > 0) {
        const possibleState = pathParts[0].split('-')[0].toLowerCase();
        return possibleState.charAt(0).toUpperCase() + possibleState.slice(1);
      }
      
      console.warn('Could not extract state name from URL:', url);
      return 'Unknown State';
    } catch (error) {
      console.error('Error extracting state from URL:', error, url);
      return 'Unknown State';
    }
  }

  // Scrape details for a single event with retries
  async scrapeEventDetails(eventLink, stateName) {
    const maxRetries = 3;
    let retries = 0;

    while (retries < maxRetries) {
      try {
        // Check if event already scraped
        if (this.trackedEventLinks.has(eventLink)) {
          return null;
        }

        // Add exponential backoff for retries
        if (retries > 0) {
          const delay = Math.pow(2, retries) * 1000;
          await new Promise(resolve => setTimeout(resolve, delay));
        }

        const response = await axios.get(eventLink, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
          },
          timeout: 15000 // 15 seconds timeout
        });

        const $ = cheerio.load(response.data);

        // Extract event name
        const eventName = $('span.evnt_title h1.tribe-events-single-event-title').text().trim();

        // Extract venue and location from meta_data
        const venue = $('dd.tribe-venue').text().trim();

        // Extract address components
        const addressElement = $('dd.tribe-venue-location address.tribe-events-address span.tribe-address');
        const streetAddress = addressElement.find('.tribe-street-address').text().trim();
        const city = addressElement.find('.tribe-locality').text().trim();
        const stateAbbr = addressElement.find('.tribe-region').attr('title') ||
          addressElement.find('.tribe-region').text().trim();
        const country = addressElement.find('.tribe-country-name').text().trim();

        // Extract date
        const dateElement = $('abbr.tribe-events-abbr.tribe-events-start-date');
        const date = dateElement.attr('title') || dateElement.text().trim();

        // Extract time
        // Check if we have a time range with the recursive event time class
        const timeRangeElement = $('div.tribe-events-abbr.tribe-events-start-time .tribe-recurring-event-time');
        // Check for single time format
        const singleTimeElement = $('div.tribe-events-abbr.tribe-events-start-time.published.dtstart');

        // Variables for storing processed time
        let startTime = '';
        let endTime = '';

        // Check for time range first
        if (timeRangeElement && timeRangeElement.length > 0) {
          const timeText = timeRangeElement.text().trim();
          // Split by hyphen to get start and end times
          const splitTime = timeText.split('-');
          if (splitTime.length >= 2) {
            startTime = splitTime[0].trim();
            endTime = splitTime[1].trim();
          } else {
            // If somehow there's no hyphen but we're in this element
            startTime = timeText;
          }
        }
        // Check for single time format
        else if (singleTimeElement && singleTimeElement.length > 0) {
          startTime = singleTimeElement.text().trim();
          endTime = ''; // No end time
        }

        // Extract description - find content between "action-buttons" and "custom-event-message" divs
        let description = '';

        // Try to find the starting and ending elements
        const actionButtonsDiv = $('.action-buttons');
        const customEventMessageDiv = $('.custom-event-message');

        if (actionButtonsDiv.length > 0) {
          // Start gathering content after the action-buttons div
          let currentElement = actionButtonsDiv[0].nextSibling;
          const descriptionParts = [];

          // Continue until we reach the custom-event-message div or run out of elements
          while (currentElement &&
            !($(currentElement).hasClass && $(currentElement).hasClass('custom-event-message'))) {

            // If this is an element node, get its text content
            if (currentElement.type === 'tag') {
              const text = $(currentElement).text().trim();
              if (text) {
                descriptionParts.push(text);
              }
            }
            // If this is a text node, add its content
            else if (currentElement.type === 'text') {
              const text = $(currentElement).text().trim();
              if (text) {
                descriptionParts.push(text);
              }
            }

            // Move to the next sibling
            currentElement = currentElement.nextSibling;
          }

          // Combine all description parts and clean up
          description = descriptionParts.join(' ')
            .replace(/\n+/g, ' ')  // Replace newlines with spaces
            .replace(/\s+/g, ' ')  // Normalize spaces
            .trim();
        }

        // Prepare record
        const record = {
          eventName,
          state: stateName,
          venue,
          streetAddress,
          city,
          stateAbbr,
          country,
          date,
          'start-time': startTime,
          'end-time': endTime,
          description,
          originalLink: eventLink
        };

        // Mark as tracked to prevent duplicates
        this.trackedEventLinks.add(eventLink);

        // Write record immediately
        await this.csvWriter.writeRecords([record]);

        // Log successful scrape
        this.onProgress(`Scraped event: ${eventName} from ${stateName}`, {
          eventDetails: {
            name: eventName,
            state: stateName,
            date: date
          }
        });

        return record;
      } catch (error) {
        retries++;
        this.onProgress(`Error scraping event ${eventLink}: ${error.message}. Retry ${retries}/${maxRetries}`, {
          error: true,
          errorDetails: {
            message: error.message,
            link: eventLink,
            retryCount: retries
          }
        });

        // If we've maxed out retries, give up on this event
        if (retries >= maxRetries) {
          return null;
        }
      }
    }

    return null;
  }

  // Main scraping method with multi-threading
  async scrapeAllEvents(stateLinks, resumeFromState = 0) {
    try {
      // Set running state
      this.isRunning = true;
      
      // Ensure CSV header exists
      await this.initCsvWriter();

      // Try to load progress if resuming
      if (resumeFromState > 0 || resumeFromState === true) {
        await this.loadProgress();
        // If resumeFromState === true, use the stored currentState
        if (resumeFromState === true) {
          resumeFromState = this.currentState;
        }
      }

      // Total states for progress tracking
      this.totalStates = stateLinks.length;
      this.currentState = resumeFromState;

      // Log progress summary before starting
      const completedCount = this.completedStates.size;
      this.onProgress(`Starting scraper with ${completedCount} states already completed, processing ${stateLinks.length - completedCount} remaining states`, {
        scraperSummary: {
          totalStates: stateLinks.length,
          completedStates: completedCount,
          remainingStates: stateLinks.length - completedCount,
          eventsAlreadyFound: this.totalEventsFound
        }
      });

      for (let i = resumeFromState; i < stateLinks.length; i++) {
        // Check if scraping was stopped
        if (!this.isRunning || global.isScraperRunning === false) {
          this.onProgress('Scraping stopped by user request', {
            stopped: true,
            atState: i,
            totalStates: stateLinks.length
          });

          // Save progress before exiting
          await this.saveProgress();
          return;
        }

        this.currentState = i;
        const { link, name } = stateLinks[i];
        
        // Make sure we have a valid state name, even if the link format changed
        const stateName = name || this.getStateFromUrl(link) || `State ${i+1}`;
        const stateId = stateName.toLowerCase().replace(/\s+/g, '_');
        
        // Skip if state is already fully processed
        if (this.completedStates.has(stateId)) {
          this.onProgress(`Skipping completed state: ${stateName}`, {
            stateSkipped: {
              state: stateName,
              stateIndex: i,
              totalStates: stateLinks.length
            }
          });
          continue;
        }

        try {
          this.onProgress(`Starting scraping for state: ${stateName} (${i + 1}/${stateLinks.length})`, {
            overallProgress: {
              statesProcessed: i,
              totalStates: stateLinks.length,
              processed: this.processedEvents,
              total: this.totalEventsFound
            }
          });

          // Scrape event links and details for this state
          const scrapedEventLinks = await this.scrapeStateWorker(link, stateName);

          this.onProgress(`Completed scraping for state: ${stateName}. Scraped ${scrapedEventLinks.length} events.`, {
            stateCompleted: {
              state: stateName,
              eventsScraped: scrapedEventLinks.length,
              stateIndex: i,
              totalStates: stateLinks.length
            }
          });

          // Save progress after each state
          await this.saveProgress();

        } catch (error) {
          this.onProgress(`Error processing state ${stateName}: ${error.message}`, {
            error: true,
            errorDetails: {
              message: error.message,
              state: stateName,
              stateIndex: i
            }
          });
        }
      }
      
      this.onProgress(`Scraping completed for all states. Total events found: ${this.totalEventsFound}`, {
        scrapingComplete: {
          totalEvents: this.totalEventsFound,
          totalStates: stateLinks.length
        }
      });
      
    } catch (error) {
      console.error('Error in scrapeAllEvents:', error);
      throw error;
    } finally {
      // Make sure to save progress even if there was an error
      await this.saveProgress();
    }
  }
}

module.exports = { ComprehensiveCarEventScraper };