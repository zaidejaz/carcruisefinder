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
        { id: 'time', title: 'Time' },
        { id: 'description', title: 'Description' },
        { id: 'originalLink', title: 'Original Link' }
      ],
      append: true
    });
  }

  // Scrape a single state worker with retries
  async scrapeStateWorker(stateLink, stateName) {
    const fullUrl = stateLink.startsWith('http')
      ? stateLink
      : `${this.baseUrl}${stateLink}`;

    let currentPage = 1;
    let hasMorePages = true;
    const scrapedEventLinks = [];
    const maxRetries = 3;

    while (hasMorePages) {
      let retries = 0;
      let success = false;

      while (retries < maxRetries && !success) {
        try {
          // Construct paginated URL
          const pageUrl = currentPage > 1
            ? `${fullUrl}/page/${currentPage}/`
            : fullUrl;

          this.onProgress(`Scraping page ${currentPage} for ${stateName}`, {
            stateProgress: {
              state: stateName,
              currentPage,
              eventsFound: scrapedEventLinks.length
            }
          });

          // Add exponential backoff for retries
          if (retries > 0) {
            const delay = Math.pow(2, retries) * 1000;
            await new Promise(resolve => setTimeout(resolve, delay));
            this.onProgress(`Retry ${retries}/${maxRetries} for page ${currentPage} of ${stateName}`, {
              stateProgress: {
                state: stateName,
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
            timeout: 20000 // 20 seconds timeout
          });

          const $ = cheerio.load(response.data);

          const eventLinks = $('h2.tribe-events-list-event-title.entry-title.summary a.url')
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
            const eventScrapingPromises = chunk.map(async (eventLink) => {
              return await this.scrapeEventDetails(eventLink, stateName);
            });

            // Wait for chunk to complete
            const results = await Promise.allSettled(eventScrapingPromises);

            // Count successful scrapes
            const successfulScrapes = results.filter(r => r.status === 'fulfilled' && r.value !== null).length;
            this.processedEvents += successfulScrapes;

            // Update progress
            this.onProgress(`Processed ${this.processedEvents}/${this.totalEventsFound} events (${stateName})`, {
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

          // Increment page
          currentPage++;
          success = true;

          // Small delay between pages to be respectful to the server
          await new Promise(resolve => setTimeout(resolve, 1000));

        } catch (error) {
          retries++;
          this.onProgress(`Error scraping page ${currentPage} for ${stateName}: ${error.message}. Retry ${retries}/${maxRetries}`, {
            error: true,
            errorDetails: {
              message: error.message,
              state: stateName,
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

    return scrapedEventLinks;
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
        const eventName = $('h1.entry-title').text().trim();

        // Extract venue and location from meta_data
        const venueElement = $('.meta_data .date_value .tribe-events-venue-details-on-single');
        const venue = venueElement.find('.tribe-get_venue').text().trim();

        const addressElement = venueElement.find('.tribe-events-address .tribe-address');
        const streetAddress = addressElement.find('.tribe-street-address').text().trim();
        const city = addressElement.find('.tribe-locality').text().trim();
        const stateAbbr = addressElement.find('.tribe-region').attr('title') ||
          addressElement.find('.tribe-region').text().trim();
        const country = addressElement.find('.tribe-country-name').text().trim();

        // Extract date specifically from the div with calendar icon
        const dateElement = $('.meta_data .title_with_icoone i.fa-calendar')
          .closest('.main_meta_data')
          .find('.date_value .tribe-events-abbr');
        const date = dateElement.attr('title');

        // Extract time
        const timeElement = $('.meta_data .title_with_icoone i.fa-clock')
          .closest('.main_meta_data')
          .find('.time_value .tribe-events-abbr');
        const time = timeElement.text().trim();

        // Extract full description
        const description = $('.content_description.fulldescriptio')
          .clone()
          .find('a.seeless')
          .remove()
          .end()
          .text()
          .replace(/\n+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();

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
          time,
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
      // Ensure CSV header exists
      await this.initCsvWriter();

      // Try to load progress if resuming
      if (resumeFromState > 0) {
        await this.loadProgress();
      }

      // Total states for progress tracking
      this.totalStates = stateLinks.length;
      this.currentState = resumeFromState;

      for (let i = resumeFromState; i < stateLinks.length; i++) {
        // Check if scraping was stopped (from global variable)
        if (global.isScraperRunning === false) {
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

        try {
          this.onProgress(`Starting scraping for state: ${name} (${i + 1}/${stateLinks.length})`, {
            overallProgress: {
              statesProcessed: i,
              totalStates: stateLinks.length,
              processed: this.processedEvents,
              total: this.totalEventsFound
            }
          });

          // Scrape event links and details for this state
          const scrapedEventLinks = await this.scrapeStateWorker(link, name);

          this.onProgress(`Completed scraping for state: ${name}. Scraped ${scrapedEventLinks.length} events.`, {
            stateCompleted: {
              state: name,
              eventsScraped: scrapedEventLinks.length,
              stateIndex: i,
              totalStates: stateLinks.length
            }
          });

          // Save progress after each state
          await this.saveProgress();

        } catch (error) {
          this.onProgress(`Error processing state ${name}: ${error.message}`, {
            error: true,
            errorDetails: {
              message: error.message,
              state: name,
              stateIndex: i
            }
          });
        }
      }
    } catch (error) {
      console.error('Error in scrapeAllEvents:', error);
      throw error;
    }
  }
}

module.exports = { ComprehensiveCarEventScraper };