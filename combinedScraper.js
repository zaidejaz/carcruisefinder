const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

// Add stealth plugin to bypass detection
puppeteer.use(StealthPlugin());

class CombinedScraper {
  constructor(options = {}) {
    this.baseUrl = 'https://carcruisefinder.com';
    this.concurrency = options.concurrency || Math.max(1, Math.min(os.cpus().length - 1, 5)); // Default to CPU count - 1, max 5
    this.outputDir = options.outputDir || __dirname;
    this.statesFile = path.join(this.outputDir, 'states_all_car_shows.json');
    this.allEventsFile = path.join(this.outputDir, 'all_events.json');
    this.delay = options.delay || 1000; // Delay between requests in ms
    this.retries = options.retries || 3; // Number of retries for failed requests
    this.useHeadless = options.headless !== false; // Default to headless mode
    
    // Common headers to use for all requests
    this.headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Cache-Control': 'max-age=0',
      'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Windows"',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1',
      'Referer': 'https://carcruisefinder.com/'
    };
  }

  async scrapeStatesAndRegions() {
    console.log('Starting to scrape states and regions...');
    
    const browser = await puppeteer.launch({
      headless: this.useHeadless,
      defaultViewport: null,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    try {
      const page = await browser.newPage();
      
      // Set headers for the page
      await page.setExtraHTTPHeaders(this.headers);
      
      // Set a realistic user agent
      await page.setUserAgent(this.headers['User-Agent']);
      
      // Navigate to the homepage
      await page.goto(this.baseUrl, {
        waitUntil: 'load',
        timeout: 60000
      });

      // Wait for the state dropdown to be available
      await page.waitForSelector('#cat');

      // Extract states
      const states = await page.evaluate(() => {
        const stateSelect = document.getElementById('cat');
        return Array.from(stateSelect.options)
          .filter(option => option.value !== '')
          .map(option => ({
            id: option.value,
            name: option.text
          }));
      });

      const statesWithRegions = [];
      
      // First, click on the state dropdown to "wake it up"
      await page.click('#cat');

      // Iterate through states and get their regions
      for (const state of states) {
        console.log(`Scraping regions for ${state.name}`);

        // Select the state
        await page.select('#cat', state.id);

        // Use mouse click to potentially trigger region loading
        const regionDropdown = await page.$('#region-dropdown');
        if (regionDropdown) {
          await regionDropdown.click();
        }

        // Wait for region dropdown to populate
        await page.evaluate(() => {
          return new Promise((resolve) => {
            const checkRegionDropdown = () => {
              const regionSelect = document.getElementById('region-dropdown');
              if (regionSelect && regionSelect.options.length > 1) {
                resolve();
              } else {
                setTimeout(checkRegionDropdown, 100);
              }
            };
            checkRegionDropdown();
          });
        });

        // Extract ONLY the "All X Car Shows" region
        const regions = await page.evaluate(() => {
          const regionSelect = document.getElementById('region-dropdown');
          return Array.from(regionSelect.options)
            .filter(option => 
              option.text.toLowerCase().includes('all') && 
              option.text.toLowerCase().includes('car shows') &&
              option.value !== ''
            )
            .map(option => ({
              name: option.text,
              url: option.value
            }));
        });

        // Add to results
        statesWithRegions.push({
          ...state,
          regions: regions
        });

        // Small delay between states
        await new Promise(resolve => setTimeout(resolve, this.delay));
      }

      // Save results to JSON file
      await fs.writeFile(this.statesFile, JSON.stringify(statesWithRegions, null, 2));
      console.log(`States and regions saved to ${this.statesFile}`);

      return statesWithRegions;

    } catch (error) {
      console.error('An error occurred during state scraping:', error);
      throw error;
    } finally {
      await browser.close();
    }
  }

  async scrapeWithAxios(url) {
    for (let attempt = 0; attempt < this.retries; attempt++) {
      try {
        // Update the Referer header to match the current URL
        const headers = {
          ...this.headers,
          'Referer': new URL(url).origin
        };
        
        const response = await axios.get(url, {
          headers: headers,
          timeout: 30000,
          maxRedirects: 5,
          validateStatus: status => status >= 200 && status < 300
        });

        const $ = cheerio.load(response.data);

        const eventLinks = $('h2.tribe-events-list-event-title.entry-title.summary a.url')
          .map((i, el) => $(el).attr('href'))
          .get();

        return { eventLinks, success: true };
      } catch (error) {
        console.error(`Axios attempt ${attempt + 1}/${this.retries} failed for ${url}:`, error.message);
        
        if (attempt === this.retries - 1) {
          return { eventLinks: [], success: false };
        }
        
        // Wait before retrying
        await new Promise(resolve => setTimeout(resolve, this.delay * (attempt + 1)));
      }
    }
    
    return { eventLinks: [], success: false };
  }

  async scrapeWithPuppeteer(url) {
    const browser = await puppeteer.launch({
      headless: this.useHeadless,
      defaultViewport: null,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    try {
      const page = await browser.newPage();
      
      // Set headers for the page
      await page.setExtraHTTPHeaders(this.headers);
      
      // Set a realistic user agent
      await page.setUserAgent(this.headers['User-Agent']);
      
      // Set cookies if needed
      // await page.setCookie(...cookies);
      
      // Enable JavaScript
      await page.setJavaScriptEnabled(true);
      
      // Navigate to the URL
      await page.goto(url, { 
        waitUntil: 'networkidle0',
        timeout: 60000 
      });

      // Wait for the content to load
      await page.waitForSelector('h2.tribe-events-list-event-title.entry-title.summary a.url', { timeout: 10000 })
        .catch(() => console.log('Selector not found, but continuing...'));

      const eventLinks = await page.evaluate(() => {
        const links = document.querySelectorAll('h2.tribe-events-list-event-title.entry-title.summary a.url');
        return Array.from(links).map(link => link.href);
      });

      return { eventLinks, success: true };
    } catch (error) {
      console.error('Puppeteer scraping error:', error.message);
      return { eventLinks: [], success: false };
    } finally {
      await browser.close();
    }
  }

  async scrapeRegionEvents(regionUrl, stateName) {
    // Normalize the URL
    const fullUrl = regionUrl.startsWith('http') 
      ? regionUrl 
      : `${this.baseUrl}${regionUrl}`;

    let currentPage = 1;
    let hasMorePages = true;
    const allEventLinks = [];
    let consecutiveEmptyPages = 0;

    while (hasMorePages) {
      try {
        // Construct paginated URL
        const pageUrl = currentPage > 1 
          ? `${fullUrl}/page/${currentPage}/`
          : fullUrl;

        console.log(`Scraping ${stateName} - ${pageUrl}`);

        // Try axios first
        const response = await this.scrapeWithAxios(pageUrl);

        if (!response.success || response.eventLinks.length === 0) {
          // If no events found or axios failed, try Puppeteer
          console.log(`Falling back to Puppeteer for ${pageUrl}`);
          const puppeteerResponse = await this.scrapeWithPuppeteer(pageUrl);
          
          if (!puppeteerResponse.success || puppeteerResponse.eventLinks.length === 0) {
            // No more events found
            console.log(`No events found on page ${currentPage} for ${stateName}`);
            consecutiveEmptyPages++;
            
            if (consecutiveEmptyPages >= 2) {
              console.log(`${consecutiveEmptyPages} consecutive empty pages, stopping pagination for ${stateName}`);
              hasMorePages = false;
              break;
            }
          } else {
            consecutiveEmptyPages = 0;
            allEventLinks.push(...puppeteerResponse.eventLinks);
          }
        } else {
          consecutiveEmptyPages = 0;
          allEventLinks.push(...response.eventLinks);
        }

        currentPage++;
        
        // Add a small delay between page requests
        await new Promise(resolve => setTimeout(resolve, this.delay));
      } catch (error) {
        console.error(`Error scraping page ${currentPage} for ${stateName}:`, error.message);
        
        // If we've tried multiple pages with errors, assume we're done
        if (currentPage > 3) {
          hasMorePages = false;
        }
        break;
      }
    }

    // Remove duplicate links
    const uniqueEventLinks = [...new Set(allEventLinks)];
    console.log(`Found ${uniqueEventLinks.length} unique events for ${stateName}`);
    return uniqueEventLinks;
  }

  async processStatesConcurrently(states) {
    const allEvents = {};
    const queue = [...states];
    const activePromises = new Map();
    
    console.log(`Starting concurrent scraping with ${this.concurrency} workers`);
    
    while (queue.length > 0 || activePromises.size > 0) {
      // Fill up to concurrency limit
      while (activePromises.size < this.concurrency && queue.length > 0) {
        const state = queue.shift();
        console.log(`Starting worker for ${state.name}`);
        
        const promise = (async () => {
          if (state.regions && state.regions.length > 0) {
            const regionUrl = state.regions[0].url;
            
            try {
              const eventLinks = await this.scrapeRegionEvents(regionUrl, state.name);
              
              // Store events for this state
              allEvents[state.name] = {
                stateId: state.id,
                eventLinks: eventLinks
              };

              // Save intermediate results
              const stateFileName = state.name.toLowerCase().replace(/\s+/g, '_') + '_events.json';
              await fs.writeFile(
                path.join(this.outputDir, stateFileName), 
                JSON.stringify(allEvents[state.name], null, 2)
              );
              
              console.log(`Completed scraping for ${state.name} - found ${eventLinks.length} events`);
            } catch (error) {
              console.error(`Error scraping events for ${state.name}:`, error.message);
            }
          }
          return state.name;
        })();
        
        activePromises.set(state.name, promise);
      }
      
      // Wait for any promise to complete
      if (activePromises.size > 0) {
        const nextCompletedName = await Promise.race(
          Array.from(activePromises.entries()).map(async ([name, promise]) => {
            await promise;
            return name;
          })
        );
        
        activePromises.delete(nextCompletedName);
        console.log(`Worker for ${nextCompletedName} completed, ${activePromises.size} workers still active`);
      }
    }
    
    // Save complete results
    await fs.writeFile(this.allEventsFile, JSON.stringify(allEvents, null, 2));
    console.log(`All events saved to ${this.allEventsFile}`);
    
    return allEvents;
  }

  async run() {
    console.log('Starting combined scraper...');
    
    let states;
    
    try {
      // Check if states file exists
      await fs.access(this.statesFile);
      console.log(`States file found at ${this.statesFile}, loading...`);
      states = JSON.parse(await fs.readFile(this.statesFile, 'utf8'));
    } catch (error) {
      console.log('States file not found or invalid, scraping states and regions...');
      states = await this.scrapeStatesAndRegions();
    }
    
    console.log(`Found ${states.length} states to process`);
    
    // Process all states concurrently
    const allEvents = await this.processStatesConcurrently(states);
    
    console.log('Scraping completed successfully!');
    return allEvents;
  }
}

// Export the class
module.exports = CombinedScraper;

// If run directly, execute the scraping
if (require.main === module) {
  const scraper = new CombinedScraper({
    concurrency: 3,  // Adjust based on your system capabilities
    headless: false, // Set to true for production
    delay: 1000,     // 1 second delay between requests
    retries: 3       // Number of retries for failed requests
  });
  
  scraper.run()
    .then(() => console.log('Combined scraping completed'))
    .catch(error => console.error('Error in combined scraping:', error));
} 