const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs').promises;
const path = require('path');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const { promisify } = require('util');
const semaphore = require('semaphore');

class ComprehensiveCarEventScraper {
  constructor(options = {}) {
    this.baseUrl = 'https://carcruisefinder.com';
    this.maxConcurrency = options.maxConcurrency || 10;
    this.csvPath = path.join(__dirname, 'car_events_details.csv');
    this.progressPath = path.join(__dirname, 'scraper_progress.json');
    this.csvWriter = this.initCsvWriter();
    
    // Progress tracking callback
    this.onProgress = (message) => {
      console.log(message);
    };
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

  // Ensure CSV header exists
  async ensureCSVHeader() {
    try {
      const stats = await fs.stat(this.csvPath);
      if (stats.size === 0) {
        await fs.writeFile(
          this.csvPath, 
          'Event Name,State,Venue,Street Address,City,State Abbr,Country,Date,Time,Description,Original Link\n',
          'utf8'
        );
      }
    } catch (error) {
      if (error.code === 'ENOENT') {
        await fs.writeFile(
          this.csvPath, 
          'Event Name,State,Venue,Street Address,City,State Abbr,Country,Date,Time,Description,Original Link\n',
          'utf8'
        );
      }
    }
  }

  // Load or initialize progress
  async loadProgress() {
    try {
      const progressExists = await fs.access(this.progressPath)
        .then(() => true)
        .catch(() => false);
      
      if (progressExists) {
        const progressData = await fs.readFile(this.progressPath, 'utf8');
        return JSON.parse(progressData);
      }
      
      return { completedStates: [], currentPage: {} };
    } catch (error) {
      return { completedStates: [], currentPage: {} };
    }
  }

  // Save progress
  async saveProgress(progress) {
    await fs.writeFile(
      this.progressPath, 
      JSON.stringify(progress, null, 2), 
      'utf8'
    );
  }

  // Scrape event links for a state
  async scrapeStateEventLinks(stateLink, stateName) {
    const fullUrl = stateLink.startsWith('http') 
      ? stateLink 
      : `${this.baseUrl}${stateLink}`;

    let currentPage = 1;
    let hasMorePages = true;
    const allEventLinks = [];

    while (hasMorePages) {
      try {
        // Construct paginated URL
        const pageUrl = currentPage > 1 
          ? `${fullUrl}/page/${currentPage}/`
          : fullUrl;

        this.onProgress(`Scraping ${pageUrl} for ${stateName}`);

        // Scrape with Axios
        const response = await axios.get(pageUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
          }
        });

        const $ = cheerio.load(response.data);

        const eventLinks = $('h2.tribe-events-list-event-title.entry-title.summary a.url')
          .map((i, el) => $(el).attr('href'))
          .get();

        // If no events found, stop pagination
        if (eventLinks.length === 0) {
          hasMorePages = false;
          break;
        }

        // Add event links
        allEventLinks.push(...eventLinks);

        // Increment page
        currentPage++;

        // Add a small delay to prevent rate limiting
        await new Promise(resolve => setTimeout(resolve, 200));

      } catch (error) {
        // Check for 404 or other pagination-ending errors
        if (error.response && error.response.status === 404) {
          hasMorePages = false;
        } else {
          this.onProgress(`Error scraping ${fullUrl} page ${currentPage} for ${stateName}: ${error.message}`);
          break;
        }
      }
    }

    return allEventLinks;
  }

  // Scrape details for a single event
  async scrapeEventDetails(eventLink, stateName) {
    try {
      const response = await axios.get(eventLink, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
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
        .clone()    // Create a clone to avoid modifying the original DOM
        .find('a.seeless')  // Find and remove the "See less" link
        .remove()
        .end()     // Go back to the cloned element
        .text()
        .replace(/\n+/g, ' ')  // Replace multiple newlines with single space
        .replace(/\s+/g, ' ')  // Replace multiple spaces with single space
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

      // Write to CSV
      await this.csvWriter.writeRecords([record]);

      return record;

    } catch (error) {
      this.onProgress(`Error scraping event details from ${eventLink}: ${error.message}`);
      return null;
    }
  }

  // Main scraping method
  async scrapeAllEvents(stateLinks) {
    // Ensure CSV header
    await this.ensureCSVHeader();

    // Load previous progress
    const progress = await this.loadProgress();

    // Create semaphore for controlling state concurrency
    const stateSem = semaphore(this.maxConcurrency);
    const releaseStatePromise = promisify(stateSem.leave.bind(stateSem));

    // Total states for progress tracking
    const totalStates = stateLinks.length;
    let completedStates = 0;

    // Process state links concurrently
    const stateScrapingPromises = stateLinks.map(async (stateLinkObj) => {
      // Acquire state semaphore
      await new Promise(resolve => stateSem.take(resolve));

      try {
        const { link, name } = stateLinkObj;

        // Skip if state is already completed
        if (progress.completedStates.includes(name)) {
          this.onProgress(`Skipping already completed state: ${name}`);
          completedStates++;
          return;
        }

        this.onProgress(`Starting scraping for state: ${name}`);

        // Scrape event links for this state
        const eventLinks = await this.scrapeStateEventLinks(link, name);

        this.onProgress(`Found ${eventLinks.length} events for ${name}`);

        // Create event semaphore for controlling event concurrency
        const eventSem = semaphore(this.maxConcurrency);
        const releaseEventPromise = promisify(eventSem.leave.bind(eventSem));

        // Process event links concurrently
        const eventScrapingPromises = eventLinks.map(async (eventLink) => {
          // Acquire event semaphore
          await new Promise(resolve => eventSem.take(resolve));

          try {
            await this.scrapeEventDetails(eventLink, name);
          } catch (error) {
            this.onProgress(`Error processing event for ${name}: ${error.message}`);
          } finally {
            // Release event semaphore
            await releaseEventPromise();
          }
        });

        // Wait for all events in this state to be processed
        await Promise.all(eventScrapingPromises);

        // Mark state as completed
        progress.completedStates.push(name);
        await this.saveProgress(progress);

        // Update and log progress
        completedStates++;
        this.onProgress(`Completed scraping for state: ${name} (${completedStates}/${totalStates})`);

      } catch (error) {
        this.onProgress(`Error processing state ${stateLinkObj.name}: ${error.message}`);
      } finally {
        // Release state semaphore
        await releaseStatePromise();
      }
    });

    // Wait for all states to be processed
    await Promise.all(stateScrapingPromises);

    this.onProgress('Event scraping completed');
  }
}

module.exports = { ComprehensiveCarEventScraper };