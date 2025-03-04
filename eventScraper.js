const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs').promises;
const path = require('path');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

// Configure Puppeteer with stealth
puppeteer.use(StealthPlugin());

class EventScraper {
  constructor() {
    this.baseUrl = 'https://carcruisefinder.com';
    this.events = [];
  }

  async scrapeRegionEvents(regionUrl) {
    // Normalize the URL
    const fullUrl = regionUrl.startsWith('http') 
      ? regionUrl 
      : `${this.baseUrl}${regionUrl}`;

    let currentPage = 1;
    let hasMorePages = true;
    const allEventLinks = [];

    while (hasMorePages) {
      try {
        // Construct paginated URL
        const pageUrl = currentPage > 1 
          ? `${fullUrl}/page/${currentPage}/`
          : fullUrl;

        console.log(`Scraping ${pageUrl}`);

        // Try axios first
        const response = await this.scrapeWithAxios(pageUrl);

        if (response.eventLinks.length === 0) {
          // If no events found, try Puppeteer
          const puppeteerResponse = await this.scrapeWithPuppeteer(pageUrl);
          
          if (puppeteerResponse.eventLinks.length === 0) {
            // No more events found
            hasMorePages = false;
            break;
          }

          allEventLinks.push(...puppeteerResponse.eventLinks);
        } else {
          allEventLinks.push(...response.eventLinks);
        }

        currentPage++;
      } catch (error) {
        // If we get a 404 or other error indicating no more pages
        if (error.response && error.response.status === 404) {
          hasMorePages = false;
        } else {
          console.error(`Error scraping page ${currentPage}:`, error);
          break;
        }
      }
    }

    return allEventLinks;
  }

  async scrapeWithAxios(url) {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });

    const $ = cheerio.load(response.data);

    const eventLinks = $('h2.tribe-events-list-event-title.entry-title.summary a.url')
      .map((i, el) => $(el).attr('href'))
      .get();

    return { eventLinks };
  }

  async scrapeWithPuppeteer(url) {
    const browser = await puppeteer.launch({
      headless: false,
      defaultViewport: null
    });

    try {
      const page = await browser.newPage();
      await page.goto(url, { 
        waitUntil: 'networkidle0',
        timeout: 60000 
      });

      const eventLinks = await page.evaluate(() => {
        const links = document.querySelectorAll('h2.tribe-events-list-event-title.entry-title.summary a.url');
        return Array.from(links).map(link => link.href);
      });

      return { eventLinks };
    } catch (error) {
      console.error('Puppeteer scraping error:', error);
      return { eventLinks: [] };
    } finally {
      await browser.close();
    }
  }

  async scrapeAllEvents() {
    // Read the states and regions JSON
    const jsonPath = path.join(__dirname, 'states_all_car_shows.json');
    const statesData = JSON.parse(await fs.readFile(jsonPath, 'utf8'));

    // Prepare to store all events
    const allEvents = {};

    // Iterate through states and their regions
    for (const state of statesData) {
      console.log(`Scraping events for ${state.name}`);

      // Use the first (All Car Shows) region
      if (state.regions && state.regions.length > 0) {
        const regionUrl = state.regions[0].url;
        
        try {
          const eventLinks = await this.scrapeRegionEvents(regionUrl);
          
          // Store events for this state
          allEvents[state.name] = {
            stateId: state.id,
            eventLinks: eventLinks
          };

          // Optional: save intermediate results
          await fs.writeFile(
            path.join(__dirname, `${state.name.toLowerCase().replace(/\s+/g, '_')}_events.json`), 
            JSON.stringify(allEvents[state.name], null, 2)
          );

        } catch (error) {
          console.error(`Error scraping events for ${state.name}:`, error);
        }

        // Add a delay between states to be nice to the server
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    // Save complete results
    await fs.writeFile(
      path.join(__dirname, 'all_state_events.json'), 
      JSON.stringify(allEvents, null, 2)
    );

    return allEvents;
  }
}

// Export and run if called directly
module.exports = EventScraper;

if (require.main === module) {
  const scraper = new EventScraper();
  scraper.scrapeAllEvents()
    .then(() => console.log('Event scraping completed'))
    .catch(error => console.error('Error in event scraping:', error));
}